import { z } from "zod";
import { PRODUCT_NAME } from "../../../../packages/shared/src/constants.ts";
import type { DevCaughtRuntime } from "../runtime.ts";

export interface HandlerResult {
  status: number;
  body?: unknown;
  text?: string;
  contentType?: string;
}

const idSchema = z.string().uuid();

const testEmailSchema = z.object({
  from: z.string().trim().min(1).max(500),
  to: z.string().trim().min(1).max(500),
  subject: z.string().max(500).default(""),
  text: z.string().max(100_000).default(""),
  html: z.string().max(200_000).optional(),
});

export function handleHealth(): HandlerResult {
  return { status: 200, body: { ok: true, product: PRODUCT_NAME } };
}

export function handleStatus(runtime: DevCaughtRuntime): HandlerResult {
  return {
    status: 200,
    body: {
      product: PRODUCT_NAME,
      smtp: runtime.smtp.status,
      http: runtime.http,
      messageCount: runtime.store.count(),
      db: {
        path: runtime.dbMode === "memory" ? ":memory:" : runtime.config.dbPath,
        mode: runtime.dbMode,
      },
    },
  };
}

export function handleList(runtime: DevCaughtRuntime, query?: string): HandlerResult {
  return { status: 200, body: { messages: runtime.store.list(query) } };
}

export function handleGet(runtime: DevCaughtRuntime, id: string): HandlerResult {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) return { status: 400, body: { error: "Invalid message id" } };
  const message = runtime.store.get(parsed.data);
  if (!message) return { status: 404, body: { error: "Message not found" } };
  return { status: 200, body: message };
}

export function handleRaw(runtime: DevCaughtRuntime, id: string): HandlerResult {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) return { status: 400, body: { error: "Invalid message id" } };
  const raw = runtime.store.getRaw(parsed.data);
  if (raw === null) return { status: 404, body: { error: "Message not found" } };
  return { status: 200, text: raw, contentType: "text/plain; charset=utf-8" };
}

export function handleDelete(runtime: DevCaughtRuntime, id: string): HandlerResult {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) return { status: 400, body: { error: "Invalid message id" } };
  const deleted = runtime.store.delete(parsed.data);
  if (!deleted) return { status: 404, body: { error: "Message not found" } };
  return { status: 200, body: { ok: true } };
}

export function handleClear(runtime: DevCaughtRuntime): HandlerResult {
  const deleted = runtime.store.clear();
  return { status: 200, body: { ok: true, deleted } };
}

export function handleTestEmail(runtime: DevCaughtRuntime, input: unknown): HandlerResult {
  const parsed = testEmailSchema.safeParse(input);
  if (!parsed.success) {
    return { status: 400, body: { error: "Invalid test email", details: parsed.error.flatten() } };
  }
  const stored = runtime.inbox.ingest(runtime.normalizeTestEmail(parsed.data));
  const detail = runtime.store.get(stored.id);
  return { status: 201, body: detail };
}
