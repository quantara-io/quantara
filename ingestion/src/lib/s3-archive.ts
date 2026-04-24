import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({});

const BUCKET = process.env.DATA_ARCHIVE_BUCKET ?? `quantara-dev-data-archive`;

export async function archiveCandles(
  exchange: string,
  pair: string,
  date: string,
  data: unknown[]
): Promise<void> {
  const safePair = pair.replace("/", "-");
  const key = `candles/${exchange}/${safePair}/${date}.json`;

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: JSON.stringify(data),
      ContentType: "application/json",
    })
  );

  console.log(`[S3Archive] Uploaded ${data.length} records to s3://${BUCKET}/${key}`);
}
