import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: {
    service: "quantara-backend",
    env: process.env.ENVIRONMENT ?? "dev",
  },
  // CloudWatch Logs renders ISO timestamps better than the epoch-ms default.
  timestamp: pino.stdTimeFunctions.isoTime,
});
