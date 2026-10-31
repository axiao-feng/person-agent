#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import { createAssistant, promptForText } from "./agent.js";
import { loadConfig, saveConfig, type AppConfig } from "./config.js";
import { AppDatabase, type LectureInput, type TaskKind } from "./database.js";
import { connectGoogle, GoogleService } from "./integrations/google.js";
import { geocodeCity } from "./integrations/weather.js";
import { generateKnowledgeDigest } from "./knowledge/digest.js";
import { openTodayKnowledgeNote } from "./knowledge/open.js";
import { createIdeaNote, ensureKnowledgeVault } from "./knowledge/vault.js";
import { syncZotero } from "./knowledge/zotero.js";
import { createLogger } from "./logger.js";
import { appPaths, ensureAppDirectory, type AppPaths } from "./paths.js";
import { loadSecrets, saveSecrets } from "./secrets.js";
import { startLocalServer, type LocalServer } from "./server/index.js";
import type { JobSchedule } from "./schedule.js";
import { generateDailyBriefing, runWorker } from "./worker.js";
import {
  installWorkerTask,
  startWorkerTask,
  uninstallWorkerTask,
  workerTaskStatus,
} from "./worker-service.js";

loadLocalEnv();
relaunchWithProxy();

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`错误：${message.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")}`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  const paths = appPaths();
  ensureAppDirectory(paths);

  switch (command) {
    case "setup":
      await setup(paths);
      break;
    case "chat":
      await chat(paths);
      break;
    case "briefing":
      await briefing(paths);
      break;
    case "doctor":
      await doctor(paths);
      break;
    case "serve":
      await serveCommand(paths, args);
      break;
    case "lecture":
      await lectureCommand(paths, args);
      break;
    case "reminder":
      await reminderCommand(paths, args);
      break;
    case "idea":
      await ideaCommand(paths, args);
      break;
    case "task":
      await taskCommand(paths, args);
      break;
    case "knowledge":
      await knowledgeCommand(paths, args);
      break;
    case "worker":
      await workerCommand(paths, args);
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      throw new Error(`未知命令：${command}。运行 person-agent help 查看帮助。`);
  }
}

async function setup(paths: AppPaths): Promise<void> {
  const current = loadConfig(paths);
  const rl = createInterface({ input: stdin, output: stdout });
  let config: AppConfig = current;
  let googleCredentialsPath = "";
  let updateKey = false;
  try {
    const city = (
      await rl.question(`城市${current.location ? `（当前 ${current.location.city}，回车保留）` : ""}：`)
    ).trim();
    if (city) {
      const candidates = await geocodeCity(city);
      if (!candidates.length) throw new Error(`找不到城市：${city}`);
      candidates.forEach((candidate, index) =>
        console.log(`${index + 1}. ${candidate.city} (${candidate.latitude}, ${candidate.longitude})`),
      );
      const answer = (await rl.question("选择城市编号（默认 1）：")).trim();
      const index = answer ? Number(answer) - 1 : 0;
      const location = candidates[index];
      if (!location) throw new Error("城市编号无效。");
      config = { ...config, location, timezone: location.timezone };
    }

    const briefingTime = (await rl.question(`每日简报时间（当前 ${config.briefingTime}，HH:mm）：`)).trim();
    if (briefingTime) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(briefingTime)) throw new Error("简报时间必须是 HH:mm。");
      config = { ...config, briefingTime };
    }

    const vaultPath = (
      await rl.question(`知识库目录（当前 ${config.knowledgeVaultPath}，回车保留）：`)
    ).trim();
    if (vaultPath) config = { ...config, knowledgeVaultPath: vaultPath };

    const digestTime = (
      await rl.question(`晚间知识整理时间（当前 ${config.knowledgeDigestTime}，HH:mm）：`)
    ).trim();
    if (digestTime) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(digestTime)) throw new Error("晚间知识整理时间必须是 HH:mm。");
      config = { ...config, knowledgeDigestTime: digestTime };
    }

    const secrets = await loadSecrets(paths);
    if (!process.env.DEEPSEEK_API_KEY) {
      const answer = (
        await rl.question(secrets.deepseekApiKey ? "更新本地 DeepSeek API key？(y/N)：" : "现在录入 DeepSeek API key？(Y/n)：")
      )
        .trim()
        .toLowerCase();
      updateKey = secrets.deepseekApiKey ? answer === "y" || answer === "yes" : answer !== "n" && answer !== "no";
    }

    googleCredentialsPath = (
      await rl.question(
        `Google OAuth 客户端 JSON 路径${(await GoogleService.isConnected(paths)) ? "（已连接，回车保留）" : "（回车暂不连接）"}：`,
      )
    ).trim();
  } finally {
    rl.close();
  }

  saveConfig(paths, config);
  if (updateKey) {
    const key = await promptSecret("DeepSeek API key");
    if (key) {
      const secrets = await loadSecrets(paths);
      await saveSecrets(paths, { ...secrets, deepseekApiKey: key });
      console.log("DeepSeek API key 已使用 Windows DPAPI 加密保存。");
    }
  }

  if (googleCredentialsPath) {
    if (!existsSync(googleCredentialsPath)) throw new Error("Google OAuth 客户端 JSON 文件不存在。");
    const email = await connectGoogle(paths, googleCredentialsPath);
    console.log(`Google 已连接：${email}`);
  }

  ensureKnowledgeVault(config.knowledgeVaultPath);
  const database = new AppDatabase(paths.database);
  try {
    database.ensureDailyBriefing(config);
    database.ensureKnowledgeDigest(config);
  } finally {
    database.close();
  }
  console.log(`设置已保存到 ${paths.root}`);
  console.log(`知识库目录：${config.knowledgeVaultPath}`);
}

