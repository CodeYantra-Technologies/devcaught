import type { SmsEvent } from "../../../packages/shared/src/types";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "./CopyButton";
import { maskPhoneSms } from "../../../packages/shared/src/sms/phone";

function statusVariant(status: SmsEvent["status"]): string {
  const upper = (status ?? "").trim().toUpperCase();
  if (upper === "DELIVERED") return "border-green-500 bg-green-500/10 text-green-500";
  if (upper === "FAILED" || upper === "REJECTED" || upper === "BLOCKED") {
    return "border-red-500 bg-red-500/10 text-red-500";
  }
  if (upper === "RECEIVED" || upper === "SENT") {
    return "border-blue-500 bg-blue-500/10 text-blue-500";
  }
  return "border-border bg-surface-2 text-muted";
}

export function SmsEventDetail({ sms }: { sms: SmsEvent }) {
  const from = maskPhoneSms(sms.from);
  const to = maskPhoneSms(sms.to);
  return (
    <div className="space-y-4 rounded-[20px] border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="url" className="uppercase">
          SMS
        </Badge>
        <Badge variant="url" className="uppercase">
          {sms.provider}
        </Badge>
        <Badge variant="url" className="uppercase">
          {sms.kind === "delivery_status" ? "DELIVERY" : "INBOUND"}
        </Badge>
        {sms.status ? (
          <Badge className={`border ${statusVariant(sms.status)}`}>
            {sms.status}
          </Badge>
        ) : null}
      </div>

      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-subtle">Message SID</dt>
          <dd className="mt-1 font-mono break-all text-xs text-foreground">{sms.messageSid ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle">From</dt>
          <dd className="mt-1 break-all">{from}</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle">To</dt>
          <dd className="mt-1 break-all">{to}</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle">Received</dt>
          <dd className="mt-1">{new Date(sms.receivedAt).toISOString()}</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle">Verification</dt>
          <dd className="mt-1 uppercase tracking-wide text-muted">{sms.verification}</dd>
        </div>
        {sms.numSegments != null && sms.numSegments !== 0 && (
          <div>
            <dt className="text-xs text-subtle">Segments</dt>
            <dd className="mt-1 tabular-nums">{sms.numSegments}</dd>
          </div>
        )}
        {sms.numMedia != null && sms.numMedia !== 0 && (
          <div>
            <dt className="text-xs text-subtle">Media</dt>
            <dd className="mt-1 tabular-nums">{sms.numMedia}</dd>
          </div>
        )}
      </dl>

      {sms.errorCode && sms.errorCode.trim().length > 0 && (
        <div className="rounded-[12px] border border-red-500/20 bg-red-500/5 p-3">
          <p className="text-xs uppercase tracking-wide text-red-500">Error</p>
          <p className="mt-1 font-mono break-all text-xs text-red-500">{sms.errorCode}</p>
        </div>
      )}

      {sms.mediaUrls && sms.mediaUrls.length > 0 && (
        <div className="rounded-[12px] border border-border bg-surface-2 p-3">
          <p className="text-xs uppercase tracking-wide text-muted">Media</p>
          <ul className="mt-2 list-inside list-disc text-xs text-muted">
            {sms.mediaUrls.map((url) => (
              <li key={url} className="break-all font-mono">{url}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-[16px] border border-border bg-surface-2 p-4">
        <p className="text-xs uppercase tracking-[0.14em] text-muted">Body</p>
        <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-sm text-foreground">
          {sms.body || "No body."}
        </pre>
      </div>

      <div className="flex flex-wrap gap-2">
        <CopyButton value={sms.messageSid ?? ""} label="Copy message SID" />
        <CopyButton value={from} label="Copy from" />
        <CopyButton value={to} label="Copy to" />
        <CopyButton value={sms.body} label="Copy body" />
      </div>
    </div>
  );
}
