import { ensureRuntime } from "../runtime.ts";
import { normalizeWebhook, WEBHOOK_SIZE_LIMIT } from "../ingest/normalizeWebhook.ts";

/** Stream with a cap: Content-Length is optional and cannot be trusted. */
export async function captureWebhook(request: Request): Promise<Response> {
  if (
    request.headers.has("content-encoding") &&
    request.headers.get("content-encoding") !== "identity"
  ) {
    return Response.json({ error: "Unsupported content encoding" }, { status: 415 });
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > WEBHOOK_SIZE_LIMIT) {
        await reader.cancel();
        return Response.json({ error: "Request exceeds 1 MB limit" }, { status: 413 });
      }
      chunks.push(value);
    }
  }
  const url = new URL(request.url);
  const runtime = await ensureRuntime();
  const stored = runtime.inbox.ingest(
    normalizeWebhook({
      method: request.method,
      url: url.pathname + url.search,
      headers: Object.fromEntries(request.headers),
      body: Buffer.concat(chunks).toString("utf8"),
    }),
  );
  return Response.json({ id: stored.id, ok: true }, { status: 201 });
}
