import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { sendTestEmail } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const OTP_SAMPLE = {
  from: "NexaField <noreply@example.test>",
  to: "developer@example.test",
  subject: "Verify your account",
  text: "Your verification code is 482913.\nThis code expires in 10 minutes.",
};

const LINK_SAMPLE = {
  from: "NexaField <noreply@example.test>",
  to: "developer@example.test",
  subject: "Reset your password",
  text: "Reset your password at https://nexa.test/reset/abc123\nThis link expires in 30 minutes.",
};

export function TestEmailForm({ onCaught }: { onCaught?: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [from, setFrom] = useState(OTP_SAMPLE.from);
  const [to, setTo] = useState(OTP_SAMPLE.to);
  const [subject, setSubject] = useState(OTP_SAMPLE.subject);
  const [text, setText] = useState(OTP_SAMPLE.text);

  const mutation = useMutation({
    mutationFn: sendTestEmail,
    onSuccess: async (message) => {
      await queryClient.invalidateQueries({ queryKey: ["messages"] });
      await queryClient.invalidateQueries({ queryKey: ["status"] });
      onCaught?.(message.id);
    },
  });

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate({ from, to, subject, text });
      }}
    >
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            setFrom(OTP_SAMPLE.from);
            setTo(OTP_SAMPLE.to);
            setSubject(OTP_SAMPLE.subject);
            setText(OTP_SAMPLE.text);
          }}
        >
          OTP example
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            setFrom(LINK_SAMPLE.from);
            setTo(LINK_SAMPLE.to);
            setSubject(LINK_SAMPLE.subject);
            setText(LINK_SAMPLE.text);
          }}
        >
          Link example
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium text-muted">
          From
          <Input className="mt-1.5" value={from} onChange={(e) => setFrom(e.target.value)} required />
        </label>
        <label className="block text-xs font-medium text-muted">
          To
          <Input className="mt-1.5" value={to} onChange={(e) => setTo(e.target.value)} required />
        </label>
      </div>
      <label className="block text-xs font-medium text-muted">
        Subject
        <Input className="mt-1.5" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <label className="block text-xs font-medium text-muted">
        Plain text body
        <Textarea className="mt-1.5" value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Catching…" : "Catch test email"}
        </Button>
        <p className="text-xs text-subtle">
          Uses the ingest pipeline. Does not prove the SMTP port is reachable.
        </p>
      </div>
      {mutation.error ? <p className="text-sm text-danger">{mutation.error.message}</p> : null}
    </form>
  );
}
