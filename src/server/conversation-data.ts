import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { messageText } from "../agent/session.js";
import type { AgentConversation, AgentTranscriptEntry } from "../database.js";
import type { ConversationDto, TranscriptMessageDto } from "./types.js";

export function conversationDto(conversation: AgentConversation): ConversationDto {
  return {
    id: conversation.id,
    title: conversation.title,
    status: conversation.status,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastMessageAt: conversation.lastMessageAt,
    messageCount: conversation.messageCount,
  };
}

export function transcriptDto(entry: AgentTranscriptEntry): TranscriptMessageDto {
  return {
    id: entry.id,
    sequence: entry.sequence,
    role: entry.role as TranscriptMessageDto["role"],
    text: messageText(entry.message as AgentMessage),
    createdAt: entry.createdAt,
  };
}
