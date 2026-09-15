import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Group, Panel, Separator as ResizeSeparator } from "react-resizable-panels";
import { clearInbox, fetchMessages } from "@/lib/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WebhookSetup } from "./WebhookSetup";
import { MessageDetail } from "./MessageDetail";
import { MessageList } from "./MessageList";

export function InboxPage() {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState("all");
  const [showWebhook, setShowWebhook] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileShowDetail, setMobileShowDetail] = useState(false);

  const messages = useQuery({
    queryKey: ["messages", query],
    queryFn: () => fetchMessages(query),
    refetchInterval: 2000,
  });

  const clear = useMutation({
    mutationFn: clearInbox,
    onSuccess: async () => {
      setSelectedId(null);
      setMobileShowDetail(false);
      await queryClient.invalidateQueries({ queryKey: ["messages"] });
      await queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });

  const filtered = (messages.data ?? []).filter(
    (message) =>
      kind === "all" || message.type === kind || message.detections.some((d) => d.type === kind),
  );
  const count = messages.data?.length ?? 0;
  const selected = useMemo(
    () => messages.data?.find((m) => m.id === selectedId) ?? null,
    [messages.data, selectedId],
  );

  function selectMessage(id: string) {
    setSelectedId(id);
    setMobileShowDetail(true);
  }

  const list = messages.isLoading ? (
    <p className="p-4 text-sm text-muted">Loading inbox…</p>
  ) : messages.error ? (
    <p className="p-4 text-sm text-danger">{messages.error.message}</p>
  ) : (
    <MessageList
      messages={filtered}
      selectedId={selected?.id ?? selectedId}
      onSelect={selectMessage}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl tracking-tight">Inbox</h1>
            <p className="mt-1 text-sm text-muted">
              Messages caught from your development environment.
            </p>
          </div>
          <Button variant="secondary" onClick={() => setShowWebhook(!showWebhook)}>
            {showWebhook ? "Close webhook setup" : "Catch webhook"}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="secondary" disabled={count === 0}>
                Clear inbox
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear the inbox?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently deletes every caught message on this machine.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => clear.mutate()}>Clear inbox</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        <div className="relative mt-4">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search subject, sender, recipient, or body"
            className="pl-9"
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-2" aria-label="Filter messages">
          {["all", "email", "webhook", "payment", "order", "transaction"].map((value) => (
            <Button
              key={value}
              size="sm"
              variant={kind === value ? "default" : "ghost"}
              aria-pressed={kind === value}
              onClick={() => {
                setKind(value);
                setSelectedId(null);
                setMobileShowDetail(false);
              }}
            >
              {value === "all" ? "All messages" : value[0].toUpperCase() + value.slice(1)}
            </Button>
          ))}
        </div>
        {clear.error ? (
          <p role="alert" className="mt-2 text-sm text-danger">
            {clear.error.message}
          </p>
        ) : null}
      </header>
      {showWebhook ? (
        <div className="max-h-96 overflow-auto border-b border-border p-4">
          <WebhookSetup
            onCaught={(id) => {
              setKind("all");
              setQuery("");
              setShowWebhook(false);
              selectMessage(id);
            }}
          />
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        <div className="hidden h-full lg:block">
          <Group orientation="horizontal" className="h-full">
            <Panel defaultSize="38%" minSize="26%" className="overflow-auto border-r border-border">
              {list}
            </Panel>
            <ResizeSeparator className="w-px bg-border" />
            <Panel minSize="40%" className="overflow-hidden">
              <MessageDetail
                id={selectedId}
                onBack={() => setMobileShowDetail(false)}
                onDeleted={() => setSelectedId(null)}
                onCaught={selectMessage}
              />
            </Panel>
          </Group>
        </div>

        <div className="h-full lg:hidden">
          {mobileShowDetail && selectedId ? (
            <MessageDetail
              id={selectedId}
              onBack={() => setMobileShowDetail(false)}
              onDeleted={() => {
                setSelectedId(null);
                setMobileShowDetail(false);
              }}
              onCaught={selectMessage}
            />
          ) : (
            list
          )}
        </div>
      </div>
    </div>
  );
}
