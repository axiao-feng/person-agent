import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_CONFIG,
  DEFAULT_KNOWLEDGE_VAULT_PATH,
  loadConfig,
  saveConfig,
} from "../src/config.js";

test("knowledge configuration defaults are stable and old config files remain valid", () => {
  assert.equal(
    DEFAULT_KNOWLEDGE_VAULT_PATH,
    join(homedir(), "Documents", "Person Agent Knowledge"),
  );
  assert.equal(DEFAULT_CONFIG.knowledgeDigestTime, "22:30");
  assert.equal(DEFAULT_CONFIG.knowledgeVaultPath, DEFAULT_KNOWLEDGE_VAULT_PATH);

  const root = mkdtempSync(join(tmpdir(), "person-agent-config-test-"));
  const paths = {
    root,
    config: join(root, "config.json"),
    database: join(root, "agent.db"),
    secrets: join(root, "secrets.dpapi"),
    log: join(root, "worker.log"),
  };
  try {
    writeFileSync(
      paths.config,
      JSON.stringify({
        timezone: "Asia/Shanghai",
        briefingTime: "07:30",
        thinkingLevel: "low",
        location: {
          city: "厦门市翔安区",
          latitude: 24.619696,
          longitude: 118.247779,
          timezone: "Asia/Shanghai",
        },
      }),
      "utf8",
    );
    const loaded = loadConfig(paths);
    assert.equal(loaded.knowledgeVaultPath, DEFAULT_CONFIG.knowledgeVaultPath);
    assert.equal(loaded.knowledgeDigestTime, "22:30");
    assert.equal(loaded.location?.city, "厦门市翔安区");

    const custom = { ...loaded, knowledgeVaultPath: join(root, "vault"), knowledgeDigestTime: "23:05" };
    saveConfig(paths, custom);
    assert.deepEqual(loadConfig(paths), custom);

    writeFileSync(
      paths.config,
      JSON.stringify({ ...custom, knowledgeDigestTime: "25:99" }),
      "utf8",
    );
    assert.equal(loadConfig(paths).knowledgeDigestTime, "22:30");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
