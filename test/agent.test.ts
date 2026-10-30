import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";

import { systemPrompt } from "../src/agent.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { AppDatabase } from "../src/database.js";
import { buildTools } from "../src/tools.js";

test("chat prompt keeps briefing reads explicit and calendar writes approval-gated", () => {
  const prompt = systemPrompt({ ...DEFAULT_CONFIG }, "chat");
  for (const tool of ["get_weather", "list_calendar_events", "list_lectures"]) {
    assert.ok(prompt.includes(tool), `missing required briefing tool: ${tool}`);
  }
  assert.match(prompt, /简报不要调用、提及或主动建议 search_emails、read_email 或 Gmail/);
  assert.match(prompt, /不得在未调用工具时声称城市、Google 或本地数据未配置/);
  assert.match(prompt, /\/approve <ID>/);
  assert.match(prompt, /观察→澄清→计划→审批→执行→检查/);
  assert.match(prompt, /capture_idea/);
  assert.match(prompt, /只有用户明确说/);
});

test("faux model can route an explicit lecture request to create_lecture", async () => {
  await withAgent(async ({ agent, faux, database }) => {
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("create_lecture", {
          title: "可信人工智能",
          startAt: "2026-09-23T19:00:00+08:00",
          location: "学术报告厅",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxText("已录入。")),
    ]);
    await agent.prompt("请录入 2026 年 9 月 23 日晚上 7 点的可信人工智能讲座，地点学术报告厅。");
    assert.equal(database.listLectures().length, 1);
    assert.equal(database.listLectures()[0]?.title, "可信人工智能");
  });
});

test("faux model asks for a missing date instead of creating a lecture", async () => {
  await withAgent(async ({ agent, faux, database }) => {
    faux.setResponses([fauxAssistantMessage(fauxText("这场讲座是哪一天？请提供明确日期。"))]);
    await agent.prompt("帮我录入晚上七点的讲座。");
    assert.equal(database.listLectures().length, 0);
    const last = agent.state.messages.at(-1);
    assert.equal(last?.role, "assistant");
  });
});

async function withAgent(
  operation: (input: {
    agent: Agent;
    faux: ReturnType<typeof fauxProvider>;
    database: AppDatabase;
  }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "person-agent-agent-test-"));
  const database = new AppDatabase(join(root, "test.db"));
  const faux = fauxProvider({ tokensPerSecond: 10_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const paths = {
    root,
    config: join(root, "config.json"),
    database: join(root, "test.db"),
    secrets: join(root, "secrets.dpapi"),
    log: join(root, "worker.log"),
  };
  const config = {
    timezone: "Asia/Shanghai",
    briefingTime: "07:30",
    thinkingLevel: "low" as const,
    knowledgeVaultPath: join(root, "vault"),
    knowledgeDigestTime: "22:30",
  };
  const agent = new Agent({
    initialState: {
      systemPrompt: "时间不明确时追问。",
      model: faux.getModel(),
      thinkingLevel: "off",
      tools: buildTools({ paths, config, database }),
    },
    streamFn: models.streamSimple.bind(models),
  });
  try {
    await operation({ agent, faux, database });
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
}
