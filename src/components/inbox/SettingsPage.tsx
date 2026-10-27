import { useQuery } from "@tanstack/react-query";
import { fetchStatus } from "@/lib/api";
import { useVerifiedUser } from "../auth/VerifiedSessionBoundary";
import { privateInboxKey } from "../../lib/inbox/browser-access.ts";
import { TestEmailForm } from "./TestEmailForm";

export function SettingsPage() {
  const user = useVerifiedUser();
  const status = useQuery({
    queryKey: privateInboxKey(user.id, "status"),
    queryFn: ({ signal }) => fetchStatus(signal),
    refetchInterval: 4000,
  });
  return <div className="h-full overflow-auto px-5 py-6">
    <h1 className="text-2xl">Private inbox settings</h1>
    <p className="mt-3">{status.data ? `${status.data.messageCount} messages in your private inbox.` : "Checking inbox…"}</p>
    {status.error && <p role="alert">{status.error.message}</p>}
    <section className="mt-6 max-w-2xl space-y-4 rounded-lg border p-5">
      <h2 className="text-lg">Create a private test email</h2>
      <p>Test messages are saved only to your signed-in account.</p>
      <TestEmailForm />
    </section>
    <p className="mt-6">Private SMTP, SMS and webhook routing are not enabled yet.</p>
  </div>;
}
