export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class MethodNotAllowedError extends ApiError {
  constructor(readonly allowed: string[]) {
    super(405, "METHOD_NOT_ALLOWED", "该接口不支持此请求方法。");
    this.name = "MethodNotAllowedError";
  }
}

export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConfiguredError";
  }
}

export function safeErrorMessage(error: unknown, fallback = "操作失败，请稍后重试。"): string {
  const message = error instanceof Error ? error.message : fallback;
  return message
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}
