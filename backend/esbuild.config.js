import { build } from "esbuild";

await build({
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: true,
  minify: true,
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  banner: {
    js: 'import { createRequire } from "module"; const require = createRequire(import.meta.url);',
  },
  external: [
    "@aws-sdk/client-dynamodb",
    "@aws-sdk/lib-dynamodb",
    "@aws-sdk/client-bedrock-runtime",
  ],
});

console.log("Build complete: dist/index.js");
