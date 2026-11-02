import { Inbox, RefreshCw, Search } from "lucide-react";
import { useEffect, useState } from "react";
import {
  checkLocalInboxHealth,
  fetchLocalInboxMessage,
  fetchLocalInboxPage,
  LocalInboxApiError,
  type LocalInboxMessage,
  type LocalInboxSummary,
} from "@/lib/local-inbox-api";

function formatTimestamp(value: number): string {
  const date = new Date(value);
  if (!Number.isFinite(value) || Number.isNaN(date.getTime())) return "Unknown time";
  return `${new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date)} UTC`;
}

function isoTimestamp(value: number): string | undefined {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function LocalInboxPage() {
  const [serviceReady, setServiceReady] = useState<boolean | null>(null);
  const [healthVersion, setHealthVersion] = useState(0);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [messages, setMessages] = useState<LocalInboxSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LocalInboxMessage | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setServiceReady(null);
    void checkLocalInboxHealth(controller.signal).then(() => {
      setServiceReady(true);
    }).catch(() => {
      if (!controller.signal.aborted) setServiceReady(false);
    });
    return () => controller.abort();
  }, [healthVersion]);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (serviceReady !== true) return;
    const controller = new AbortController();
    setListLoading(true);
    setListError(null);
    setMessages([]);
    setNextCursor(null);
    setHasMore(false);
    setSelectedId(null);
    setDetail(null);
    void fetchLocalInboxPage({ query, signal: controller.signal }).then(page => {
      setMessages(page.items);
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
    }).catch(error => {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : "Could not load local messages.";
      setListError(message);
      if (error instanceof LocalInboxApiError && (error.status === 503 || error.status === 0)) {
        setServiceReady(false);
      }
    }).finally(() => {
      if (!controller.signal.aborted) setListLoading(false);
    });
    return () => controller.abort();
  }, [query, refreshVersion, serviceReady]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError(null);
    void fetchLocalInboxMessage(selectedId, controller.signal).then(setDetail).catch(error => {
      if (!controller.signal.aborted) {
        setDetailError(error instanceof Error ? error.message : "Could not load this message.");
      }
    }).finally(() => {
      if (!controller.signal.aborted) setDetailLoading(false);
    });
    return () => controller.abort();
  }, [selectedId]);

  async function loadMore() {
    if (!nextCursor || moreLoading) return;
    setMoreLoading(true);
    setListError(null);
    try {
      const page = await fetchLocalInboxPage({ limit: 20, cursor: nextCursor, query });
      setMessages(current => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch (error) {
      setListError(error instanceof Error ? error.message : "Could not load more messages.");
    } finally {
      setMoreLoading(false);
    }
  }

  function refresh() {
    setHealthVersion(value => value + 1);
    setRefreshVersion(value => value + 1);
  }

  const selectedMessage = messages.find(message => message.id === selectedId);

  return (
    <div className="min-h-screen bg-bg text-foreground">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl border border-otp-border bg-otp-bg text-otp">
              <Inbox className="size-5" aria-hidden="true" />
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.16em] text-subtle">DevCaught</p>
              <h1 className="font-display text-xl font-semibold tracking-tight">Local SMTP inbox</h1>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="rounded-full border border-otp-border bg-otp-bg px-3 py-1 text-xs font-medium text-otp">
              Local only
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
        <section className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm text-muted">Messages captured by the loopback SMTP listener.</p>
            <p className="mt-1 text-xs text-subtle">This view contains local SMTP captures only.</p>
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={serviceReady === null}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm text-foreground hover:bg-surface-2 disabled:cursor-wait disabled:opacity-50"
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            Refresh
          </button>
        </section>

        {serviceReady === null ? (
          <div role="status" className="rounded-xl border border-border bg-surface p-6 text-sm text-muted">Checking local SMTP service…</div>
        ) : serviceReady === false ? (
          <div role="alert" className="rounded-xl border border-danger/30 bg-surface p-6">
            <h2 className="font-medium text-foreground">Local SMTP service unavailable</h2>
            <p className="mt-2 text-sm text-muted">Start DevCaught in its supported loopback local-capture mode, then try again.</p>
            {listError ? <p className="mt-2 text-sm text-danger">{listError}</p> : null}
            <button type="button" onClick={refresh} className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-foreground">Retry</button>
          </div>
        ) : (
          <>
            <label className="mb-4 flex h-11 max-w-xl items-center gap-3 rounded-xl border border-border bg-surface px-3 focus-within:ring-2 focus-within:ring-ring">
              <Search className="size-4 shrink-0 text-subtle" aria-hidden="true" />
              <span className="sr-only">Search local messages</span>
              <input
                type="search"
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Search sender, subject, or message text"
                className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-subtle"
              />
            </label>

            {listError ? <p role="alert" className="mb-4 rounded-lg border border-danger/30 bg-surface px-4 py-3 text-sm text-danger">{listError}</p> : null}

            <div className="grid min-h-[60vh] gap-4 lg:grid-cols-[minmax(18rem,0.9fr)_minmax(0,1.4fr)]">
              <section aria-label="Local messages" className="overflow-hidden rounded-xl border border-border bg-surface">
                <div className="flex items-center justify-between border-b border-border px-4 py-3">
                  <h2 className="text-sm font-semibold">Messages</h2>
                  <span className="text-xs text-subtle">{messages.length}{hasMore ? "+" : ""}</span>
                </div>
                {listLoading ? (
                  <p role="status" className="p-5 text-sm text-muted">Loading messages…</p>
                ) : messages.length === 0 ? (
                  <div className="p-6 text-center">
                    <Inbox className="mx-auto size-7 text-subtle" aria-hidden="true" />
                    <p className="mt-3 text-sm font-medium">{query ? "No matching messages" : "Your local inbox is empty"}</p>
                    <p className="mt-1 text-xs text-muted">Send a test message to the local SMTP listener to see it here.</p>
                  </div>
                ) : (
                  <ul className="max-h-[65vh] divide-y divide-border overflow-y-auto">
                    {messages.map(message => (
                      <li key={message.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedId(message.id)}
                          aria-current={selectedId === message.id ? "true" : undefined}
                          className={`w-full px-4 py-4 text-left transition-colors hover:bg-surface-2 ${selectedId === message.id ? "bg-surface-2" : ""}`}
                        >
                          <span className="flex items-start justify-between gap-3">
                            <span className="truncate text-sm font-medium">{message.sender || "Unknown sender"}</span>
                            <time className="shrink-0 text-[11px] text-subtle" dateTime={isoTimestamp(message.createdAt)}>{formatTimestamp(message.createdAt)}</time>
                          </span>
                          <span className="mt-1 block truncate text-sm text-foreground">{message.subject || "(No subject)"}</span>
                          <span className="mt-1 block truncate text-xs text-muted">To: {message.recipient || "Unknown recipient"}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {hasMore && !listLoading ? (
                  <div className="border-t border-border p-3">
                    <button type="button" onClick={() => void loadMore()} disabled={moreLoading} className="w-full rounded-lg border border-border px-3 py-2 text-sm text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50">
                      {moreLoading ? "Loading…" : "Load more"}
                    </button>
                  </div>
                ) : null}
              </section>

              <section aria-label="Message details" className="min-h-[24rem] overflow-hidden rounded-xl border border-border bg-surface">
                {detailLoading ? (
                  <p role="status" className="p-6 text-sm text-muted">Loading message…</p>
                ) : detailError ? (
                  <p role="alert" className="p-6 text-sm text-danger">{detailError}</p>
                ) : detail ? (
                  <article className="h-full overflow-y-auto">
                    <header className="border-b border-border px-5 py-5">
                      <p className="break-all text-xs text-muted">From: {detail.sender || "Unknown sender"}</p>
                      <p className="mt-1 break-all text-xs text-muted">To: {detail.recipient || "Unknown recipient"}</p>
                      <h2 className="mt-4 break-words text-xl font-semibold">{detail.subject || "(No subject)"}</h2>
                      <time className="mt-2 block text-xs text-subtle" dateTime={isoTimestamp(detail.createdAt)}>{formatTimestamp(detail.createdAt)}</time>
                    </header>
                    <pre className="whitespace-pre-wrap break-words px-5 py-5 font-mono text-sm leading-6 text-foreground">{detail.textBody || "(This message has no plain-text body.)"}</pre>
                  </article>
                ) : (
                  <div className="flex h-full min-h-[24rem] items-center justify-center p-8 text-center">
                    <div>
                      <p className="text-sm font-medium">Select a message</p>
                      <p className="mt-1 text-xs text-muted">Message details are shown as plain text.</p>
                    </div>
                  </div>
                )}
              </section>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
