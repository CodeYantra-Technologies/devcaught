import { createFileRoute } from "@tanstack/react-router";
import { handleDelete, handleGet } from "../../../../apps/server/src/http/handlers";
import { ensureRuntime } from "../../../../apps/server/src/runtime";
import { toResponse } from "@/lib/http-result";

export const Route = createFileRoute("/api/messages/$id")({
  server: {
    handlers: {
      GET: async ({ params }) => toResponse(handleGet(await ensureRuntime(), params.id)),
      DELETE: async ({ params }) => toResponse(handleDelete(await ensureRuntime(), params.id)),
    },
  },
});
