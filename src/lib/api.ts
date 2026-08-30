import type {
  DevCaughtStatus,
  MessageDetail,
  MessageSummary,
  TestEmailInput,
} from "../../packages/shared/src/types";

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export async function fetchMessages(query = ""): Promise<MessageSummary[]> {
  const params = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
  const body = await readJson<{ messages: MessageSummary[] }>(
    await fetch(`/api/messages${params}`),
  );
  return body.messages;
}

export async function fetchMessage(id: string): Promise<MessageDetail> {
  return readJson<MessageDetail>(await fetch(`/api/messages/${id}`));
}

export async function fetchRaw(id: string): Promise<string> {
  const response = await fetch(`/api/messages/${id}/raw`);
  if (!response.ok) throw new Error("Raw message not found");
  return response.text();
}

export async function deleteMessage(id: string): Promise<void> {
  await readJson(await fetch(`/api/messages/${id}`, { method: "DELETE" }));
}

export async function clearInbox(): Promise<void> {
  await readJson(await fetch("/api/messages/clear", { method: "POST" }));
}

export async function sendTestEmail(input: TestEmailInput): Promise<MessageDetail> {
  return readJson<MessageDetail>(
    await fetch("/api/messages/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function fetchStatus(): Promise<DevCaughtStatus> {
  return readJson<DevCaughtStatus>(await fetch("/api/status"));
}
