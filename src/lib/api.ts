import type {
  MessageDetail,
  MessageSummary,
  TestEmailInput,
} from "../../packages/shared/src/types";

import { notifyPrivateAccess, privateRequest } from "./inbox/browser-access.ts";
import { BrowserAccessError } from "./auth/browser-session.ts";

export type PrivateInboxStatus = { product: string; messageCount: number };

async function readJson<T>(response: Response): Promise<T> {
  try { return await response.json() as T; }
  catch {
    notifyPrivateAccess(503);
    throw new BrowserAccessError(503);
  }
}

export async function fetchMessages(query = "", signal?: AbortSignal): Promise<MessageSummary[]> {
  const params = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
  const body = await readJson<{ messages: MessageSummary[] }>(
    await privateRequest(`/api/messages${params}`, { signal }),
  );
  return body.messages;
}

export async function fetchMessage(id: string, signal?: AbortSignal): Promise<MessageDetail> {
  return readJson<MessageDetail>(await privateRequest(`/api/messages/${encodeURIComponent(id)}`, { signal }));
}

export async function fetchRaw(id: string, signal?: AbortSignal): Promise<string> {
  const response = await privateRequest(`/api/messages/${encodeURIComponent(id)}/raw`, { signal });
  return response.text();
}

export async function deleteMessage(id: string): Promise<void> {
  await readJson(await privateRequest(`/api/messages/${encodeURIComponent(id)}`, { method: "DELETE" }));
}

export async function clearInbox(): Promise<void> {
  await readJson(await privateRequest("/api/messages/clear", { method: "POST" }));
}

export async function sendTestEmail(input: TestEmailInput): Promise<MessageDetail> {
  return readJson<MessageDetail>(
    await privateRequest("/api/messages/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function fetchStatus(signal?: AbortSignal): Promise<PrivateInboxStatus> {
  const status = await readJson<PrivateInboxStatus>(await privateRequest("/api/status", { signal }));
  if (!status || typeof status.product !== "string" || !Number.isSafeInteger(status.messageCount) || status.messageCount < 0) {
    notifyPrivateAccess(503);
    throw new BrowserAccessError(503);
  }
  return status;
}