async function chat(paths: AppPaths): Promise<void> {
  const config = loadConfig(paths);
  const database = new AppDatabase(paths.database);
  database.ensureDailyBriefing(config);
  database.ensureKnowledgeDigest(config);
  const agent = await createAssistant({ paths, config, database, streamToConsole: true });
  const rl = createInterface({ input: stdin, output: stdout });
  console.log("个人助理已启动。输入 /exit 退出；日历操作使用 /approve <ID> 或 /reject <ID>。\n");
  try {
    while (true) {
      const input = (await rl.question("你 > ")).trim();
      if (!input) continue;
      if (input === "/exit" || input === "/quit") break;
      process.stdout.write("助理 > ");
      try {
        const approval = input.match(/^\/approve\s+([0-9a-f-]+)$/i);
        const rejection = input.match(/^\/reject\s+([0-9a-f-]+)$/i);
        if (approval) {
          const action = database.approveWorkflowAction(approval[1]!);
          await promptForText(
            agent,
            `用户已通过本地可信界面批准操作 ${action.id}。严格按照以下固定内容调用对应 Calendar 工具，并传入 approvalId=${action.id}：${JSON.stringify(action.payload)}`,
          );
        } else if (rejection) {
          const action = database.rejectWorkflowAction(rejection[1]!);
          process.stdout.write(`已拒绝操作 ${action.id}，未修改 Google Calendar。`);
        } else if (input === "/pending") {
          process.stdout.write(
            JSON.stringify(
              database
                .listWorkflowActions()
                .filter((action) => action.status !== "executed" && action.status !== "rejected"),
              null,
              2,
            ),
          );
        } else if (/^(请)?(帮我)?(生成|查看)?(一下)?(今天|今日|每日)?的?简报[。！？!?]*$/.test(input)) {
          process.stdout.write(
            await generateDailyBriefing({ paths, config, database, logger: createLogger(paths) }),
          );
        } else {
          await promptForText(agent, input);
        }
        process.stdout.write("\n\n");
      } catch (error) {
        process.stdout.write("\n");
        console.error(error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    rl.close();
    database.close();
  }
}

async function briefing(paths: AppPaths): Promise<void> {
  const config = loadConfig(paths);
  const database = new AppDatabase(paths.database);
  try {
    console.log(await generateDailyBriefing({ paths, config, database, logger: createLogger(paths) }));
  } finally {
    database.close();
  }
}

async function doctor(paths: AppPaths): Promise<void> {
  const config = loadConfig(paths);
  const secrets = await loadSecrets(paths).catch(() => ({}));
  let databaseOk = false;
  try {
    const database = new AppDatabase(paths.database);
    database.close();
    databaseOk = true;
  } catch {
    databaseOk = false;
  }
  const checks = {
    node: process.version,
    platform: process.platform,
    dataDirectory: paths.root,
    database: databaseOk ? "ok" : "error",
    city: config.location?.city ?? "未配置",
    timezone: config.timezone,
    briefing: config.briefingTime,
    knowledgeVault: config.knowledgeVaultPath,
    knowledgeDigest: config.knowledgeDigestTime,
    model: `deepseek/deepseek-flash (${config.thinkingLevel})`,
    deepseekKey:
      process.env.DEEPSEEK_API_KEY || ("deepseekApiKey" in secrets && secrets.deepseekApiKey)
        ? "configured"
        : "missing",
    google: await GoogleService.isConnected(paths).then((connected) => (connected ? "connected" : "missing")),
  };
  console.log(JSON.stringify(checks, null, 2));
}

async function serveCommand(paths: AppPaths, args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const portText = stringFlag(flags, "port");
  const port = portText === undefined ? 0 : Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("--port 必须是 0 到 65535 的整数。");
  }
  const token = process.env.PERSON_AGENT_SESSION_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "serve 需要客户端通过 PERSON_AGENT_SESSION_TOKEN 环境变量提供一次性会话 token。",
    );
  }

  const config = loadConfig(paths);
  const database = new AppDatabase(paths.database);
  database.ensureDailyBriefing(config);
  database.ensureKnowledgeDigest(config);
  const logger = createLogger(paths);
  let server: LocalServer | undefined;
  try {
    server = await startLocalServer({
      token,
      paths,
      config,
      database,
      logger,
      port,
    });
    process.stdout.write(
      `${JSON.stringify({
        event: "ready",
        port: server.port,
        protocolVersion: server.protocolVersion,
      })}\n`,
    );
    await waitForServiceShutdown(server);
  } finally {
    database.close();
  }
}

