import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  obsidianUri,
  openKnowledgeNote,
  openTodayKnowledgeNote,
} from "../src/knowledge/open.js";

test("opens through obsidian:// when Obsidian is installed", () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-open-test-"));
  try {
    const path = join(root, "Daily", "2026-10-29.md");
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = openKnowledgeNote(path, {
      platform: "win32",
      exists: () => true,
      obsidianInstalled: () => true,
      launch: (command, args) => calls.push({ command, args }),
    });
    assert.equal(result.method, "obsidian");
    assert.equal(result.target, obsidianUri(path));
    assert.match(result.target, /^obsidian:\/\/open\?path=/);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.args.at(-1)!, /obsidian:\/\/open/);
    assert.match(decodeURIComponent(result.target), new RegExp("Daily"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("falls back to the system Markdown handler when Obsidian is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-open-test-"));
  try {
    const path = join(root, "Daily", "2026-10-29.md");
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = openKnowledgeNote(path, {
      platform: "win32",
      exists: () => true,
      obsidianInstalled: () => false,
      launch: (command, args) => calls.push({ command, args }),
    });
    assert.equal(result.method, "system");
    assert.equal(result.target, path);
    assert.equal(calls[0]?.command, "powershell.exe");
    assert.match(calls[0]!.args.at(-1)!, /Start-Process -FilePath/);
    assert.match(calls[0]!.args.at(-1)!, /2026-10-29\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("open-today uses the configured local date and rejects a missing note", () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-open-test-"));
  try {
    const now = new Date("2026-10-29T14:00:00.000Z");
    const expected = join(root, "Daily", "2026-10-29.md");
    assert.throws(
      () => openKnowledgeNote(join(root, "Daily", "missing.md"), { platform: "win32", exists: () => false }),
      /找不到知识简报/,
    );
    const result = openTodayKnowledgeNote(
      root,
      now,
      "Asia/Shanghai",
      {
        platform: "win32",
        exists: (path) => path === expected,
        obsidianInstalled: () => false,
        launch: () => undefined,
      },
    );
    assert.equal(result.target, expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
