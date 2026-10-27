/** Private routing must exist before the UI can advertise a capture endpoint. */
export function WebhookSetup(_props: { onCaught?: (id: string) => void } = {}) {
  return <section className="space-y-3 rounded-xl border p-5">
    <h2 className="text-sm font-medium">Private webhooks</h2>
    <p>Private webhook routing is not enabled yet.</p>
  </section>;
}
