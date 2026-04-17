import { Hono } from "hono";
import { requireAuth } from "../middleware/require-auth.js";

const dealflow = new Hono();

dealflow.use("*", requireAuth);

dealflow.get("/deals", (c) => {
  return c.json({ success: true, data: { deals: [], meta: { page: 1, pageSize: 20, total: 0, hasMore: false } } });
});

dealflow.post("/deals", (c) => {
  return c.json({ success: true, data: { dealId: null } }, 501);
});

dealflow.get("/deals/:id", (c) => {
  return c.json({ success: true, data: { deal: null } });
});

dealflow.post("/deals/:id/interest", (c) => {
  return c.json({ success: true }, 501);
});

dealflow.get("/profile", (c) => {
  return c.json({ success: true, data: { profile: null } });
});

dealflow.put("/profile", (c) => {
  return c.json({ success: true }, 501);
});

export { dealflow };
