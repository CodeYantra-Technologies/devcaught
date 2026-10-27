import { createFileRoute } from "@tanstack/react-router";
import { handlePrivateInboxRequest } from "@/lib/inbox/private-inbox-api.server";

export const Route = createFileRoute("/api/messages/$id/raw")({
  server: {
    handlers: {
      GET: ({ request, params }) => handlePrivateInboxRequest(request, "raw", params.id),
    },
  },
});