function waitForServiceShutdown(server: LocalServer): Promise<void> {
  return new Promise((resolve) => {
    let finishing = false;
    const finish = (): void => {
      if (finishing) return;
      finishing = true;
      cleanup();
      void server.close().then(resolve);
    };
    const cleanup = (): void => {
      process.stdin.off("end", finish);
      process.stdin.off("close", finish);
      process.stdin.off("error", finish);
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
    };
    process.stdin.on("end", finish);
    process.stdin.on("close", finish);
    process.stdin.on("error", finish);
    process.on("SIGINT", finish);
    process.on("SIGTERM", finish);
    process.stdin.resume();
    if (process.stdin.readableEnded) finish();
  });
}

async function lectureCommand(paths: AppPaths, args: string[]): Promise<void> {
  const [action = "list", ...rest] = args;
  const flags = parseFlags(rest);
  const database = new AppDatabase(paths.database);
  try {
    const notes = optionalTextFlag(flags, "notes", "notes-file");
    if (action === "add") {
      const input: LectureInput = {
        title: requiredFlag(flags, "title"),
        startAt: requiredFlag(flags, "start"),
        ...optionalFlagObject(flags, "end", "endAt"),
        ...optionalFlagObject(flags, "location", "location"),
        ...optionalFlagObject(flags, "speaker", "speaker"),
        ...(notes === undefined ? {} : { notes }),
        ...optionalBooleanFlagObject(flags, "requires-presentation", "requiresPresentation"),
      };
      printJson(database.createLecture(input));
    } else if (action === "list") {
      printJson(database.listLectures());
    } else if (action === "update") {
      const id = requiredFlag(flags, "id");
      const changes: Partial<LectureInput> = {
        ...optionalFlagObject(flags, "title", "title"),
        ...optionalFlagObject(flags, "start", "startAt"),
        ...optionalFlagObject(flags, "end", "endAt"),
        ...optionalFlagObject(flags, "location", "location"),
        ...optionalFlagObject(flags, "speaker", "speaker"),
        ...(notes === undefined ? {} : { notes }),
        ...optionalBooleanFlagObject(flags, "requires-presentation", "requiresPresentation"),
      };
      if (!Object.keys(changes).length) throw new Error("至少提供一个要修改的字段。");
      printJson(database.updateLecture(id, changes));
    } else if (action === "cancel") {
      printJson(database.cancelLecture(requiredFlag(flags, "id")));
    } else {
      throw new Error(`未知 lecture 操作：${action}`);
    }
  } finally {
    database.close();
  }
}

async function reminderCommand(paths: AppPaths, args: string[]): Promise<void> {
  const [action = "list", ...rest] = args;
  const flags = parseFlags(rest);
  const config = loadConfig(paths);
  const database = new AppDatabase(paths.database);
  try {
    if (action === "add") {
      const schedule = reminderSchedule(flags);
      printJson(
        database.createReminder({
          title: requiredFlag(flags, "title"),
          ...optionalFlagObject(flags, "body", "body"),
          schedule,
          timezone: config.timezone,
        }),
      );
    } else if (action === "list") {
      printJson(database.listReminders());
    } else if (action === "cancel") {
      printJson(database.cancelReminder(requiredFlag(flags, "id")));
    } else {
      throw new Error(`未知 reminder 操作：${action}`);
    }
  } finally {
    database.close();
  }
}

