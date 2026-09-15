import { createFileRoute } from "@tanstack/react-router";
import { captureWebhook } from "../../../../apps/server/src/http/webhookRequest";

export const Route = createFileRoute("/api/webhooks/")({
  server: { handlers: { POST: ({ request }) => captureWebhook(request) } },
});
