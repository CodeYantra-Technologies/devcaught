import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/inbox/AppShell";
import { SettingsPage } from "@/components/inbox/SettingsPage";

export const Route = createFileRoute("/settings")({ component: Settings });

function Settings() {
  return (
    <AppShell>
      <SettingsPage />
    </AppShell>
  );
}
