import { Hono } from "hono";

// esbuild bundles .html files as text via the loader configured in
// esbuild.config.js, so the HTML lands in the Lambda zip as a string —
// no filesystem read at runtime.
import authDocsHtml from "./auth-docs.html";

const authDocs = new Hono();

authDocs.get("/", (c) => c.html(authDocsHtml));

export { authDocs };
