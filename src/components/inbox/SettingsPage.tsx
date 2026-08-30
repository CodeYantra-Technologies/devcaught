import { useQuery } from "@tanstack/react-query";
import { fetchStatus } from "@/lib/api";
import { CopyButton } from "./CopyButton";
import { TestEmailForm } from "./TestEmailForm";
import { cn } from "@/lib/utils";

function StatusRow({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <p className="text-sm text-muted">{label}</p>
      <p className="flex items-center gap-2 text-sm text-foreground">
        {ok !== undefined ? (
          <span className={cn("size-2 rounded-full", ok ? "bg-otp" : "bg-danger")} aria-hidden />
        ) : null}
        <span className="font-mono text-sm">{value}</span>
      </p>
    </div>
  );
}

export function SettingsPage() {
  const status = useQuery({
    queryKey: ["status"],
    queryFn: fetchStatus,
    refetchInterval: 4000,
  });

  const smtp = status.data?.smtp;
  const http = status.data?.http;
  const snippet = `import nodemailer from "nodemailer";

const transport = nodemailer.createTransport({
  host: "${smtp?.host ?? "127.0.0.1"}",
  port: ${smtp?.port ?? 1025},
  secure: false,
  tls: { rejectUnauthorized: false },
});

await transport.sendMail({
  from: "NexaField <noreply@example.test>",
  to: "developer@example.test",
  subject: "Verify your account",
  text: "Your verification code is 482913.\\nThis code expires in 10 minutes.",
});`;

  return (
    <div className="h-full overflow-auto px-5 py-6">
      <h1 className="font-display text-2xl tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-muted">Listener health and local SMTP configuration.</p>

      <section className="mt-6 max-w-2xl rounded-[24px] border border-border bg-surface px-5">
        <p className="pt-4 text-[11px] font-medium uppercase tracking-[0.14em] text-subtle">
          SMTP server
        </p>
        <StatusRow label="Status" value={smtp?.running ? "Running" : "Stopped"} ok={smtp?.running} />
        <StatusRow label="Host" value={smtp?.host ?? "—"} />
        <StatusRow label="Port" value={smtp ? String(smtp.port) : "—"} />
        {smtp?.error ? (
          <p className="pb-4 text-sm text-danger whitespace-pre-wrap">{smtp.error}</p>
        ) : (
          <div className="h-2" />
        )}
      </section>

      <section className="mt-4 max-w-2xl rounded-[24px] border border-border bg-surface px-5">
        <p className="pt-4 text-[11px] font-medium uppercase tracking-[0.14em] text-subtle">
          HTTP dashboard
        </p>
        <StatusRow label="Status" value={http?.running ? "Running" : "Stopped"} ok={http?.running} />
        <StatusRow label="Host" value={http?.host ?? "—"} />
        <StatusRow label="Port" value={http ? String(http.port) : "—"} />
        {http?.error ? (
          <p className="pb-4 text-sm text-danger whitespace-pre-wrap">{http.error}</p>
        ) : (
          <div className="h-2" />
        )}
      </section>

      <section className="mt-4 max-w-2xl rounded-[24px] border border-border bg-surface p-5">
        <p className="text-sm font-medium">Point your app at DevCaught</p>
        <p className="mt-1 text-sm text-muted">
          SMTP_HOST={smtp?.host ?? "127.0.0.1"} · SMTP_PORT={smtp?.port ?? 1025} · SMTP_SECURE=false
        </p>
        <pre className="mt-4 overflow-auto rounded-[16px] bg-surface-2 p-4 font-mono text-xs">{snippet}</pre>
        <div className="mt-3">
          <CopyButton value={snippet} label="Copy Nodemailer config" />
        </div>
      </section>

      <section className="mt-4 max-w-2xl rounded-[24px] border border-border bg-surface p-5">
        <p className="text-sm font-medium">Catch test email</p>
        <p className="mb-4 mt-1 text-sm text-muted">
          This proves ingest, parsers, and the dashboard. It is not an SMTP health check — that is the
          listener status above. Messages caught here are marked source=test.
        </p>
        <TestEmailForm />
      </section>
    </div>
  );
}
