import { AppDatabase, type ResearchTask, type TaskKind } from "../database.js";

export class TaskTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskTransitionError";
  }
}

export type TaskCommand = "start" | "complete" | "cancel";

export type TaskEdit = {
  title?: string;
  taskKind?: TaskKind;
  deadline?: string | null;
  estimatedMinutes?: number;
  priority?: ResearchTask["priority"];
};

/**
 * Applies the state machine from docs/03-domain-data-model.md. Clients submit
 * commands, never an arbitrary target status.
 */
export function applyTaskCommand(
  database: AppDatabase,
  id: string,
  command: TaskCommand,
  now = new Date(),
): ResearchTask {
  const task = database.getResearchTask(id);
  if (!task) throw new TaskTransitionError(`找不到科研任务：${id}`);
  if (task.status === "completed" || task.status === "cancelled") {
    throw new TaskTransitionError("已完成或已取消的任务不能继续修改。");
  }
  if (command === "start") {
    if (task.status !== "draft" && task.status !== "planned" && task.status !== "needs_replan") {
      throw new TaskTransitionError(`当前状态 ${task.status} 不能开始。`);
    }
    return database.updateResearchTask(id, { status: "in_progress" }, now);
  }
  if (command === "complete") {
    if (task.status !== "in_progress") {
      throw new TaskTransitionError("只有进行中的任务可以标记为完成，请先开始任务。");
    }
    return database.updateResearchTask(id, { status: "completed" }, now);
  }
  if (task.status === "in_progress" || task.status === "planned" || task.status === "draft" || task.status === "needs_replan") {
    return database.updateResearchTask(id, { status: "cancelled" }, now);
  }
  throw new TaskTransitionError(`当前状态 ${task.status} 不能取消。`);
}

export function editTask(
  database: AppDatabase,
  id: string,
  edit: TaskEdit,
  now = new Date(),
): ResearchTask {
  const task = database.getResearchTask(id);
  if (!task) throw new TaskTransitionError(`找不到科研任务：${id}`);
  if (task.status === "completed" || task.status === "cancelled") {
    throw new TaskTransitionError("已完成或已取消的任务不能编辑。");
  }
  if (
    edit.title === undefined &&
    edit.taskKind === undefined &&
    edit.deadline === undefined &&
    edit.estimatedMinutes === undefined &&
    edit.priority === undefined
  ) {
    throw new TaskTransitionError("至少提供一个要修改的字段。");
  }
  return database.updateResearchTask(id, edit, now);
}
