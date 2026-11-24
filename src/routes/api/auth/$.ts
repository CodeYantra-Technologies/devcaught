import { createFileRoute } from "@tanstack/react-router";
import { handleAuthRequest } from "../../../lib/auth/http-handler.ts";

/** Auth unavailable or disabled stays 503. Rate limits run only after that. */
export async function handleAuthRoute(request: Request): Promise<Response> {
  try {
    const { auth, authConfigured } = await import("../../../lib/auth/server");
    if (!authConfigured) return Response.json({ error: "Authentication unavailable" }, { status: 503 });
    return await handleAuthRequest(request, auth);
  } catch {
    return Response.json({ error: "Authentication unavailable" }, { status: 503 });
  }
}

export const Route = createFileRoute("/api/auth/$")({
  server: { handlers: { GET: ({ request }) => handleAuthRoute(request), POST: ({ request }) => handleAuthRoute(request) } },
});
