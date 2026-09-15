import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchStatus } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CopyButton } from "./CopyButton";

const sample = JSON.stringify(
  {
    type: "payment.succeeded",
    data: {
      object: {
        object: "payment",
        id: "pay_demo_42",
        order_id: "ord_demo_17",
        transaction_id: "txn_demo_09",
        amount: 2499,
        currency: "USD",
        status: "succeeded",
      },
    },
  },
  null,
  2,
);

export function WebhookSetup({ onCaught }: { onCaught?: (id: string) => void }) {
  const [body, setBody] = useState(sample);
  const client = useQueryClient();
  const status = useQuery({ queryKey: ["status"], queryFn: fetchStatus });
  const endpoint = `http://${status.data?.http.host ?? "127.0.0.1"}:${status.data?.http.port ?? 8025}/api/webhooks/demo`;
  const send = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/webhooks/demo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not capture webhook");
      return result as { id: string };
    },
    onSuccess: async ({ id }) => {
      await client.invalidateQueries({ queryKey: ["messages"] });
      await client.invalidateQueries({ queryKey: ["status"] });
      onCaught?.(id);
    },
  });
  return (
    <section className="space-y-4 rounded-xl border border-border bg-surface p-5">
      <div>
        <h2 className="text-sm font-medium">Catch a webhook</h2>
        <p className="mt-1 text-sm text-muted">
          POST to any named path under /api/webhooks. Requests stay on this machine.
        </p>
      </div>
      <code className="block break-all text-xs text-muted">{endpoint}</code>
      <CopyButton value={endpoint} label="Copy webhook URL" />
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          send.mutate();
        }}
      >
        <label htmlFor="webhook-body" className="block text-sm">
          Test payload
        </label>
        <Textarea
          id="webhook-body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          className="min-h-48 font-mono text-xs"
        />
        <p className="text-xs text-subtle">
          Sends a real HTTP request through the dashboard. JSON, text, and form bodies are captured
          up to 1 MB.
        </p>
        <Button type="submit" disabled={send.isPending}>
          {send.isPending ? "Sending…" : "Send test webhook"}
        </Button>
        {send.error ? (
          <p role="alert" className="text-sm text-danger">
            {send.error.message}
          </p>
        ) : null}
        {send.isSuccess ? (
          <p role="status" className="text-sm text-otp">
            Webhook caught.
          </p>
        ) : null}
      </form>
    </section>
  );
}
