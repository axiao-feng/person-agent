import type { AppDatabase, WorkflowRun, WorkflowRunStatus } from "../database.js";
import {
  MAX_STEPS_PER_ADVANCE,
  type WorkflowRegistry,
  type WorkflowStepOutcome,
} from "./types.js";

export type WorkflowRuntimeDeps = {
  database: AppDatabase;
  registry: WorkflowRegistry;
};

export function createWorkflowRuntime(deps: WorkflowRuntimeDeps) {
  return {
    create(input: {
      kind: string;
      input: Record<string, unknown>;
      conversationId?: string;
      state?: Record<string, unknown>;
    }): WorkflowRun {
      if (!deps.registry.has(input.kind)) throw new Error(`未注册的 workflow 类型：${input.kind}`);
      return deps.database.createWorkflowRun(input);
    },
    advance: (runId: string, now?: Date) => advanceRun(deps, runId, now ?? new Date()),
    cancel: (runId: string, now?: Date) => cancelRun(deps, runId, now ?? new Date()),
    resumePending: (options?: { now?: Date; limit?: number }) => resumePendingRuns(deps, options),
  };
}

export type WorkflowRuntime = ReturnType<typeof createWorkflowRuntime>;

/** Advances a run until it finishes, waits for the user, or fails. */
export async function advanceRun(
  deps: WorkflowRuntimeDeps,
  runId: string,
  now = new Date(),
): Promise<WorkflowRun> {
  const claimed = deps.database.claimWorkflowRun(runId, now);
  if (!claimed) {
    const existing = deps.database.getWorkflowRun(runId);
    if (!existing) throw new Error(`找不到 workflow run：${runId}`);
    return existing;
  }
  const definition = deps.registry.get(claimed.kind);
  if (!definition) {
    return deps.database.finishWorkflowRun(
      claimed.id,
      "failed",
      { error: `未注册的 workflow 类型：${claimed.kind}` },
      now,
    );
  }

  let run = claimed;
  for (let iteration = 0; iteration < MAX_STEPS_PER_ADVANCE; iteration += 1) {
    const sequence = run.currentStep + 1;
    const stepDefinition = definition.steps[sequence - 1];
    if (!stepDefinition) {
      return deps.database.finishWorkflowRun(
        run.id,
        "succeeded",
        { state: run.state, currentStep: run.currentStep },
        now,
      );
    }

    const idempotencyKey = `${run.id}:${sequence}:${stepDefinition.kind}`;
    const step = deps.database.ensureWorkflowStep(
      {
        runId: run.id,
        sequence,
        kind: stepDefinition.kind,
        input: run.input,
        idempotencyKey,
      },
      now,
    );
    if (step.status === "succeeded") {
      run = deps.database.advanceWorkflowRunState(run.id, { currentStep: sequence, state: run.state }, now);
      continue;
    }

    deps.database.startWorkflowStep(step.id, now);
    let outcome: WorkflowStepOutcome;
    try {
      outcome = await stepDefinition.execute({
        database: deps.database,
        run,
        step: { sequence, kind: stepDefinition.kind, idempotencyKey },
        now,
      });
    } catch (error) {
      outcome = { status: "failed", error: safeError(error) };
    }

    if (outcome.status === "poll") {
      // The step cannot finish yet (e.g. waiting for an approval). Pause it so the
      // next resume re-evaluates the same step instead of skipping ahead.
      deps.database.pauseWorkflowStep(step.id);
      return deps.database.advanceWorkflowRunState(
        run.id,
        { currentStep: run.currentStep, state: outcome.state ?? run.state, status: "waiting_for_user" },
        now,
      );
    }
    if (outcome.status === "waiting") {
      deps.database.completeWorkflowStep(step.id, "succeeded", { output: outcome.output ?? null }, now);
      return deps.database.advanceWorkflowRunState(
        run.id,
        { currentStep: sequence, state: outcome.state, status: "waiting_for_user" },
        now,
      );
    }
    if (outcome.status === "done") {
      deps.database.completeWorkflowStep(step.id, "succeeded", { output: outcome.output ?? null }, now);
      return deps.database.finishWorkflowRun(
        run.id,
        "succeeded",
        { state: outcome.state ?? run.state, currentStep: sequence },
        now,
      );
    }
    if (outcome.status === "cancelled") {
      deps.database.completeWorkflowStep(step.id, "skipped", { output: outcome.output ?? null }, now);
      return deps.database.finishWorkflowRun(
        run.id,
        "cancelled",
        { state: outcome.state ?? run.state, currentStep: sequence },
        now,
      );
    }
    if (outcome.status === "failed") {
      deps.database.completeWorkflowStep(step.id, "failed", { error: outcome.error }, now);
      return deps.database.finishWorkflowRun(
        run.id,
        "failed",
        { error: outcome.error, currentStep: sequence },
        now,
      );
    }

    deps.database.completeWorkflowStep(step.id, "succeeded", { output: outcome.output ?? null }, now);
    run = deps.database.advanceWorkflowRunState(
      run.id,
      { currentStep: sequence, state: outcome.state ?? run.state },
      now,
    );
  }

  return deps.database.finishWorkflowRun(
    run.id,
    "failed",
    { error: `单个 run 连续执行超过 ${MAX_STEPS_PER_ADVANCE} 步，已停止。` },
    now,
  );
}

