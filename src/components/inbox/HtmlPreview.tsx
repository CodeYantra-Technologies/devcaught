export function HtmlPreview({ html }: { html: string }) {
  if (!html) {
    return <p className="text-sm text-muted">No HTML body on this message.</p>;
  }

  return (
    <div className="overflow-hidden rounded-[16px] border border-border bg-white">
      <p className="border-b border-border bg-surface-2 px-3 py-2 text-xs text-muted">
        Remote images blocked. Scripts cannot run.
      </p>
      <iframe
        title="Email HTML preview"
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={html}
        className="h-[420px] w-full bg-white"
      />
    </div>
  );
}
