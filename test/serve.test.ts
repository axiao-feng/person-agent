import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "serve-integration-token";

test("serve announces a ready port and stops when its stdin closes", async () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-serve-test-"));
  const home = join(root, "home");
  const vault = join(root, "vault");
  mkdirSync(home, { recursive: true });
  mkdirSync(vault, { recursive: true });
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
  let child: ChildProcess | undefined;
  let stdout = "";
  let stderr = "";
  try {
    child = spawn(
      process.execPath,
      ["--import", "tsx", join(PROJECT_ROOT, "src", "cli.ts"), "serve", "--port", "0"],
      {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          PERSON_AGENT_HOME: home,
          PERSON_AGENT_SESSION_TOKEN: TOKEN,
          PERSON_AGENT_PROXY_READY: "1",
          DEEPSEEK_API_KEY: "",
          HTTP_PROXY: "",
          HTTPS_PROXY: "",
          ALL_PROXY: "",
          NO_PROXY: "*",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const readyLine = await waitForLine(() => stdout, 20_000);
    const ready = JSON.parse(readyLine) as {
      event: string;
      port: number;
      protocolVersion: string;
      home: string;
    };
    assert.equal(ready.event, "ready");
    assert.equal(ready.protocolVersion, "1");
    assert.ok(ready.port > 0);
    assert.equal(ready.home, home);
    assert.equal(readyLine.includes(TOKEN), false);

    const response = await fetch(`http://127.0.0.1:${ready.port}/api/health`, {
      headers: { "X-Person-Agent-Token": TOKEN },
    });
    assert.equal(response.status, 200);
    const health = (await response.json()) as { service: { protocolVersion: string } };
    assert.equal(health.service.protocolVersion, "1");

    child.stdin?.end();
    const exitCode = await waitForExit(child, 10_000);
    assert.equal(exitCode, 0, stderr);
  } finally {
    if (child && child.exitCode === null) child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitForLine(read: () => string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const line = read()
      .split(/\r?\n/)
      .find((candidate) => candidate.trim());
    if (line) return line;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`本地服务未在 ${timeoutMs}ms 内输出就绪消息。`);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("本地服务未在 stdin 关闭后退出。"));
    }, timeoutMs);
    const onExit = (code: number | null): void => {
      clearTimeout(timer);
      resolveExit(code);
    };
    child.once("exit", onExit);
  });
}
