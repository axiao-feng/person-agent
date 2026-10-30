import type { Route } from "../context.js";
import { buildTodaySnapshot } from "../today.js";

export const todayRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/api/today",
    async handler(request) {
      const date = request.query.get("date") ?? undefined;
      return {
        body: await buildTodaySnapshot({
          config: request.runtime.config,
          database: request.database,
          calendar: request.services.calendar,
          now: () => new Date(),
          requestId: request.requestId,
          ...(date ? { date } : {}),
          ...(request.services.weather ? { weather: request.services.weather } : {}),
        }),
      };
    },
  },
];
