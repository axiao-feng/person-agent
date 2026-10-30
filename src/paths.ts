import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type AppPaths = ReturnType<typeof appPaths>;

export function appPaths(environment: NodeJS.ProcessEnv = process.env) {
  const root =
    environment.PERSON_AGENT_HOME ||
    join(environment.LOCALAPPDATA || environment.APPDATA || process.cwd(), "person-agent");
  return {
    root,
    config: join(root, "config.json"),
    database: join(root, "agent.db"),
    secrets: join(root, "secrets.dpapi"),
    log: join(root, "worker.log"),
  };
}

export function ensureAppDirectory(paths: AppPaths): void {
  mkdirSync(paths.root, { recursive: true });
}
