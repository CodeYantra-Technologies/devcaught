import sanitizeHtml from "sanitize-html";

export function sanitizeEmailHtml(html: string): string {
  const blockedNote =
    '<p style="font-family:sans-serif;font-size:12px;color:#666;margin:8px 0">Remote images blocked.</p>';

  const sanitized = sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.filter(
      (tag) => !["iframe", "object", "embed", "form", "input", "button", "textarea"].includes(tag),
    ),
    allowedAttributes: {
      a: ["href", "title", "name"],
      img: ["alt", "width", "height"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
      table: ["role"],
      "*": ["align"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    transformTags: {
      img: (_tagName, attribs) => ({
        tagName: "img",
        attribs: {
          alt: attribs.alt || "(remote image blocked)",
        },
      }),
      a: (_tagName, attribs) => ({
        tagName: "a",
        attribs: {
          href: attribs.href || "#",
          title: attribs.title || "",
        },
      }),
    },
  });

  if (/<img\b/i.test(html)) return blockedNote + sanitized;
  return sanitized;
}
