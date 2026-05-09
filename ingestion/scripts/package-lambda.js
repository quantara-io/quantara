/**
 * Package Lambda functions with their node_modules dependencies.
 * CCXT is too large to bundle via esbuild (protobufjs issues),
 * so we externalize it and include it in the zip via node_modules.
 */
import { execSync } from "child_process";
import { mkdirSync, rmSync, cpSync, copyFileSync } from "fs";
import { join } from "path";

const DIST = "dist";
const STAGING = join(DIST, ".staging");
const LAMBDAS = [
  { entry: "index.js", zip: "ingestion.zip" },
  { entry: "backfill-handler.js", zip: "backfill.zip" },
  { entry: "news-backfill-handler.js", zip: "news-backfill.zip" },
  { entry: "enrichment-handler.js", zip: "enrichment.zip" },
  { entry: "indicator-handler.js", zip: "indicator-handler.zip" },
  { entry: "aggregator-handler.js", zip: "aggregator-handler.zip" },
  // WebSocket push channel (design v6, §16)
  { entry: "ws-connect-handler.js", zip: "ws-connect-handler.zip" },
  { entry: "ws-disconnect-handler.js", zip: "ws-disconnect-handler.zip" },
  { entry: "signals-fanout.js", zip: "signals-fanout.zip" },
];

// Install production-only ccxt into a clean directory
rmSync(STAGING, { recursive: true, force: true });
mkdirSync(join(STAGING, "node_modules"), { recursive: true });

console.log("Installing ccxt for Lambda packaging...");
execSync("npm install --omit=dev ccxt@^4.4.0 --prefix .", {
  cwd: STAGING,
  stdio: "pipe",
});

for (const { entry, zip } of LAMBDAS) {
  const lambdaDir = join(STAGING, entry.replace(".js", ""));
  rmSync(lambdaDir, { recursive: true, force: true });
  mkdirSync(lambdaDir, { recursive: true });

  // Copy the built JS file
  copyFileSync(join(DIST, entry), join(lambdaDir, entry));

  // Copy node_modules
  cpSync(join(STAGING, "node_modules"), join(lambdaDir, "node_modules"), { recursive: true });

  // Create zip
  execSync(`cd "${lambdaDir}" && zip -qr "../../${zip}" .`);
  console.log(`Packaged: dist/${zip}`);
}

// Cleanup staging
rmSync(STAGING, { recursive: true, force: true });
console.log("Lambda packaging complete.");
