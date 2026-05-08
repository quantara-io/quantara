import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

import type { CryptoPanicResponse, CryptoPanicPost } from "./types.js";

const ssm = new SSMClient({});
const ENVIRONMENT = process.env.ENVIRONMENT ?? "dev";
const PARAM_NAME = `/quantara/${ENVIRONMENT}/cryptopanic-api-key`;

let cachedApiKey: string | null = null;

async function getApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;

  // Allow override via env var for local dev
  if (process.env.CRYPTOPANIC_API_KEY) {
    cachedApiKey = process.env.CRYPTOPANIC_API_KEY;
    return cachedApiKey;
  }

  const result = await ssm.send(
    new GetParameterCommand({
      Name: PARAM_NAME,
      WithDecryption: true,
    }),
  );

  cachedApiKey = result.Parameter?.Value ?? "";
  if (!cachedApiKey) {
    throw new Error(`SSM parameter ${PARAM_NAME} is empty`);
  }
  return cachedApiKey;
}

const BASE_URL = "https://cryptopanic.com/api/free/v1";

export async function fetchNews(cursor?: string): Promise<{
  posts: CryptoPanicPost[];
  nextCursor: string | null;
}> {
  const apiKey = await getApiKey();

  let url = `${BASE_URL}/posts/?auth_token=${apiKey}&kind=news&public=true`;
  if (cursor) {
    url += `&page=${cursor}`;
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`CryptoPanic API error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as CryptoPanicResponse;

  // Extract page number from next URL for cursor tracking
  let nextCursor: string | null = null;
  if (data.next) {
    const nextUrl = new URL(data.next);
    nextCursor = nextUrl.searchParams.get("page");
  }

  return { posts: data.results, nextCursor };
}

export function computeSentiment(post: CryptoPanicPost): string {
  const { positive, negative } = post.votes;
  if (positive > negative * 2) return "bullish";
  if (negative > positive * 2) return "bearish";
  return "neutral";
}
