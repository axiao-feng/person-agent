import { appendFileSync, existsSync, statSync, truncateSync } from "node:fs";

import { ensureAppDirectory, type AppPaths } from "./paths.js";

export type Logger = (event: string, details?: Record<string, unknown>) => void;

export function createLogger(paths: AppPaths): Logger {
  ensureAppDirectory(paths);
  return (event, details = {}) => {
    rotateIfNeeded(paths.log);
    const entry = JSON.stringify({
      time: new Date().toISOString(),
      event,
      details: redact(details),
    });
    appendFileSync(paths.log, `${entry}\n`, "utf8");
  };
}

function rotateIfNeeded(path: string): void {
  if (!existsSync(path) || statSync(path).size < 1_000_000) return;
  truncateSync(path, 0);
}

function redact(value: unknown, key = ""): unknown {
  if (/token|secret|password|api.?key|authorization/i.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        redact(entryValue, entryKey),
      ]),
    );
  }
  return typeof value === "string" && value.length > 1_000 ? `${value.slice(0, 1_000)}…` : value;
}
