import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadSecrets, saveSecrets } from "../src/secrets.js";

test(
  "round-trips local secrets through Windows DPAPI",
  { skip: process.platform !== "win32" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "person-agent-secrets-test-"));
    const paths = {
      root,
      config: join(root, "config.json"),
      database: join(root, "agent.db"),
      secrets: join(root, "secrets.dpapi"),
      log: join(root, "worker.log"),
    };
    try {
      await saveSecrets(paths, { deepseekApiKey: "test-key" });
      assert.deepEqual(await loadSecrets(paths), { deepseekApiKey: "test-key" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
