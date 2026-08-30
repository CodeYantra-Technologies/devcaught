import type { HandlerResult } from "../../apps/server/src/http/handlers";

export function toResponse(result: HandlerResult): Response {
  if (result.text !== undefined) {
    return new Response(result.text, {
      status: result.status,
      headers: { "content-type": result.contentType ?? "text/plain; charset=utf-8" },
    });
  }
  return Response.json(result.body ?? {}, { status: result.status });
}
