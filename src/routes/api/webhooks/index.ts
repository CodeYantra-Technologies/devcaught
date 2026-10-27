import { requireGenericWebhookAccess } from "../../../../apps/server/src/http/access-policy";
import { createFileRoute } from "@tanstack/react-router";
import { captureWebhook } from "../../../../apps/server/src/http/webhookRequest";

export const Route = createFileRoute("/api/webhooks/")({
  server: { handlers: { POST: ({ request }) => {
    const access = requireGenericWebhookAccess();
    if (!access.allowed) {
      return Response.json(
        { error: access.error },
        { status: access.status },
      );
    }
    return captureWebhook(request);
  } } },
});
