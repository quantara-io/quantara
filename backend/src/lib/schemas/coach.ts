import { z } from "@hono/zod-openapi";

export const CoachSession = z.object({
  sessionId: z.string(),
  userId: z.string(),
  summary: z.string().nullable(),
  topicTags: z.array(z.string()),
  messageCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).openapi("CoachSession");

export const CoachMessage = z.object({
  messageId: z.string(),
  sessionId: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: z.string(),
}).openapi("CoachMessage");

export const SessionsListResponse = z.object({
  success: z.literal(true),
  data: z.object({ sessions: z.array(CoachSession) }),
}).openapi("SessionsListResponse");

export const CreateSessionRequest = z.object({
  message: z.string().describe("Initial message to start the session"),
}).openapi("CreateSessionRequest");

export const SessionDetailResponse = z.object({
  success: z.literal(true),
  data: z.object({ session: CoachSession.nullable() }),
}).openapi("SessionDetailResponse");

export const SendMessageRequest = z.object({
  content: z.string().describe("User message"),
}).openapi("SendMessageRequest");

export const MessageResponse = z.object({
  success: z.literal(true),
  data: z.object({ message: CoachMessage.nullable() }),
}).openapi("MessageResponse");
