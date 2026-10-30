import type { Route } from "../context.js";
import { safeErrorMessage } from "../errors.js";
import {
  objectBody,
  optionalBooleanField,
  optionalInstantField,
  optionalInstantQuery,
  optionalString,
  requiredString,
  validation,
} from "../http.js";

export const lectureRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/api/lectures",
    async handler(request) {
      const start = optionalInstantQuery(request.query, "start");
      const end = optionalInstantQuery(request.query, "end");
      return { body: { items: request.database.listLectures(start, end) } };
    },
  },
  {
    method: "POST",
    pattern: "/api/lectures",
    async handler(request) {
      const body = objectBody(request.body);
      const title = requiredString(body, "title", "讲座标题");
      const startAt = optionalInstantField(body, "startAt", "开始时间");
      if (!startAt) throw validation("开始时间不能为空。", "startAt", "开始时间不能为空。");
      const endAt = optionalInstantField(body, "endAt", "结束时间");
      const location = optionalString(body, "location", "地点", 500);
      const speaker = optionalString(body, "speaker", "主讲人", 200);
      const notes = optionalString(body, "notes", "备注", 4_000);
      const requiresPresentation = optionalBooleanField(body, "requiresPresentation", "是否汇报") ?? false;
      try {
        const lecture = request.database.createLecture(
          {
            title,
            startAt,
            ...(endAt ? { endAt } : {}),
            ...(location ? { location } : {}),
            ...(speaker ? { speaker } : {}),
            ...(notes ? { notes } : {}),
            requiresPresentation,
          },
          request.now,
        );
        return { status: 201, body: { lecture } };
      } catch (error) {
        throw validation(safeErrorMessage(error, "讲座保存失败。"));
      }
    },
  },
];
