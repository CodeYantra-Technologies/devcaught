import { createFileRoute } from "@tanstack/react-router";
import { VerifiedSessionBoundary } from "../components/auth/VerifiedSessionBoundary";

export const Route = createFileRoute("/account")({ component: Account });
function Account() {
  return <VerifiedSessionBoundary inboxRequired={false}>
    <main className="mx-auto max-w-md space-y-5 p-8">
      <h1 className="text-2xl">DevCaught account</h1>
      <p>You are signed in.</p>
      <a href="/">Open your private inbox</a>
    </main>
  </VerifiedSessionBoundary>;
}
