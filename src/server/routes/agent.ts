import type { Route } from "../context.js";
import { objectBody, optionalString } from "../http.js";
import { requiredMessage, sendAgentTurn } from "./conversations.js";

export const agentRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/api/agent/messages",
    async handler(request) {
      const body = objectBody(request.body);
      const message = requiredMessage(body.message);
      const conversationId = optionalString(body, "conversationId", "会话 ID", 100);
      return { body: await sendAgentTurn(request, conversationId, message) };
    },
  },
];
