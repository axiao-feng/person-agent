import { randomUUID } from "node:crypto";

import type { Route } from "../context.js";
import { ApiError, safeErrorMessage } from "../errors.js";
import { objectBody, validation } from "../http.js";

export const agentRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/api/agent/messages",
    async handler(request) {
      const body = objectBody(request.body);
      const message = body.message;
      if (typeof message !== "string" || !message.trim()) {
        throw validation("消息不能为空。", "message", "消息不能为空。");
      }
      if (message.length > 20_000) {
        throw validation("消息不能超过 20000 个字符。", "message", "消息不能超过 20000 个字符。");
      }
      try {
        const answer = await request.services.agent(request, message.trim());
        return {
          body: {
            conversationId: randomUUID(),
            answer,
            references: [],
          },
        };
      } catch (error) {
        throw new ApiError(
          503,
          "DEPENDENCY_UNAVAILABLE",
          safeErrorMessage(error, "Agent 暂时不可用。"),
          true,
        );
      }
    },
  },
];
