import type { Route } from "./context.js";

export type RouteLookup =
  | { route: Route; params: Record<string, string> }
  | { allowed: string[] };

export function matchPath(pattern: string, path: string): Record<string, string> | undefined {
  const patternParts = split(pattern);
  const pathParts = split(path);
  if (patternParts.length !== pathParts.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index]!;
    const actual = pathParts[index]!;
    if (expected.startsWith(":")) {
      if (!actual) return undefined;
      try {
        params[expected.slice(1)] = decodeURIComponent(actual);
      } catch {
        return undefined;
      }
    } else if (expected !== actual) {
      return undefined;
    }
  }
  return params;
}

export function findRoute(routes: Route[], method: string, path: string): RouteLookup | undefined {
  const allowed: string[] = [];
  let match: { route: Route; params: Record<string, string> } | undefined;
  for (const route of routes) {
    const params = matchPath(route.pattern, path);
    if (!params) continue;
    allowed.push(route.method);
    if (route.method === method) match = { route, params };
  }
  if (match) return match;
  return allowed.length ? { allowed: [...new Set(allowed)] } : undefined;
}

function split(value: string): string[] {
  return value.split("/").filter(Boolean);
}
