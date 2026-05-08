# Whale Monitoring — Implementation Plan

## Overview

Self-hosted whale wallet monitoring using free Alchemy WebSocket to detect large crypto transactions in real-time. Runs inside the existing Fargate ingestion service as a `WhaleMonitor` class alongside `MarketStreamManager` and `NewsPoller`.

## Architecture

```
Alchemy WebSocket (ETH/Polygon)
        │
        ▼
  WhaleMonitor (Fargate)
   - filter by value threshold
   - match against whale watchlist
   - classify: exchange deposit/withdrawal/transfer
   - detect correlated wallet behavior
        │
        ├──▶ DynamoDB (whale_events table)
        └──▶ SQS (whale-events queue) ──▶ Genie Signal Engine
```

## Data Sources (all free)

| Source                  | What                                | Cost                        | Transport    |
| ----------------------- | ----------------------------------- | --------------------------- | ------------ |
| **Alchemy**             | ETH + Polygon pending/confirmed txs | Free (30M compute units/mo) | WebSocket    |
| **Etherscan API**       | Wallet tx history, token transfers  | Free (5 req/sec)            | REST polling |
| **Public wallet lists** | Known exchange/fund addresses       | Free                        | Static JSON  |

## Whale Watchlist

Curated list of ~500 known wallet addresses, stored in `ingestion/src/whale/watchlist.json`:

```json
{
  "exchanges": {
    "binance": ["0x28C6c06298d514Db089934071355E5743bf21d60", "..."],
    "coinbase": ["0x71660c4005BA85c37ccec55d0C4493E66Fe775d3", "..."],
    "kraken": ["0x267be1C1D684F78cb4F6a176C4911b741E4Ffdc0", "..."]
  },
  "funds": {
    "jump_trading": ["0x..."],
    "wintermute": ["0x..."],
    "galaxy_digital": ["0x..."]
  },
  "whales": {
    "whale_001": ["0x..."]
  }
}
```

Sources for addresses: Etherscan labels, Arkham (public), Dune dashboards, on-chain sleuthing communities.

## Signal Types

| Signal                        | Pattern                                | Direction              | Confidence |
| ----------------------------- | -------------------------------------- | ---------------------- | ---------- |
| **Exchange Deposit**          | Whale → exchange hot wallet            | Bearish (selling)      | High       |
| **Exchange Withdrawal**       | Exchange → cold wallet                 | Bullish (accumulating) | High       |
| **Stablecoin to Exchange**    | Large USDT/USDC → exchange             | Bullish (buying prep)  | Medium     |
| **Large Transfer**            | Unknown wallet → unknown wallet        | Neutral (watch)        | Low        |
| **Correlated Moves**          | Multiple whales same direction in <1hr | Strong directional     | Very High  |
| **Dormant Wallet Activation** | Wallet inactive >6mo suddenly moves    | Alert                  | Medium     |

## Thresholds

| Asset             | Minimum tx value to track |
| ----------------- | ------------------------- |
| ETH               | 100 ETH (~$230K)          |
| BTC (via wrapped) | 5 WBTC (~$380K)           |
| USDT/USDC         | $500,000                  |
| Other ERC-20      | $250,000                  |

Configurable via environment variable `WHALE_MIN_VALUE_USD`.

## DynamoDB Table: `whale_events`

```
PK: chain#txHash (S)     — e.g., "eth#0xabc123..."
SK: timestamp (S)         — ISO 8601

Attributes:
  chain: "eth" | "polygon" | "bsc"
  txHash: string
  from: string (address)
  to: string (address)
  fromLabel: string | null (e.g., "binance", "jump_trading")
  toLabel: string | null
  value: number (native token amount)
  valueUsd: number
  token: string (e.g., "ETH", "USDT", "WBTC")
  signalType: "exchange_deposit" | "exchange_withdrawal" | "stablecoin_inflow" | "large_transfer" | "dormant_activation"
  direction: "bullish" | "bearish" | "neutral"
  confidence: number (0-1)
  ttl: number (90 days)

GSI: wallet-index
  PK: walletAddress (S)
  SK: timestamp (S)
```

