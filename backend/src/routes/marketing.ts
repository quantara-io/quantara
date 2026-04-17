import { Hono } from "hono";
import { requireAuth } from "../middleware/require-auth.js";

const marketing = new Hono();

marketing.use("*", requireAuth);

marketing.get("/campaigns", (c) => {
  return c.json({ success: true, data: { campaigns: [] } });
});

marketing.post("/campaigns/phone", (c) => {
  return c.json({ success: true, data: { campaignId: null } }, 501);
});

marketing.post("/campaigns/email", (c) => {
  return c.json({ success: true, data: { campaignId: null } }, 501);
});

marketing.get("/campaigns/:id", (c) => {
  return c.json({ success: true, data: { campaign: null } });
});

marketing.post("/campaigns/:id/pause", (c) => {
  return c.json({ success: true }, 501);
});

marketing.get("/analytics", (c) => {
  return c.json({ success: true, data: { analytics: null } });
});

export { marketing };