/**
 * Cancels a run and invalidates anything it was still waiting on.
 *
 * A cancelled run must not leave a usable approval behind: if the run still
 * references a pending or approved action, that action is rejected in the same
 * operation so a later click cannot write to the calendar.
 */
export async function cancelRun(
  deps: WorkflowRuntimeDeps,
  runId: string,
  now = new Date(),
): Promise<WorkflowRun> {
  const run = deps.database.getWorkflowRun(runId);
  if (!run) throw new Error(`找不到 workflow run：${runId}`);
  if (isTerminalWorkflowStatus(run.status)) return run;

  const approvalId = typeof run.state.approvalId === "string" ? run.state.approvalId : undefined;
  if (approvalId) {
    const action = deps.database.getWorkflowAction(approvalId);
    // The calendar write already happened: cancelling would misreport state, so
    // finish the run instead of pretending it was cancelled.
    if (action?.status === "executed") return await advanceRun(deps, run.id, now);
    if (action && (action.status === "pending" || action.status === "approved")) {
      deps.database.rejectWorkflowAction(approvalId);
    }
  }
  for (const step of deps.database.listWorkflowSteps(run.id)) {
    if (step.status === "pending" || step.status === "running") {
      deps.database.completeWorkflowStep(step.id, "skipped", { error: "workflow cancelled" }, now);
    }
  }
  return deps.database.cancelWorkflowRun(run.id, now);
}

/** Worker entry point: resumes runs that wait for the user or were abandoned mid-step. */export async function resumePendingRuns(
  deps: WorkflowRuntimeDeps,
  options: { now?: Date; limit?: number } = {},
): Promise<WorkflowRun[]> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 5;
  const candidates = [
    ...deps.database.listWorkflowRuns({ status: "waiting_for_user", limit }),
    ...deps.database.listWorkflowRuns({ status: "running", limit }),
  ].filter((run) => isResumable(run, now));
  const advanced: WorkflowRun[] = [];
  for (const run of candidates) {
    try {
      advanced.push(await advanceRun(deps, run.id, now));
    } catch {
      // A single bad run must not stop the worker; it keeps its persisted state.
    }
  }
  return advanced;
}

/** Resumes every waiting run that references one approved Calendar action. */
export async function resumeRunsForApproval(
  deps: WorkflowRuntimeDeps,
  approvalId: string,
  now = new Date(),
): Promise<WorkflowRun[]> {
  const runs = deps.database
    .listWorkflowRuns({ status: "waiting_for_user", limit: 20 })
    .filter((run) => run.state.approvalId === approvalId);
  const advanced: WorkflowRun[] = [];
  for (const run of runs) {
    try {
      advanced.push(await advanceRun(deps, run.id, now));
    } catch {
      // Keep the run persisted; the worker will retry on the next tick.
    }
  }
  return advanced;
}

export function isTerminalWorkflowStatus(status: WorkflowRunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

/** A run is resumable only when it is genuinely stuck, not when another executor owns it. */
function isResumable(run: WorkflowRun, now: Date): boolean {
  if (run.status === "waiting_for_user") return true;
  if (run.status === "running") return Date.parse(run.updatedAt) < now.getTime() - 5 * 60_000;
  return false;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "未知错误";
  return message.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]").slice(0, 1_000);
}
