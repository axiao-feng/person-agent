import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AppDatabase } from "../src/database.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("CLI accepts the three capture paths without creating Calendar actions", () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-capture-test-"));
  const home = join(root, "home");
  const vault = join(root, "vault");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      timezone: "Asia/Shanghai",
      briefingTime: "07:30",
      thinkingLevel: "low",
      knowledgeVaultPath: vault,
      knowledgeDigestTime: "22:30",
    }),
    "utf8",
  );
  try {
    const ideaBody = join(root, "idea.txt");
    writeFileSync(ideaBody, "第一行 idea\n第二行说明。\n", "utf8");
    const idea = run(home, ["idea", "add", "--title", "实验 idea", "--tags", "实验,方法", "--body-file", ideaBody]);
    assert.equal(idea.status, 0, idea.stderr);
    const ideaResult = JSON.parse(idea.stdout) as { path: string; title: string };
    assert.equal(ideaResult.title, "实验 idea");
    assert.ok(existsSync(ideaResult.path));
    assert.match(readFileSync(ideaResult.path, "utf8"), /第二行说明/);

    const task = run(home, [
      "task",
      "add",
      "--kind",
      "assignment",
      "--title",
      "数值分析作业",
      "--deadline",
      "2026-11-01T18:00:00+08:00",
      "--minutes",
      "90",
      "--priority",
      "high",
    ]);
    assert.equal(task.status, 0, task.stderr);
    const taskResult = JSON.parse(task.stdout) as { taskKind: string; estimatedMinutes: number; priority: string };
    assert.equal(taskResult.taskKind, "assignment");
    assert.equal(taskResult.estimatedMinutes, 90);
    assert.equal(taskResult.priority, "high");

    const notesFile = join(root, "lecture-notes.txt");
    writeFileSync(notesFile, "记得提前十分钟到场。\n", "utf8");
    const lecture = run(home, [
      "lecture",
      "add",
      "--title",
      "可信人工智能讲座",
      "--start",
      "2026-11-05T19:00:00+08:00",
      "--end",
      "2026-11-05T20:30:00+08:00",
      "--location",
      "学术报告厅",
      "--notes-file",
      notesFile,
      "--requires-presentation",
      "true",
    ]);
    assert.equal(lecture.status, 0, lecture.stderr);

    const database = new AppDatabase(join(home, "agent.db"));
    try {
      const tasks = database.listResearchTasks();
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]?.title, "数值分析作业");
      assert.equal(tasks[0]?.taskKind, "assignment");
      const lectures = database.listLectures();
      assert.equal(lectures.length, 1);
      assert.equal(lectures[0]?.notes, "记得提前十分钟到场。");
      assert.equal(lectures[0]?.requiresPresentation, true);
      const actions = database.sqlite.prepare("SELECT COUNT(*) AS count FROM workflow_actions").get() as {
        count: number;
      };
      assert.equal(Number(actions.count), 0);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI rejects invalid idea, task, and lecture inputs with a non-zero status", () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-capture-test-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      timezone: "Asia/Shanghai",
      briefingTime: "07:30",
      thinkingLevel: "low",
      knowledgeVaultPath: join(root, "vault"),
      knowledgeDigestTime: "22:30",
    }),
    "utf8",
  );
  try {
    const noBody = run(home, ["idea", "add", "--title", "只有标题"]);
    assert.notEqual(noBody.status, 0);
    assert.match(noBody.stderr, /缺少 --body|缺少 --body 或 --body-file/);

    const badKind = run(home, ["task", "add", "--kind", "homework", "--title", "作业"]);
    assert.notEqual(badKind.status, 0);
    assert.match(badKind.stderr, /--kind/);

    const noTitle = run(home, ["lecture", "add", "--start", "2026-11-05T19:00:00+08:00"]);
    assert.notEqual(noTitle.status, 0);
    assert.match(noTitle.stderr, /缺少 --title/);

    const noTimezone = run(home, [
      "lecture",
      "add",
      "--title",
      "无时区",
      "--start",
      "2026-11-05T19:00:00",
    ]);
    assert.notEqual(noTimezone.status, 0);
    assert.match(noTimezone.stderr, /时区偏移/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function run(home: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", join(PROJECT_ROOT, "src", "cli.ts"), ...args],
    {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PERSON_AGENT_HOME: home,
        DEEPSEEK_API_KEY: "",
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        ALL_PROXY: "",
        NO_PROXY: "*",
      },
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
