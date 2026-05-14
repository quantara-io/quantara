import ccxt from "ccxt";

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ex = new (ccxt as any).kraken({ enableRateLimit: true });
  await ex.loadMarkets();
  const candidates = ["XBT/USDT", "BTC/USDT", "XBT/USD", "BTC/USD", "XBT/USDC",
                      "XDG/USDT", "DOGE/USDT", "XDG/USD", "DOGE/USD"];
  for (const s of candidates) {
    const m = ex.markets[s];
    console.log(`  ${s}: ${m ? "EXISTS" : "(not listed)"}`);
  }
}
main().catch((e) => console.error(e));
