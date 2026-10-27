import { useState, type FormEvent } from "react";
import { BrowserAccessError, submitBrowserAuth } from "../../lib/auth/browser-session.ts";

/** Invitation secrets are entered directly, never put in a URL or local storage. */
export function AuthPage({ registration = false }: { registration?: boolean }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [registered, setRegistered] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const body = {
      email: String(fields.get("email")), password: String(fields.get("password")),
      ...(registration ? { name: String(fields.get("name")), invitationToken: String(fields.get("invitationToken")) } : {}),
    };
    setBusy(true);
    setError("");
    try {
      await submitBrowserAuth(registration, body);
      form.reset();
      if (registration) setRegistered(true);
      else window.location.replace("/");
    } catch (failure) {
      setError(failure instanceof BrowserAccessError && failure.status >= 500
        ? "Authentication is temporarily unavailable. Please try again later."
        : "Authentication could not be completed. Check your details or try again later.");
    }
    finally { setBusy(false); }
  }
  return <main className="mx-auto max-w-md space-y-5 p-8">
    <h1 className="text-2xl">{registration ? "Accept your invitation" : "Sign in to DevCaught"}</h1>
    {registered ? <p>Registration completed. <a href="/login">Sign in</a>.</p> :
      <form onSubmit={submit} className="flex flex-col gap-4">
        {registration && <label>Name<input className="block w-full border p-2" name="name" required maxLength={120} autoComplete="name" /></label>}
        <label>Email<input className="block w-full border p-2" name="email" type="email" required maxLength={254} autoComplete="email" /></label>
        <label>Password<input className="block w-full border p-2" name="password" type="password" required minLength={registration ? 12 : 1} maxLength={128} autoComplete={registration ? "new-password" : "current-password"} /></label>
        {registration && <label>Invitation token<input className="block w-full border p-2" name="invitationToken" type="password" required minLength={43} maxLength={43} autoComplete="off" /></label>}
        {error && <p role="alert">{error}</p>}
        <button className="border p-2" disabled={busy}>{busy ? "Please wait…" : registration ? "Create account" : "Sign in"}</button>
      </form>}
    <p><a href={registration ? "/login" : "/register"}>{registration ? "Already registered? Sign in" : "Have an invitation? Register"}</a></p>
  </main>;
}
