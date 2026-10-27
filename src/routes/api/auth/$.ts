import { createFileRoute } from "@tanstack/react-router";
import { handleAuthRequest } from "../../../lib/auth/http-handler.ts";

async function handle({ request }: { request: Request }) {
  try {
    const { auth, authConfigured } = await import("../../../lib/auth/server");
    if (!authConfigured) return Response.json({ error: "Authentication unavailable" }, { status: 503 });
    return await handleAuthRequest(request, auth);
  } catch {
    return Response.json({ error: "Authentication unavailable" }, { status: 503 });
  }
}

export const Route = createFileRoute("/api/auth/$")({
  server: { handlers: { GET: handle, POST: handle } },
});
