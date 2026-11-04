import type { AppDatabase, WorkflowRun } from "../database.js";

/** The outcome a workflow step reports back to the runtime. */
export type WorkflowStepOutcome =
  | { status: "continue"; output?: unknown; state?: Record<string, unknown> }
  /** The step finished its work; the run waits for the user before the next step. */
  | { status: "waiting"; output?: unknown; state: Record<string, unknown> }
  /** The step cannot finish yet; the same step is retried on the next resume. */
  | { status: "poll"; output?: unknown; state?: Record<string, unknown> }
  | { status: "done"; output?: unknown; state?: Record<string, unknown> }
  | { status: "cancelled"; output?: unknown; state?: Record<string, unknown> }
  | { status: "failed"; error: string };

export type WorkflowStepContext = {
  database: AppDatabase;
  run: WorkflowRun;
  step: {
    sequence: number;
    kind: string;
    idempotencyKey: string;
  };
  now: Date;
};

export type WorkflowStepDefinition = {
  kind: string;
  /**
   * Must be idempotent: the runtime may run it again after a crash.
   * Local writes should rely on database uniqueness, and external writes must
   * always go through a persisted `workflow_actions` approval.
   */
  execute: (context: WorkflowStepContext) => Promise<WorkflowStepOutcome> | WorkflowStepOutcome;
};

export type WorkflowDefinition = {
  kind: string;
  steps: WorkflowStepDefinition[];
};

export type WorkflowRegistry = Map<string, WorkflowDefinition>;

/** Hard stop so a faulty handler cannot loop forever inside one advance call. */
export const MAX_STEPS_PER_ADVANCE = 20;
