/**
 * close-quorum-monitor Lambda — Phase P2 (v6 design §11.5).
 *
 * Triggered by DDB Streams REMOVE events on `quantara-{env}-close-quorum`
 * (i.e. TTL expiry events). FilterCriteria: { eventName = "REMOVE" }.
 *
 * For each REMOVE record:
 *   1. Read OldImage: extract pair, timeframe, closeTime from the id field
 *      (format: "pair#timeframe#closeTime").
 *   2. Look up signals-v2 with the deterministic key (PK=pair, SK=tf#closeTime).
 *   3. If absent: emit CloseMissed CloudWatch metric via Embedded Metric Format
 *      (EMF — structured JSON to stdout; no SDK dependency required) and log.
 *   4. If present: no-op (signal was written successfully before TTL expiry).
 *
 * Metric emission uses the Lambda Embedded Metric Format (EMF) so that no
 * additional AWS SDK package is required. CloudWatch Logs ingests the
 * structured JSON and converts it into a metric automatically.
 *
 * Metric: Namespace=Quantara/Ingestion, MetricName=CloseMissed,
 *         Dimensions=[pair, timeframe], Unit=Count, Value=1.
 */

import type { DynamoDBStreamEvent, DynamoDBStreamHandler } from "aws-lambda";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const SIGNALS_V2_TABLE =
  process.env.TABLE_SIGNALS_V2 ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}signals-v2`;

const CW_NAMESPACE = process.env.CW_NAMESPACE ?? "Quantara/Ingestion";

// Must match REQUIRED_EXCHANGE_COUNT in indicator-handler.ts. A close-quorum row
// expiring with fewer exchanges than this means quorum was never reached and the
// indicator handler correctly returned early — not a missed close.
const REQUIRED_EXCHANGE_COUNT = Number(process.env["REQUIRED_EXCHANGE_COUNT"] ?? "2");

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler: DynamoDBStreamHandler = async (event: DynamoDBStreamEvent) => {
  for (const record of event.Records) {
    // We only care about REMOVE events (TTL expiry from close-quorum table).
    if (record.eventName !== "REMOVE") continue;
    if (!record.dynamodb?.OldImage) continue;

    const oldImage = unmarshall(record.dynamodb.OldImage as Record<string, AttributeValue>) as {
      id?: string;
      exchanges?: Set<string> | string[];
    };

    const id = oldImage.id;
    if (!id) {
      console.warn("[CloseQuorumMonitor] REMOVE record missing id field — skipping.");
      continue;
    }

    // If quorum was never reached on this row, the indicator handler correctly
    // returned early without writing a signal. The TTL expiry is normal, not a
    // missed close — skip the lookup and metric emission to avoid false alarms.
    const exchanges = oldImage.exchanges;
    const exchangeCount =
      exchanges instanceof Set ? exchanges.size : Array.isArray(exchanges) ? exchanges.length : 0;
    if (exchangeCount < REQUIRED_EXCHANGE_COUNT) {
      console.log(
        `[CloseQuorumMonitor] ${id}: only ${exchangeCount}/${REQUIRED_EXCHANGE_COUNT} exchanges at TTL expiry — quorum never reached, not a missed close.`,
      );
      continue;
    }

    // id format: "pair#timeframe#closeTime"
    // pair may contain "/" which doesn't appear in timeframe or closeTime,
    // so split from the right to handle pairs like "BTC/USDT".
    const parts = id.split("#");
    if (parts.length < 3) {
      console.warn(`[CloseQuorumMonitor] Unexpected id format: ${id} — skipping.`);
      continue;
    }

    const closeTimeStr = parts[parts.length - 1]!;
    const timeframe = parts[parts.length - 2]!;
    const pair = parts.slice(0, parts.length - 2).join("#");

    const sk = `${timeframe}#${closeTimeStr}`;

    try {
      const result = await ddbClient.send(
        new GetCommand({
          TableName: SIGNALS_V2_TABLE,
          Key: { pair, sk },
          // Only need to know if the item exists.
          ProjectionExpression: "pair",
        }),
      );

      if (result.Item) {
        // Signal was written — quorum resolved correctly.
        console.log(`[CloseQuorumMonitor] ${id}: signal present in signals-v2 — OK.`);
        continue;
      }

      // Signal is absent — quorum was reached but indicator handler never wrote.
      console.warn(
        `[CloseQuorumMonitor] CloseMissed: ${id} — quorum expired but no signal in signals-v2.`,
      );

      emitCloseMissedMetricEmf(pair, timeframe);
    } catch (err) {
      console.error(
        `[CloseQuorumMonitor] Error checking signals-v2 for ${id}: ${(err as Error).message}`,
      );
      // Don't re-throw — metric emission is best-effort; Lambda should not retry
      // on monitor errors (this Lambda is observability-only, not load-bearing).
    }
  }
};

// ---------------------------------------------------------------------------
// CloudWatch Embedded Metric Format (EMF) emission
//
// Writing a specially-structured JSON object to stdout causes CloudWatch Logs
// to extract the metric automatically — no @aws-sdk/client-cloudwatch needed.
// See: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
// ---------------------------------------------------------------------------

function emitCloseMissedMetricEmf(pair: string, timeframe: string): void {
  const emf = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: CW_NAMESPACE,
          Dimensions: [["pair", "timeframe"]],
          Metrics: [{ Name: "CloseMissed", Unit: "Count" }],
        },
      ],
    },
    pair,
    timeframe,
    CloseMissed: 1,
  };

  // EMF must be written as a single JSON line to stdout.
  process.stdout.write(JSON.stringify(emf) + "\n");

  console.log(
    `[CloseQuorumMonitor] Emitted CloseMissed EMF metric for pair=${pair} timeframe=${timeframe}`,
  );
}