async function ideaCommand(paths: AppPaths, args: string[]): Promise<void> {
  const [action = "add", ...rest] = args;
  if (action !== "add") throw new Error(`未知 idea 操作：${action}`);
  const flags = parseFlags(rest);
  const body = requiredTextFlag(flags, "body", "body-file", "idea 正文");
  const title = stringFlag(flags, "title");
  const tags = (stringFlag(flags, "tags") ?? "")
    .split(/[,，]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
  const config = loadConfig(paths);
  printJson(
    createIdeaNote(
      config.knowledgeVaultPath,
      {
        body,
        ...(title ? { title } : {}),
        ...(tags.length ? { tags } : {}),
      },
      new Date(),
      config.timezone,
    ),
  );
}

async function taskCommand(paths: AppPaths, args: string[]): Promise<void> {
  const [action = "list", ...rest] = args;
  const flags = parseFlags(rest);
  const database = new AppDatabase(paths.database);
  try {
    if (action === "add") {
      const kind = (stringFlag(flags, "kind") ?? "research") as TaskKind;
      if (!["research", "assignment", "other"].includes(kind)) {
        throw new Error("--kind 只能是 research、assignment 或 other。");
      }
      const priority = stringFlag(flags, "priority");
      if (priority && !["low", "medium", "high"].includes(priority)) {
        throw new Error("--priority 只能是 low、medium 或 high。");
      }
      const minutesText = stringFlag(flags, "minutes");
      let estimatedMinutes: number | undefined;
      if (minutesText !== undefined) {
        estimatedMinutes = Number(minutesText);
        if (!Number.isInteger(estimatedMinutes)) throw new Error("--minutes 必须是整数。");
      }
      const deadline = stringFlag(flags, "deadline");
      printJson(
        database.createResearchTask({
          title: requiredFlag(flags, "title"),
          taskKind: kind,
          ...(deadline ? { deadline } : {}),
          ...(estimatedMinutes === undefined ? {} : { estimatedMinutes }),
          ...(priority ? { priority: priority as "low" | "medium" | "high" } : {}),
        }),
      );
    } else if (action === "list") {
      printJson(database.listResearchTasks());
    } else {
      throw new Error(`未知 task 操作：${action}`);
    }
  } finally {
    database.close();
  }
}

async function knowledgeCommand(paths: AppPaths, args: string[]): Promise<void> {
  const [action = "digest"] = args;
  const config = loadConfig(paths);
  ensureKnowledgeVault(config.knowledgeVaultPath);
  if (action === "open-today") {
    printJson(openTodayKnowledgeNote(config.knowledgeVaultPath, new Date(), config.timezone));
    return;
  }
  const database = new AppDatabase(paths.database);
  try {
    if (action === "sync") {
      printJson(
        await syncZotero({
          config,
          database,
          logger: createLogger(paths),
        }),
      );
    } else if (action === "digest") {
      printJson(
        await generateKnowledgeDigest(
          { paths, config, database, logger: createLogger(paths) },
          { now: new Date() },
        ),
      );
    } else {
      throw new Error(`未知 knowledge 操作：${action}`);
    }
  } finally {
    database.close();
  }
}

async function workerCommand(paths: AppPaths, args: string[]): Promise<void> {
  const [action = "status"] = args;
  if (action === "install") console.log(installWorkerTask());
  else if (action === "start") console.log(startWorkerTask());
  else if (action === "status") console.log(workerTaskStatus());
  else if (action === "uninstall") console.log(uninstallWorkerTask());
  else if (action === "run") {
    const logger = createLogger(paths);
    const config = loadConfig(paths);
    const database = new AppDatabase(paths.database);
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await runWorker(
        { paths, config, database, logger, reloadConfig: () => loadConfig(paths) },
        controller.signal,
      );
    } finally {
      database.close();
    }
  } else {
    throw new Error(`未知 worker 操作：${action}`);
  }
}

function reminderSchedule(flags: Map<string, string | true>): JobSchedule {
  const at = stringFlag(flags, "at");
  const daily = stringFlag(flags, "daily");
  const weekly = stringFlag(flags, "weekly");
  const time = stringFlag(flags, "time");
  const selected = [at, daily, weekly].filter(Boolean).length;
  if (selected !== 1) throw new Error("必须且只能提供 --at、--daily 或 --weekly 之一。");
  if (at) return { kind: "once", at };
  if (daily) return { kind: "daily", time: daily };
  if (!time) throw new Error("每周提醒还需要 --time HH:mm。");
  const weekdays = weekly!
    .split(",")
    .map(Number)
    .filter((day) => Number.isInteger(day));
  return { kind: "weekly", time, weekdays };
}

