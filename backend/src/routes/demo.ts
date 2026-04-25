import { Hono } from "hono";
// esbuild bundles .html files as text via the loader configured in
// esbuild.config.js, so the HTML lands in the Lambda zip as a string —
// no filesystem read at runtime.
import demoHtml from "./demo.html";

const demo = new Hono();

demo.get("/", (c) => c.html(demoHtml));

export { demo };
