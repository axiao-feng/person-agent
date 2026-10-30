import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  installWorkerTask,
  startWorkerTask,
  workerTaskHealth,
  type WorkerTaskCommands,
} from "../src/worker-service.js";

test(
  "worker install registers the task and starts it immediately",
  { skip: process.platform !== "win32" },
  () => {
    const cliPath = join(process.cwd(), "src", "cli.ts");
    const schtasksCalls: string[][] = [];
    const scripts: string[] = [];
    const commands: WorkerTaskCommands = {
      schtasks: (args) => {
        schtasksCalls.push(args);
        return "";
      },
      powershell: (script) => {
        scripts.push(script);
        return "Running";
      },
    };
    const message = installWorkerTask(commands, cliPath);
    assert.match(message, /已安装并启动/);
    assert.ok(schtasksCalls.some((args) => args.includes("/Create")));
    assert.ok(scripts.some((script) => script.includes("Set-ScheduledTask")));
    assert.ok(scripts.some((script) => script.includes("Start-ScheduledTask")));

    assert.throws(
      () =>
        startWorkerTask(
          {
            schtasks: () => "",
            powershell: () => "Ready",
          },
          cliPath,
        ),
      /未保持运行/,
    );
  },
);

test(
  "worker health reports running, stopped, and missing states",
  { skip: process.platform !== "win32" },
  () => {
    const commands = (output: string): WorkerTaskCommands => ({
      schtasks: () => "",
      powershell: () => output,
    });
    const running = workerTaskHealth(
      commands('{"state":"running","lastRunAt":"2026-10-30T08:00:00.0000000+08:00"}'),
    );
    assert.equal(running.state, "running");
    assert.equal(running.lastRunAt, "2026-10-30T00:00:00.000Z");

    assert.deepEqual(
      workerTaskHealth(commands('{"state":"stopped","lastRunAt":null}')),
      { state: "stopped", lastRunAt: null },
    );
    assert.deepEqual(
      workerTaskHealth(commands('{"state":"not_installed","lastRunAt":null}')),
      { state: "not_installed", lastRunAt: null },
    );
    assert.deepEqual(workerTaskHealth(commands("not json")), {
      state: "unknown",
      lastRunAt: null,
    });
  },
);
