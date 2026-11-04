import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";

import { AppDatabase } from "../src/database.js";
import { TOOL_POLICIES, authorizeToolCall, policyFor } from "../src/tool-policy.js";
import { buildTools, type ToolModule } from "../src/tools.js";

test("the static policy table classifies every built-in tool", () => {
  const registered = buildTools(
    { paths: tempPaths(), config: tempConfig(), database: new AppDatabase(":memory:") },
    "chat",
  );
  for (const tool of registered) {
    assert.ok(policyFor(tool.name), `missing policy for ${tool.name}`);
  }
  assert.deepEqual(policyFor("create_calendar_event"), { risk: "external_write", approval: "fixed_payload" });
  assert.deepEqual(policyFor("create_task"), { risk: "local_write", approval: "none" });
  assert.deepEqual(policyFor("search_emails"), { risk: "read", approval: "none" });
  assert.equal(Object.keys(TOOL_POLICIES).length >= registered.length, true);
});

test("unknown tools are blocked before they execute", () => {
  assert.equal(authorizeToolCall("create_task"), undefined);
  const blocked = authorizeToolCall("dangerous_tool");
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /没有注册权限策略/);

  // An external write must declare fixed-payload approval, not just any approval.
  const unsafe = authorizeToolCall("dangerous_tool", {
    dangerous_tool: { risk: "external_write", approval: "none" },
  });
  assert.equal(unsafe?.block, true);
});

test("the agent loop refuses a tool the policy table does not know", async () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-policy-test-"));
  const database = new AppDatabase(join(root, "test.db"));
  const faux = fauxProvider({ tokensPerSecond: 10_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const paths = tempPaths(root);
  const config = tempConfig(root);
  let executed = false;
  const extra: ToolModule = () => [
    {
      name: "dangerous_tool",
      label: "未注册工具",
      description: "测试用工具，未出现在权限表中。",
      parameters: Type.Object({}),
      execute: async () => {
        executed = true;
        return { content: [{ type: "text", text: "{}" }], details: {} };
      },
    },
  ];
  try {
    const agent = new Agent({
      initialState: {
        systemPrompt: "测试",
        model: faux.getModel(),
        thinkingLevel: "off",
        tools: buildTools({ paths, config, database }, "chat", [extra]),
      },
      beforeToolCall: async ({ toolCall }) => authorizeToolCall(toolCall.name),
      streamFn: models.streamSimple.bind(models),
    });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("dangerous_tool", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("该工具被阻止了。")),
    ]);
    await agent.prompt("执行危险工具");
    assert.equal(executed, false, "the blocked tool never ran");
    const result = agent.state.messages.find((message) => message.role === "toolResult");
    assert.ok(result);
    assert.equal(result.role === "toolResult" ? result.isError : false, true);
    assert.match(JSON.stringify(result), /没有注册权限策略/);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a registered tool still runs under the same hook", async () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-policy-test-"));
  const database = new AppDatabase(join(root, "test.db"));
  const faux = fauxProvider({ tokensPerSecond: 10_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  try {
    const agent = new Agent({
      initialState: {
        systemPrompt: "测试",
        model: faux.getModel(),
        thinkingLevel: "off",
        tools: buildTools({ paths: tempPaths(root), config: tempConfig(root), database }),
      },
      beforeToolCall: async ({ toolCall }) => authorizeToolCall(toolCall.name),
      streamFn: models.streamSimple.bind(models),
    });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("create_task", { title: "政策测试任务" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("已创建。")),
    ]);
    await agent.prompt("创建任务");
    assert.equal(database.listResearchTasks().length, 1);
    const result = agent.state.messages.find(
      (message): message is Extract<AgentMessage, { role: "toolResult" }> => message.role === "toolResult",
    );
    assert.equal(result?.isError, false);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function tempPaths(root = tmpdir()) {
  return {
    root,
    config: join(root, "config.json"),
    database: join(root, "test.db"),
    secrets: join(root, "secrets.dpapi"),
    log: join(root, "worker.log"),
  };
}

function tempConfig(root = tmpdir()) {
  return {
    timezone: "Asia/Shanghai",
    briefingTime: "07:30",
    thinkingLevel: "low" as const,
    knowledgeVaultPath: join(root, "vault"),
    knowledgeDigestTime: "22:30",
  };
}
