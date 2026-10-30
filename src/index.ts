export { createAssistant, generateText, promptForText } from "./agent.js";
export type { AppConfig } from "./config.js";
export { AppDatabase } from "./database.js";
export type {
  Lecture,
  LectureInput,
  PaperAnalysis,
  ReminderInput,
  ResearchTask,
  ResearchTaskInput,
  ResearchTaskStatus,
  ScheduledJob,
  TaskKind,
  WorkflowAction,
  WorkflowActionKind,
  WorkflowActionStatus,
  ZoteroPaper,
  ZoteroPaperMetadata,
} from "./database.js";
export { generateKnowledgeDigest } from "./knowledge/digest.js";
export { createIdeaNote, ensureKnowledgeVault } from "./knowledge/vault.js";
export { HttpZoteroClient, syncZotero } from "./knowledge/zotero.js";
export { buildTools } from "./tools.js";
export type { ToolContext, ToolModule } from "./tools.js";
