import { parseInstant } from "../schedule.js";
import { ApiError } from "./errors.js";

export function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "BAD_REQUEST", "请求体必须是 JSON 对象。");
  }
  return value as Record<string, unknown>;
}

export function requiredString(
  body: Record<string, unknown>,
  key: string,
  label: string,
  maximum = 200,
): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw validation(`${label}不能为空。`, key, `${label}不能为空。`);
  }
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw validation(`${label}不能超过 ${maximum} 个字符。`, key, `${label}不能超过 ${maximum} 个字符。`);
  }
  return normalized;
}

export function optionalString(
  body: Record<string, unknown>,
  key: string,
  label: string,
  maximum = 4_000,
): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw validation(`${label}必须是文本。`, key, `${label}必须是文本。`);
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maximum) {
    throw validation(`${label}不能超过 ${maximum} 个字符。`, key, `${label}不能超过 ${maximum} 个字符。`);
  }
  return normalized;
}

export function optionalInstantField(
  body: Record<string, unknown>,
  key: string,
  label: string,
): string | null | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw validation(`${label}必须是有效时间。`, key, `${label}必须是有效时间。`);
  }
  try {
    return parseInstant(value).toISOString();
  } catch {
    throw validation(`${label}必须包含时区偏移。`, key, `${label}必须包含时区偏移。`);
  }
}

export function optionalIntegerField(
  body: Record<string, unknown>,
  key: string,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (!(key in body) || body[key] === undefined || body[key] === null) return undefined;
  const value = body[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw validation(
      `${label}必须是 ${minimum} 到 ${maximum} 的整数。`,
      key,
      `${label}必须是 ${minimum} 到 ${maximum} 的整数。`,
    );
  }
  return value;
}

export function optionalBooleanField(
  body: Record<string, unknown>,
  key: string,
  label: string,
): boolean | undefined {
  if (!(key in body) || body[key] === undefined) return undefined;
  const value = body[key];
  if (typeof value !== "boolean") throw validation(`${label}必须是布尔值。`, key, `${label}必须是布尔值。`);
  return value;
}

export function enumField<T extends string>(
  body: Record<string, unknown>,
  key: string,
  label: string,
  allowed: readonly T[],
): T | undefined {
  if (!(key in body) || body[key] === undefined || body[key] === null) return undefined;
  const value = body[key];
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw validation(`${label}无效。`, key, `${label}无效。`);
  }
  return value as T;
}

export function requiredInstantQuery(query: URLSearchParams, name: string): Date {
  const value = query.get(name);
  if (!value) throw validation(`缺少 ${name} 参数。`, name, `缺少 ${name} 参数。`);
  try {
    return parseInstant(value);
  } catch {
    throw validation(`${name} 必须是带时区的 ISO 时间。`, name, `${name} 必须是带时区的 ISO 时间。`);
  }
}

export function optionalInstantQuery(query: URLSearchParams, name: string): Date | undefined {
  const value = query.get(name);
  if (!value) return undefined;
  try {
    return parseInstant(value);
  } catch {
    throw validation(`${name} 必须是带时区的 ISO 时间。`, name, `${name} 必须是带时区的 ISO 时间。`);
  }
}

export function integerQuery(
  query: URLSearchParams,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = query.get(name);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw validation(`${name} 必须是 ${minimum} 到 ${maximum} 的整数。`, name, `${name} 必须是 ${minimum} 到 ${maximum} 的整数。`);
  }
  return parsed;
}

export function validation(message: string, field?: string, fieldMessage?: string): ApiError {
  return new ApiError(
    422,
    "VALIDATION_FAILED",
    message,
    false,
    field ? { [field]: fieldMessage ?? message } : undefined,
  );
}

export function notFound(message: string): ApiError {
  return new ApiError(404, "NOT_FOUND", message);
}
