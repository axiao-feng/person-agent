import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  desktopExecutable,
  desktopRegistrationRoots,
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
      JSON.stringify({ executable, version: "0.3.1.0" }),
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

test("notification discovery falls back to the standard LocalAppData registration", () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-notification-fallback-"));
  try {
    const workerHome = join(root, "worker-home");
    const localAppData = join(root, "local-app-data");
    const standardHome = join(localAppData, "person-agent");
    const executable = join(root, "PersonAgent.Desktop.exe");
    mkdirSync(workerHome);
    mkdirSync(standardHome, { recursive: true });
    writeFileSync(executable, "stub", "utf8");
    writeFileSync(
      join(standardHome, "desktop.json"),
      JSON.stringify({ executable }),
      "utf8",
    );
    const environment = {
      PERSON_AGENT_HOME: workerHome,
      LOCALAPPDATA: localAppData,
    } as NodeJS.ProcessEnv;
    assert.deepEqual(desktopRegistrationRoots(environment), [
      workerHome,
      standardHome,
    ]);
    assert.equal(desktopExecutable(environment), executable);

    const workerExecutable = join(root, "Worker.PersonAgent.Desktop.exe");
    writeFileSync(workerExecutable, "stub", "utf8");
    writeFileSync(
      join(workerHome, "desktop.json"),
      JSON.stringify({ executable: workerExecutable }),
      "utf8",
    );
    assert.equal(
      desktopExecutable(environment),
      workerExecutable,
      "the worker home registration wins over the fallback",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
