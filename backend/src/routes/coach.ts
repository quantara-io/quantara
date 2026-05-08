import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";

import { requireAuth } from "../middleware/require-auth.js";
import {
  SessionsListResponse,
  CreateSessionRequest,
  SessionDetailResponse,
  SendMessageRequest,
  MessageResponse,
} from "../lib/schemas/coach.js";

const coach = new OpenAPIHono();
coach.use("*", requireAuth);

const sessionsListRoute = createRoute({
  method: "get",
  path: "/sessions",
  tags: ["Coach"],
  summary: "List coach sessions",
  security: [{ Bearer: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: SessionsListResponse } },
      description: "Sessions",
    },
  },
});
coach.openapi(sessionsListRoute, (c) => c.json({ success: true as const, data: { sessions: [] } }));

const createSessionRoute = createRoute({
  method: "post",
  path: "/sessions",
  tags: ["Coach"],
  summary: "Create a new coach session",
  security: [{ Bearer: [] }],
  request: { body: { content: { "application/json": { schema: CreateSessionRequest } } } },
  responses: {
    201: {
      content: { "application/json": { schema: SessionDetailResponse } },
      description: "Session created",
    },
  },
});
coach.openapi(createSessionRoute, (c) =>
  c.json({ success: true as const, data: { session: null } }),
);

const getSessionRoute = createRoute({
  method: "get",
  path: "/sessions/:id",
  tags: ["Coach"],
  summary: "Get session details",
  security: [{ Bearer: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      content: { "application/json": { schema: SessionDetailResponse } },
      description: "Session",
    },
  },
});
coach.openapi(getSessionRoute, (c) => c.json({ success: true as const, data: { session: null } }));

const sendMessageRoute = createRoute({
  method: "post",
  path: "/sessions/:id/messages",
  tags: ["Coach"],
  summary: "Send message to coach",
  security: [{ Bearer: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: SendMessageRequest } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: MessageResponse } },
      description: "Coach response",
    },
  },
});
coach.openapi(sendMessageRoute, (c) => c.json({ success: true as const, data: { message: null } }));

export { coach };
