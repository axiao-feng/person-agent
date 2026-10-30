import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  findCSharpCompiler,
  findProjectRoot,
  launcherIni,
} from "../src/launcher/install.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("launcher configuration points at the built CLI and all three capture paths", () => {
  const ini = launcherIni("C:\\Program Files\\nodejs\\node.exe", "D:\\person-agent\\dist\\src\\cli.js");
  assert.match(ini, /^node=C:\\Program Files\\nodejs\\node\.exe/m);
  assert.match(ini, /^cli=D:\\person-agent\\dist\\src\\cli\.js/m);
  assert.equal(findProjectRoot(), PROJECT_ROOT);

  const source = readFileSync(join(PROJECT_ROOT, "launcher", "PersonAgent.cs"), "utf8");
  assert.match(source, /arguments\.Add\("idea"\);[\s\S]{0,80}arguments\.Add\("add"\)/);
  assert.match(source, /arguments\.Add\("task"\);[\s\S]{0,80}arguments\.Add\("add"\)/);
  assert.match(source, /"assignment"/);
  assert.match(source, /arguments\.Add\("lecture"\);[\s\S]{0,80}arguments\.Add\("add"\)/);
  assert.match(source, /"knowledge", "digest"/);
  assert.match(source, /"knowledge", "open-today"/);
  assert.match(source, /--body-file/);
  assert.match(source, /--notes-file/);
  assert.match(source, /ClearCurrentTab\(\)/);
  assert.match(source, /已保存到本地知识库\/数据库，输入已清空/);
});

test(
  "the system C# compiler used by launcher install exists",
  { skip: process.platform !== "win32" },
  () => {
    assert.ok(existsSync(findCSharpCompiler()));
  },
);
