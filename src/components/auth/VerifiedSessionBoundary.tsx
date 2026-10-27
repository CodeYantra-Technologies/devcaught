import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { readBrowserSession, BrowserAccessError, type BrowserUser } from "../../lib/auth/browser-session.ts";
import { signOut } from "../../lib/auth/client";
import { fetchStatus } from "../../lib/api";
import { PRIVATE_ACCESS_EVENT } from "../../lib/inbox/browser-access.ts";

const UserContext = createContext<BrowserUser | null>(null);
export function useVerifiedUser() {
  const user = useContext(UserContext);
  if (!user) throw new Error("Verified session required");
  return user;
}

type State = { kind: "loading" | "ready" | "unauthorized" | "forbidden" | "unavailable"; user?: BrowserUser };

export function VerifiedSessionBoundary({ children, inboxRequired = true }: { children: ReactNode; inboxRequired?: boolean }) {
  const client = useQueryClient();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [signingOut, setSigningOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const content = useRef<HTMLDivElement>(null);
  const check = useRef<() => void>(() => {});
  const cancelCheck = useRef<() => void>(() => {});
  const logoutInFlight = useRef(false);

  async function clearPrivateData() {
    await client.cancelQueries({ queryKey: ["private-inbox"] });
    client.removeQueries({ queryKey: ["private-inbox"] });
    client.getMutationCache().clear();
  }

  useEffect(() => {
    let controller: AbortController | undefined;
    let live = true;
    let lastUser: BrowserUser | undefined;
    const reset = async () => {
      await client.cancelQueries({ queryKey: ["private-inbox"] });
      client.removeQueries({ queryKey: ["private-inbox"] });
      client.getMutationCache().clear();
    };
    const verify = async () => {
      if (logoutInFlight.current) return;
      controller?.abort();
      const active = new AbortController();
      controller = active;
      if (content.current) content.current.hidden = true;
      setState({ kind: "loading", user: lastUser });
      try {
        const user = await readBrowserSession(active.signal);
        if (!live || active.signal.aborted) return;
        if (!user) {
          lastUser = undefined;
          await reset();
          if (!live || active.signal.aborted) return;
          setState({ kind: "unauthorized" });
          window.location.replace("/login");
          return;
        }
        if (lastUser?.id !== user.id) await reset();
        lastUser = user;
        if (inboxRequired) await fetchStatus(active.signal);
        if (live && !active.signal.aborted) setState({ kind: "ready", user });
      } catch (error) {
        if (!live || active.signal.aborted) return;
        await reset();
        if (!live || active.signal.aborted) return;
        const status = error instanceof BrowserAccessError ? error.status : 503;
        setState({ kind: status === 401 ? "unauthorized" : status === 403 ? "forbidden" : "unavailable", user: status === 401 ? undefined : lastUser });
        if (status === 401) window.location.replace("/login");
      }
    };
    const accessLost = (event: Event) => {
      const status = (event as CustomEvent<number>).detail;
      if (content.current) content.current.hidden = true;
      void reset();
      setState({ kind: status === 401 ? "unauthorized" : status === 403 ? "forbidden" : "unavailable", user: status === 401 ? undefined : lastUser });
      if (status === 401) {
        controller?.abort();
        window.location.replace("/login");
      }
    };
    const pageHide = () => {
      controller?.abort();
      if (content.current) content.current.hidden = true;
      void reset();
    };
    const pageShow = (event: PageTransitionEvent) => { if (event.persisted) void verify(); };
    const visible = () => { if (document.visibilityState === "visible") void verify(); };
    check.current = () => { void verify(); };
    cancelCheck.current = () => controller?.abort();
    window.addEventListener(PRIVATE_ACCESS_EVENT, accessLost);
    window.addEventListener("pagehide", pageHide);
    window.addEventListener("pageshow", pageShow);
    window.addEventListener("focus", check.current);
    document.addEventListener("visibilitychange", visible);
    void verify();
    const focus = check.current;
    return () => {
      live = false;
      controller?.abort();
      window.removeEventListener(PRIVATE_ACCESS_EVENT, accessLost);
      window.removeEventListener("pagehide", pageHide);
      window.removeEventListener("pageshow", pageShow);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [client, inboxRequired]);

  return <div className="flex h-dvh flex-col">
    {state.user && <header className="flex items-center justify-between gap-3 border-b p-3">
      <span>{state.user.name || state.user.email || "Your account"}</span>
      <button disabled={signingOut} onClick={() => {
        logoutInFlight.current = true;
        cancelCheck.current();
        if (content.current) content.current.hidden = true;
        setSigningOut(true);
        setLogoutError("");
        setState(current => ({ ...current, kind: "loading" }));
        void clearPrivateData().then(() => signOut("/login")).catch(() => {
          setLogoutError("Sign-out could not be confirmed. Please retry.");
          logoutInFlight.current = false;
          setSigningOut(false);
          check.current();
        });
      }}>{signingOut ? "Signing out…" : "Sign out"}</button>
    </header>}
    {logoutError && <p role="alert" className="p-3">{logoutError}</p>}
    {state.kind === "ready" && state.user ?
      <UserContext.Provider value={state.user}>
        <div ref={content} key={state.user.id} className="min-h-0 flex-1">{children}</div>
      </UserContext.Provider> :
      <main className="space-y-4 p-8" aria-live="polite">
        <p>{state.kind === "loading" ? "Checking your session and private inbox…" :
          state.kind === "unauthorized" ? "Sign in to continue." :
          state.kind === "forbidden" ? "Access to this private inbox is forbidden." :
          "Private inbox access is temporarily unavailable."}</p>
        {state.kind === "unauthorized" ? <a href="/login">Sign in</a> :
          state.kind !== "loading" && <button onClick={() => check.current()}>Retry</button>}
      </main>}
  </div>;
}