function parseFlags(args: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--")) throw new Error(`无法识别参数：${token}`);
    const name = token.slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  return flags;
}

function requiredFlag(flags: Map<string, string | true>, name: string): string {
  const value = stringFlag(flags, name);
  if (!value) throw new Error(`缺少 --${name}。`);
  return value;
}

function requiredTextFlag(
  flags: Map<string, string | true>,
  valueName: string,
  fileName: string,
  label: string,
): string {
  const direct = stringFlag(flags, valueName);
  const file = stringFlag(flags, fileName);
  if (direct !== undefined && file !== undefined) {
    throw new Error(`--${valueName} 和 --${fileName} 只能提供一个。`);
  }
  if (file !== undefined) {
    if (!existsSync(file)) throw new Error(`找不到 --${fileName} 指定的文件：${file}`);
    const content = readFileSync(file, "utf8");
    if (!content.trim()) throw new Error(`${label}不能为空。`);
    return content;
  }
  if (direct === undefined) throw new Error(`缺少 --${valueName} 或 --${fileName}。`);
  if (!direct.trim()) throw new Error(`${label}不能为空。`);
  return direct;
}

function stringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  if (value === true) throw new Error(`--${name} 需要一个值。`);
  return value;
}

function optionalTextFlag(
  flags: Map<string, string | true>,
  valueName: string,
  fileName: string,
): string | undefined {
  const direct = stringFlag(flags, valueName);
  const file = stringFlag(flags, fileName);
  if (direct !== undefined && file !== undefined) {
    throw new Error(`--${valueName} 和 --${fileName} 只能提供一个。`);
  }
  if (file === undefined) return direct;
  if (!existsSync(file)) throw new Error(`找不到 --${fileName} 指定的文件：${file}`);
  return readFileSync(file, "utf8");
}

function optionalFlagObject<K extends string>(
  flags: Map<string, string | true>,
  flag: string,
  key: K,
): Partial<Record<K, string>> {
  const value = stringFlag(flags, flag);
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

function optionalBooleanFlagObject<K extends string>(
  flags: Map<string, string | true>,
  flag: string,
  key: K,
): Partial<Record<K, boolean>> {
  const value = flags.get(flag);
  if (value === undefined) return {};
  if (value === true || value === "true") return { [key]: true } as Record<K, boolean>;
  if (value === "false") return { [key]: false } as Record<K, boolean>;
  throw new Error(`--${flag} 只能是 true 或 false。`);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function promptSecret(label: string): Promise<string> {
  if (process.platform !== "win32") throw new Error("安全密钥录入仅支持 Windows。");
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("安全密钥录入需要交互式终端；也可以设置 DEEPSEEK_API_KEY 环境变量。");
  }
  stdout.write(`${label}（输入不会显示）：`);
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("密钥输入已取消。"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (character === "\b" || character === "\u007f") value = value.slice(0, -1);
        else value += character;
      }
    };
    stdin.on("data", onData);
  });
}

function loadLocalEnv(): void {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = [".env", join(here, "..", ".env"), join(here, "..", "..", ".env")].find(existsSync);
    if (path) process.loadEnvFile(path);
  } catch {
    // Environment variables remain available even if the optional .env file is invalid.
  }
}

function relaunchWithProxy(): void {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;
  if (
    !proxy ||
    process.env.PERSON_AGENT_PROXY_READY === "1" ||
    process.env.NODE_USE_ENV_PROXY === "1" ||
    process.execArgv.includes("--use-env-proxy")
  ) {
    return;
  }
  const child = spawnSync(
    process.execPath,
    ["--use-env-proxy", ...process.execArgv, ...process.argv.slice(1)],
    {
      env: { ...process.env, PERSON_AGENT_PROXY_READY: "1" },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}

function printHelp(): void {
  console.log(`person-agent commands:
  setup
  chat
  briefing
  serve [--port 0]
  doctor
  lecture add --title <标题> --start <ISO> [--end <ISO>] [--location <地点>] [--requires-presentation]
  lecture list
  lecture update --id <ID> [字段...]
  lecture cancel --id <ID>
  reminder add --title <标题> --at <ISO>
  reminder add --title <标题> --daily <HH:mm>
  reminder add --title <标题> --weekly <1,3,5> --time <HH:mm>
  reminder list
  reminder cancel --id <ID>
  idea add [--title <标题>] --body <正文> [--tags <a,b>]
  task add --kind research|assignment|other --title <标题> [--deadline <ISO>] [--minutes 60] [--priority medium]
  task list
  knowledge sync|digest|open-today
  worker run|install|start|status|uninstall`);
}
