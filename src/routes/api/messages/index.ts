import { createFileRoute } from "@tanstack/react-router";
import { handleList } from "../../../../apps/server/src/http/handlers";
import { ensureRuntime } from "../../../../apps/server/src/runtime";
import { toResponse } from "@/lib/http-result";

export const Route = createFileRoute("/api/messages/")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const q = url.searchParams.get("q") ?? undefined;
        return toResponse(handleList(await ensureRuntime(), q));
      },
    },
  },
});
