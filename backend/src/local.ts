import { serve } from "@hono/node-server";
import app from "./index.js";

const PORT = parseInt(process.env.PORT ?? "3001", 10);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Quantara API running at http://localhost:${info.port}`);
  console.log("Routes: /health, /api/genie, /api/coach, /api/dealflow, /api/marketing");
});
