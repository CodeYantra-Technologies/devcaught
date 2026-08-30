import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/inbox/AppShell";
import { InboxPage } from "@/components/inbox/InboxPage";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <AppShell>
      <InboxPage />
    </AppShell>
  );
}
