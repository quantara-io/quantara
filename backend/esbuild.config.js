import { build } from "esbuild";

await build({
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  sourcemap: true,
  minify: true,
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  external: [
    "@aws-sdk/client-dynamodb",
    "@aws-sdk/lib-dynamodb",
    "@aws-sdk/client-bedrock-runtime",
  ],
});

console.log("Build complete: dist/index.js");
