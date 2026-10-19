import { realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, resolve, sep } from "node:path";

import type { SevdeskClient } from "../client.js";
import type { Config } from "../config.js";

export interface ToolContext {
  client: SevdeskClient;
  config: Config;
}

/** Plain JSON — the SDK's tool schema type accepts nothing looser. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ToolDef {
  name: string;
  title?: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, JsonValue>;
    required?: string[];
    additionalProperties?: boolean;
  };
  /** Declared so clients (and the read-only gate) know before calling. */
  mutating: boolean;
  /**
   * Keep the tool listed and callable in read-only mode even though it is
   * declared mutating — for tools that decide per call (sevdesk_call also
   * covers reads; its writes are still refused at the client layer).
   */
  listInReadOnly?: boolean;
  /** Irreversible writes (deletes) — sets the MCP destructiveHint. */
  destructive?: boolean;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

/** One rule for every write tool: a per-call dryRun argument or the global flag. */
export function isDryRun(args: Record<string, unknown>, ctx: ToolContext): boolean {
  return (optBool(args, "dryRun") ?? false) || ctx.config.dryRun;
}

/**
 * Enforce the SEVDESK_RECEIPT_DIRS allowlist. Filesystem access is disabled
 * until the user names directories explicitly; paths outside them are refused.
 * Containment is checked on real paths, so a symlink inside an allowlisted
 * directory cannot lead out of it. The target must exist (every caller reads
 * a file or directory); the real path is returned and must be used for I/O.
 */
export async function assertAllowedPath(ctx: ToolContext, filePath: string): Promise<string> {
  if (!isAbsolute(filePath)) throw new Error("File path must be absolute.");
  const allow = ctx.config.allowedReceiptDirs;
  if (allow.length === 0) {
    throw new Error(
      "Refused: filesystem access is disabled by default. Set SEVDESK_RECEIPT_DIRS to an " +
        `allowlist of absolute directories (separated by '${delimiter}') to enable the receipt file tools.`,
    );
  }
  let target: string;
  try {
    target = await realpath(resolve(filePath));
  } catch {
    throw new Error(`Not found: ${resolve(filePath)}`);
  }
  const roots = (
    await Promise.all(allow.map((a) => realpath(resolve(a)).catch(() => null)))
  ).filter((r): r is string => r !== null);
  const ok = roots.some((r) => target === r || target.startsWith(r.endsWith(sep) ? r : r + sep));
  if (!ok) {
    throw new Error(`Refused: ${target} is outside SEVDESK_RECEIPT_DIRS (${allow.join(", ")}).`);
  }
  return target;
}

/** {@link assertAllowedPath} for callers that need an existing directory. */
export async function assertAllowedDir(ctx: ToolContext, dirPath: string): Promise<string> {
  const real = await assertAllowedPath(ctx, dirPath);
  if (!(await stat(real).catch(() => null))?.isDirectory()) throw new Error(`Not a directory: ${real}`);
  return real;
}

export const str = (description: string, extra: Record<string, JsonValue> = {}) => ({
  type: "string",
  description,
  ...extra,
});

export const int = (description: string, extra: Record<string, JsonValue> = {}) => ({
  type: "integer",
  description,
  ...extra,
});

export const bool = (description: string, extra: Record<string, JsonValue> = {}) => ({
  type: "boolean",
  description,
  ...extra,
});

export const obj = (description: string) => ({
  type: "object",
  description,
  additionalProperties: true,
});

export function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`Missing required string argument '${key}'.`);
  }
  return v.trim();
}

export function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

export function optNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function optBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (["true", "1", "yes"].includes(v.toLowerCase())) return true;
    if (["false", "0", "no"].includes(v.toLowerCase())) return false;
  }
  return undefined;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The `positions` array with every entry checked to be an object — no raw TypeErrors later. */
export function positionObjects(args: Record<string, unknown>): Record<string, unknown>[] {
  const list = Array.isArray(args.positions) ? (args.positions as unknown[]) : [];
  list.forEach((p, i) => {
    if (!isPlainObject(p)) throw new Error(`Position ${i + 1}: must be an object.`);
  });
  return list as Record<string, unknown>[];
}

const ID_PATTERN = /^\d+$/;

/**
 * A sevDesk id as a string: a non-negative integer or a digit-only string.
 * Ids end up in URL paths and object references, so nothing else gets through.
 */
export function requireId(args: Record<string, unknown>, key: string): string {
  const id = optId(args, key);
  if (id === undefined) throw new Error(`${key} must be a numeric id.`);
  return id;
}

/** Like {@link requireId} but absent/empty is fine; present-and-malformed is refused. */
export function optId(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v === "string" && ID_PATTERN.test(v.trim())) return v.trim();
  throw new Error(`${key} must be a numeric id.`);
}

/**
 * A number argument clamped to [min, max]; absent or non-numeric falls back to
 * the (clamped) default. With `integer`, fractions are floored first.
 */
export function optRange(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
  integer = false,
): number {
  let n = optNumber(args, key) ?? fallback;
  if (integer) n = Math.floor(n);
  return Math.min(max, Math.max(min, n));
}

/**
 * A result-size argument: floored and clamped to [1, max], so `-1` or `1e9`
 * cannot slice off the wrong rows or walk the whole ledger.
 */
export function optLimit(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
  return optRange(args, key, fallback, 1, max, true);
}

/** A tax rule id given as a string or a whole number (models often send 12 instead of "12"). */
export function optRuleId(args: Record<string, unknown>, key = "taxRuleId"): string | undefined {
  const v = args[key];
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
  return optString(args, key);
}

