import { createFileRoute } from "@tanstack/react-router";
import { handleTestEmail } from "../../../../apps/server/src/http/handlers";
import { ensureRuntime } from "../../../../apps/server/src/runtime";
import { toResponse } from "@/lib/http-result";

export const Route = createFileRoute("/api/messages/test")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await request.json();
        return toResponse(handleTestEmail(await ensureRuntime(), body));
      },
    },
  },
});
