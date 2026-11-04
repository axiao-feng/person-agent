import { existsSync } from "node:fs";
import { join } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type { AppDatabase } from "../database.js";

export type AgentReferenceType = "paper" | "task" | "idea" | "lecture" | "approval";

/** A local object an answer was actually derived from. */
export type AgentReference = {
  type: AgentReferenceType;
  id: string;
  title: string;
};

export const MAX_REFERENCES = 20;

const REFERENCE_TYPES: readonly AgentReferenceType[] = ["paper", "task", "idea", "lecture", "approval"];

/**
 * Collects references from tool results of this turn only.
 *
 * The model's text never becomes a reference: entries are read from the
 * structured `references` metadata a tool returned, then re-verified against the
 * local database (or the Obsidian vault for ideas).
 */
export function collectAgentReferences(options: {
  database: AppDatabase;
  vaultPath?: string;
  messages: readonly AgentMessage[];
}): AgentReference[] {
  const collected: AgentReference[] = [];
  const seen = new Set<string>();
  for (const message of options.messages) {
    if (message.role !== "toolResult") continue;
    const references = referencesOf(message.details);
    for (const candidate of references) {
      const key = `${candidate.type}:${candidate.id}`;
      if (seen.has(key)) continue;
      if (!referenceExists(options, candidate)) continue;
      seen.add(key);
      collected.push(candidate);
      if (collected.length >= MAX_REFERENCES) return collected;
    }
  }
  return collected;
}

function referencesOf(details: unknown): AgentReference[] {
  if (!details || typeof details !== "object" || Array.isArray(details)) return [];
  const raw = (details as { references?: unknown }).references;
  if (!Array.isArray(raw)) return [];
  const references: AgentReference[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const type = record.type;
    const id = record.id;
    const title = record.title;
    if (typeof type !== "string" || !REFERENCE_TYPES.includes(type as AgentReferenceType)) continue;
    if (typeof id !== "string" || !id.trim() || id.length > 1_000) continue;
    if (typeof title !== "string" || !title.trim()) continue;
    references.push({
      type: type as AgentReferenceType,
      id: id.trim().slice(0, 1_000),
      title: title.trim().slice(0, 200),
    });
  }
  return references;
}

function referenceExists(
  options: { database: AppDatabase; vaultPath?: string },
  reference: AgentReference,
): boolean {
  switch (reference.type) {
    case "task":
      return Boolean(options.database.getResearchTask(reference.id));
    case "lecture":
      return Boolean(options.database.getLecture(reference.id));
    case "approval":
      return Boolean(options.database.getWorkflowAction(reference.id));
    case "paper":
      return Boolean(options.database.getZoteroPaper(reference.id));
    case "idea": {
      if (!options.vaultPath || !reference.id.trim()) return false;
      try {
        return existsSync(join(options.vaultPath, reference.id));
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}
