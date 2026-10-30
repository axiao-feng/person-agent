import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

/** Reads the package version without relying on the current working directory. */
export function packageVersion(): string {
  if (cached) return cached;
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, "package.json");
    if (existsSync(candidate)) {
      try {
        const value = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
        if (typeof value.version === "string" && value.version.trim()) {
          cached = value.version.trim();
          return cached;
        }
      } catch {
        // Keep walking upward; a broken package.json should not stop the service.
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  cached = "0.0.0";
  return cached;
}
