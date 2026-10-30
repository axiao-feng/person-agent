import type { Route } from "../context.js";
import { collectHealth } from "../health.js";

export const systemRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/api/health",
    async handler(request) {
      return {
        body: await collectHealth({
          paths: request.paths,
          config: request.runtime.config,
          database: request.database,
          startedAt: request.startedAt,
          requestId: request.requestId,
          now: () => new Date(),
          ...(request.services.probes ? { probes: request.services.probes } : {}),
        }),
      };
    },
  },
];
