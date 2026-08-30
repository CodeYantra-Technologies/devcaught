import { createFileRoute } from "@tanstack/react-router";
import { handleRaw } from "../../../../../apps/server/src/http/handlers";
import { ensureRuntime } from "../../../../../apps/server/src/runtime";
import { toResponse } from "@/lib/http-result";

export const Route = createFileRoute("/api/messages/$id/raw")({
  server: {
    handlers: {
      GET: async ({ params }) => toResponse(handleRaw(await ensureRuntime(), params.id)),
    },
  },
});
