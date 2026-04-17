import { Hono } from "hono";
import { requireAuth } from "../middleware/require-auth.js";

const coach = new Hono();

coach.use("*", requireAuth);

coach.get("/sessions", (c) => {
  return c.json({ success: true, data: { sessions: [] } });
});

coach.post("/sessions", (c) => {
  return c.json({ success: true, data: { sessionId: null, message: "Coach sessions coming soon." } }, 501);
});

coach.get("/sessions/:id", (c) => {
  return c.json({ success: true, data: { session: null } });
});

coach.post("/sessions/:id/messages", (c) => {
  return c.json({ success: true, data: { message: null } }, 501);
});

export { coach };
