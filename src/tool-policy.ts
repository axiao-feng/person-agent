import type { BeforeToolCallResult } from "@earendil-works/pi-agent-core";

export type ToolRisk = "read" | "local_write" | "external_write";
export type ToolApproval = "none" | "confirm" | "fixed_payload";

export type ToolPolicy = {
  risk: ToolRisk;
  approval: ToolApproval;
};

export type ToolPolicyRegistry = Readonly<Record<string, ToolPolicy>>;

/**
 * Static policy table for every tool the product registers.
 *
 * The table is the single place that says how risky a tool is; the agent loop
 * enforces it through `beforeToolCall`, so a prompt or a route cannot open a tool
 * that is not listed here.
 *
 * `external_write` tools must additionally go through `workflow_actions`: a first
 * call without `approvalId` only stages a fixed-payload approval, and the write
 * itself only runs after the user approves and the payload matches.
 */
export const TOOL_POLICIES: ToolPolicyRegistry = {
  // Read-only sources.
  search_emails: { risk: "read", approval: "none" },
  read_email: { risk: "read", approval: "none" },
  list_calendar_events: { risk: "read", approval: "none" },
  find_free_slots: { risk: "read", approval: "none" },
  get_weather: { risk: "read", approval: "none" },
  list_tasks: { risk: "read", approval: "none" },
  list_pending_actions: { risk: "read", approval: "none" },
  list_lectures: { risk: "read", approval: "none" },
  list_reminders: { risk: "read", approval: "none" },

  // Local writes: allowed by product rule, always with a visible tool result.
  create_task: { risk: "local_write", approval: "none" },
  update_task: { risk: "local_write", approval: "none" },
  capture_idea: { risk: "local_write", approval: "none" },
  create_lecture: { risk: "local_write", approval: "none" },
  update_lecture: { risk: "local_write", approval: "none" },
  cancel_lecture: { risk: "local_write", approval: "none" },
  create_reminder: { risk: "local_write", approval: "none" },
  cancel_reminder: { risk: "local_write", approval: "none" },
  remember_user_fact: { risk: "local_write", approval: "none" },

  // External writes: never executed from a bare model call.
  create_calendar_event: { risk: "external_write", approval: "fixed_payload" },
  update_calendar_event: { risk: "external_write", approval: "fixed_payload" },
};

export function policyFor(toolName: string, registry: ToolPolicyRegistry = TOOL_POLICIES): ToolPolicy | undefined {
  return registry[toolName];
}

/**
 * Returns a block decision when the tool is unknown to the policy table.
 *
 * Blocked calls become an error tool result; the model is told why and cannot
 * retry the same tool successfully.
 */
export function authorizeToolCall(
  toolName: string,
  registry: ToolPolicyRegistry = TOOL_POLICIES,
): BeforeToolCallResult | undefined {
  const policy = policyFor(toolName, registry);
  if (!policy) {
    return { block: true, reason: `工具 ${toolName} 没有注册权限策略，已阻止执行。` };
  }
  if (policy.risk === "external_write" && policy.approval !== "fixed_payload") {
    return { block: true, reason: `外部写入工具 ${toolName} 缺少固定 payload 审批策略。` };
  }
  return undefined;
}
