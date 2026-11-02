import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/inbox/AppShell";
import { InboxPage } from "@/components/inbox/InboxPage";
import { beforeLoadInboxRoute } from "@/lib/inbox-mode-navigation";

export const Route = createFileRoute("/")({
  beforeLoad: beforeLoadInboxRoute,
  component: Home,
});

function Home() {
  return (
    <AppShell>
      <InboxPage />
    </AppShell>
  );
}