## TypeScript Files

All in `ingestion/src/whale/`:

| File             | Purpose                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `monitor.ts`     | `WhaleMonitor` class — Alchemy WebSocket connection, tx filtering, signal classification |
| `watchlist.ts`   | Load and match addresses against known wallets                                           |
| `watchlist.json` | Curated address database                                                                 |
| `classifier.ts`  | Classify tx into signal types (deposit/withdrawal/transfer/dormant)                      |
| `whale-store.ts` | DynamoDB write for whale_events table                                                    |
| `types.ts`       | WhaleEvent, WhaleSignal, WatchlistEntry types                                            |

## Integration into Fargate Service

```typescript
// service.ts
import { WhaleMonitor } from "./whale/monitor.js";

const whaleMonitor = new WhaleMonitor();

// Start alongside market and news
await marketStream.start();
newsPoller.start();
whaleMonitor.start(); // connects Alchemy WebSocket

// Health check includes whale status
startHealthServer(HEALTH_PORT, {
  getStatus: () => ({
    ...marketStream.getStatus(),
    news: newsPoller.getStatus(),
    whale: whaleMonitor.getStatus(),
  }),
});
```

## Terraform Additions

```hcl
# DynamoDB table
resource "aws_dynamodb_table" "whale_events" { ... }

# SQS queue + DLQ
resource "aws_sqs_queue" "whale_events" { ... }
resource "aws_sqs_queue" "whale_events_dlq" { ... }

# IAM: Fargate task role gets whale_events DynamoDB + SQS access
# Environment: ALCHEMY_API_KEY, WHALE_MIN_VALUE_USD
```

## Alchemy WebSocket Setup

```typescript
import { Alchemy, Network, AlchemySubscription } from "alchemy-sdk";

const alchemy = new Alchemy({
  apiKey: process.env.ALCHEMY_API_KEY,
  network: Network.ETH_MAINNET,
});

// Subscribe to pending transactions involving watched addresses
alchemy.ws.on(
  { method: AlchemySubscription.PENDING_TRANSACTIONS, toAddress: EXCHANGE_ADDRESSES },
  (tx) => processWhaleTransaction(tx),
);

// Also subscribe to confirmed transactions for large values
alchemy.ws.on(
  { method: AlchemySubscription.MINED_TRANSACTIONS, addresses: WHALE_ADDRESSES },
  (tx) => processWhaleTransaction(tx),
);
```

## How Genie Combines All 3 Signal Layers

```
Market Data:     BTC price dropping 2% in 1hr, high volume
News Sentiment:  "SEC investigating major exchange" — bearish, 0.85 confidence
Whale Activity:  3 whale wallets deposited 500 BTC to exchanges in last 30 min

Combined Signal: SELL — 92% confidence
Reasoning: "Price decline accelerating with bearish regulatory news.
            Whale exchange deposits suggest institutional selling pressure.
            Multiple correlated whale moves increase conviction."
```

## Phase / Priority

**Not blocking MVP.** This is a high-value addition that makes Genie signals significantly better, but the core signal engine works without it (market data + news sentiment alone). Build after the Genie signal engine is functional.

## Estimated Effort

- Basic version (threshold-based alerts, no wallet labeling): 2-3 days
- With watchlist + classification: 4-5 days
- Full version with correlated move detection: 7-8 days

## Cost

$0/month — Alchemy free tier + Etherscan free tier + static watchlist.

## Future Upgrades

- Add Whale Alert API ($30/mo) for cross-chain coverage + entity labeling
- Add Solana whale tracking via Helius or QuickNode
- Add Bitcoin whale tracking via Blockchain.com WebSocket
- Train ML model on whale patterns → price impact correlation
- Add CryptoQuant Exchange Whale Ratio as macro signal
