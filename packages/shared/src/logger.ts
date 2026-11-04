import { pino, type Logger, type LoggerOptions } from "pino";

export type { Logger } from "pino";

/**
 * Creates the JSON logger used by every service. Output goes to stdout so Alloy can ship it to
 * Loki; the `service` field lets dashboards filter by component.
 */
export function createLogger(service: string, level = process.env["LOG_LEVEL"] ?? "info"): Logger {
  const options: LoggerOptions = {
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  };
  return pino(options);
}
