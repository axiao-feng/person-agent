import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  desktopExecutable,
  notificationActionLabel,
  notificationLaunch,
} from "../src/notifications.js";

test("notification actions map to the WPF client's deep-link arguments", () => {
  assert.deepEqual(notificationLaunch({ kind: "approval", id: "approval-1" }), {
    mode: "approval",
    objectId: "approval-1",
  });
  assert.deepEqual(notificationLaunch({ kind: "lecture", id: "lecture-1" }), {
    mode: "lecture",
    objectId: "lecture-1",
  });
  assert.deepEqual(notificationLaunch({ kind: "today" }), {
    mode: "today",
    objectId: "",
  });
  assert.equal(notificationActionLabel({ kind: "approval", id: "a" }), "打开待审批");
  assert.equal(notificationActionLabel({ kind: "lecture", id: "b" }), "打开日历");
  assert.equal(notificationActionLabel({ kind: "today" }), "打开今日");
});

test("notification deep links resolve the registered client and reject stale paths", () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-notification-test-"));
  try {
    const executable = join(root, "PersonAgent.Desktop.exe");
    writeFileSync(executable, "stub", "utf8");
    assert.equal(
      desktopExecutable({ PERSON_AGENT_DESKTOP: executable } as NodeJS.ProcessEnv),
      executable,
    );

    const home = join(root, "home");
    mkdirSync(home);
    writeFileSync(
      join(home, "desktop.json"),
      JSON.stringify({ executable, version: "0.3.0.0" }),
      "utf8",
    );
    assert.equal(
      desktopExecutable({ PERSON_AGENT_HOME: home } as NodeJS.ProcessEnv),
      executable,
    );

    rmSync(executable);
    assert.equal(
      desktopExecutable({ PERSON_AGENT_HOME: home } as NodeJS.ProcessEnv),
      undefined,
      "a stale registration must hide the deep-link button",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
