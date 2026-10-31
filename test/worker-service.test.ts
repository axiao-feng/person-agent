import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  installWorkerTask,
  startWorkerTask,
  workerTaskHealth,
  workerTaskStatus,
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
    assert.ok(scripts.some((script) => script.includes("RepetitionInterval")));
    assert.ok(scripts.some((script) => script.includes("MultipleInstances IgnoreNew")));

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
      commands(
        '{"installed":true,"state":"Running","lastRunAt":"2026-10-30T08:00:00.0000000+08:00","lastResult":0,"nextRunAt":null}',
      ),
    );
    assert.equal(running.state, "running");
    assert.equal(running.lastRunAt, "2026-10-30T00:00:00.000Z");

    assert.deepEqual(
      workerTaskHealth(
        commands(
          '{"installed":true,"state":"Ready","lastRunAt":"2026-10-30T08:00:00.0000000+08:00","lastResult":3221225786,"nextRunAt":null}',
        ),
      ),
      { state: "stopped", lastRunAt: "2026-10-30T00:00:00.000Z" },
    );
    assert.deepEqual(workerTaskHealth(commands('{"installed":false}')), {
      state: "not_installed",
      lastRunAt: null,
    });
    assert.deepEqual(workerTaskHealth(commands("not json")), {
      state: "unknown",
      lastRunAt: null,
    });
  },
);

test(
  "worker status renders readable state, time, and last result",
  { skip: process.platform !== "win32" },
  () => {
    const commands = (output: string): WorkerTaskCommands => ({
      schtasks: () => "",
      powershell: () => output,
    });
    const status = workerTaskStatus(
      commands(
        '{"installed":true,"state":"Ready","lastRunAt":"2026-10-31T09:56:56.0000000+08:00","lastResult":3221225786,"nextRunAt":"2026-10-31T10:05:00.0000000+08:00"}',
      ),
    );
    assert.match(status, /任务：Person Agent/);
    assert.match(status, /状态：已停止（Ready）/);
    assert.match(status, /上次结果：0xC000013A/);
    assert.match(status, /下次运行：/);
    assert.match(status, /\d{4}/);

    const running = workerTaskStatus(
      commands(
        '{"installed":true,"state":"Running","lastRunAt":"2026-10-31T10:36:36.0000000+08:00","lastResult":-2146893600,"nextRunAt":"2026-10-31T10:41:41.0000000+08:00"}',
      ),
    );
    assert.match(running, /状态：运行中（Running）/);
    assert.equal(running.includes("上次结果"), false);

    const missing = workerTaskStatus(commands('{"installed":false}'));
    assert.match(missing, /状态：未安装/);
  },
);
