import { createFileRoute } from "@tanstack/react-router";
import { handlePrivateInboxRequest } from "@/lib/inbox/private-inbox-api.server";

export const Route = createFileRoute("/api/messages/$id")({
  server: {
    handlers: {
      GET: ({ request, params }) => handlePrivateInboxRequest(request, "detail", params.id),
      DELETE: ({ request, params }) => handlePrivateInboxRequest(request, "delete", params.id),
    },
  },
});
