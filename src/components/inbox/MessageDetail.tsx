import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { ArrowLeft, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { deleteMessage, fetchMessage, fetchRaw } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HtmlPreview } from "./HtmlPreview";
import { LinkList } from "./LinkList";
import { OtpCard } from "./OtpCard";
import { TestEmailForm } from "./TestEmailForm";

export function MessageDetail({
  id,
  onBack,
  onDeleted,
  onCaught,
}: {
  id: string | null;
  onBack: () => void;
  onDeleted: () => void;
  onCaught: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("preview");

  useEffect(() => {
    setTab("preview");
  }, [id]);

  const detail = useQuery({
    queryKey: ["message", id],
    queryFn: () => fetchMessage(id!),
    enabled: Boolean(id),
  });
  const raw = useQuery({
    queryKey: ["message-raw", id],
    queryFn: () => fetchRaw(id!),
    enabled: Boolean(id) && tab === "raw",
  });

  const remove = useMutation({
    mutationFn: deleteMessage,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["messages"] });
      await queryClient.invalidateQueries({ queryKey: ["status"] });
      onDeleted();
    },
  });

  if (!id) {
    return (
      <div className="flex h-full flex-col overflow-auto px-6 py-8">
        <div className="mx-auto w-full max-w-xl">
          <p className="font-display text-2xl tracking-tight">Nothing selected</p>
          <p className="mt-2 text-sm text-muted">
            Choose a caught message, or ingest a test email through the same pipeline SMTP uses.
          </p>
          <div className="mt-6 rounded-[24px] border border-border bg-surface p-5">
            <p className="text-sm font-medium">Catch test email</p>
            <p className="mb-4 mt-1 text-xs text-subtle">
              Application-level ingest. SMTP health is on Settings.
            </p>
            <TestEmailForm onCaught={onCaught} />
          </div>
        </div>
      </div>
    );
  }

  if (detail.isLoading) {
    return <div className="p-6 text-sm text-muted">Loading message…</div>;
  }
  if (detail.error || !detail.data) {
    return <div className="p-6 text-sm text-danger">{detail.error?.message ?? "Not found"}</div>;
  }

  const message = detail.data;
  const otps = message.detections.filter((d) => d.type === "otp");
  const urls = message.detections.filter((d) => d.type === "url");

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Button variant="ghost" size="icon" className="lg:hidden" onClick={onBack} aria-label="Back to list">
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display text-lg tracking-tight">{message.subject || "(no subject)"}</h2>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => remove.mutate(message.id)}
          disabled={remove.isPending}
        >
          <Trash2 />
          Delete
        </Button>
      </div>
      <div className="flex-1 overflow-auto px-5 py-5">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-subtle">From</dt>
            <dd className="mt-1 break-all">{message.sender || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">To</dt>
            <dd className="mt-1 break-all">{message.recipient || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">Caught</dt>
            <dd className="mt-1">{format(message.createdAt, "PPpp")}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">Source</dt>
            <dd className="mt-1 uppercase tracking-wide text-muted">{message.source}</dd>
          </div>
        </dl>

        <div className="mt-6 space-y-4">
          {otps.map((otp) => (
            <OtpCard key={otp.value} detection={otp} />
          ))}
          <LinkList detections={urls} />
        </div>

        <Tabs value={tab} onValueChange={setTab} className="mt-8">
          <TabsList>
            <TabsTrigger value="preview">Preview</TabsTrigger>
            <TabsTrigger value="text">Plain text</TabsTrigger>
            <TabsTrigger value="html">HTML</TabsTrigger>
            <TabsTrigger value="raw">Raw</TabsTrigger>
          </TabsList>
          <TabsContent value="preview">
            {message.htmlPreview ? (
              <HtmlPreview html={message.htmlPreview} />
            ) : (
              <pre className="whitespace-pre-wrap rounded-[16px] border border-border bg-surface-2 p-4 font-mono text-sm">
                {message.textBody || "No body."}
              </pre>
            )}
          </TabsContent>
          <TabsContent value="text">
            <pre className="whitespace-pre-wrap rounded-[16px] border border-border bg-surface-2 p-4 font-mono text-sm">
              {message.textBody || "No plain text body."}
            </pre>
          </TabsContent>
          <TabsContent value="html">
            <pre className="overflow-auto whitespace-pre-wrap rounded-[16px] border border-border bg-surface-2 p-4 font-mono text-xs">
              {message.htmlBody || "No HTML body."}
            </pre>
          </TabsContent>
          <TabsContent value="raw">
            <pre className="overflow-auto whitespace-pre-wrap rounded-[16px] border border-border bg-surface-2 p-4 font-mono text-xs">
              {raw.isLoading ? "Loading raw MIME…" : raw.data || "Raw MIME not available."}
            </pre>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
