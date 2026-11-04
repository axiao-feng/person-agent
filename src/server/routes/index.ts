import type { Route } from "../context.js";
import { agentRoutes } from "./agent.js";
import { approvalRoutes } from "./approvals.js";
import { calendarRoutes } from "./calendar.js";
import { conversationRoutes } from "./conversations.js";
import { ideaRoutes } from "./ideas.js";
import { knowledgeRoutes } from "./knowledge.js";
import { lectureRoutes } from "./lectures.js";
import { paperRoutes } from "./papers.js";
import { searchRoutes } from "./search.js";
import { settingsRoutes } from "./settings.js";
import { systemRoutes } from "./system.js";
import { taskRoutes } from "./tasks.js";
import { todayRoutes } from "./today.js";

export const routes: Route[] = [
  ...systemRoutes,
  ...todayRoutes,
  ...taskRoutes,
  ...calendarRoutes,
  ...lectureRoutes,
  ...ideaRoutes,
  ...paperRoutes,
  ...knowledgeRoutes,
  ...approvalRoutes,
  ...settingsRoutes,
  ...searchRoutes,
  ...conversationRoutes,
  ...agentRoutes,
];
