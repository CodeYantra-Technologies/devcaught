import { createFileRoute } from "@tanstack/react-router";
import { LocalInboxPage } from "@/components/local-inbox/LocalInboxPage";

export const Route = createFileRoute("/local-inbox")({ component: LocalInboxPage });
