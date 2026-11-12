// ---------------------------------------------------------------------------
// Confluence Storage Format → Markdown (best-effort, no DOM parser deps).
//
// Storage format is XHTML-like with namespaced macros (<ac:structured-macro>,
// <ri:page>, etc). A perfect conversion would require an XML parser; this
// implementation handles the ~95% common case with a sequence of regex
// transforms. Unknown macros render as a placeholder block instead of
// crashing.
//
// Not exposed as a generic XHTML→markdown — only correct for Confluence
// storage format input.
// ---------------------------------------------------------------------------

export function storageToMarkdown(storage: string): string {
  if (!storage) return "";

  let s = storage;

  // 1. Normalize newlines + strip XML declaration / doctype.
  s = s.replace(/<\?xml[^?]*\?>/g, "").replace(/<!DOCTYPE[^>]*>/g, "");

  // 2. Code blocks first (so we don't double-process inner text).
  s = s.replace(
    /<ac:structured-macro[^>]*ac:name="code"[^>]*>([\s\S]*?)<\/ac:structured-macro>/g,
    (_m, inner: string) => {
      const langMatch = inner.match(
        /<ac:parameter[^>]*ac:name="language"[^>]*>([^<]+)<\/ac:parameter>/,
      );
      const bodyMatch = inner.match(
        /<ac:plain-text-body><!\[CDATA\[([\s\S]*?)\]\]><\/ac:plain-text-body>/,
      );
      const lang = langMatch?.[1] ?? "";
      const body = bodyMatch?.[1] ?? "";
      return "\n```" + lang + "\n" + body + "\n```\n";
    },
  );

  // 3. Info / warning / note panels.
  s = s.replace(
    /<ac:structured-macro[^>]*ac:name="(info|warning|note|tip)"[^>]*>([\s\S]*?)<\/ac:structured-macro>/g,
    (_m, _name: string, inner: string) => {
      const bodyMatch = inner.match(
        /<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>/,
      );
      const body = stripTags(bodyMatch?.[1] ?? "");
      return `\n> ${body.replace(/\n/g, "\n> ")}\n`;
    },
  );

  // 4. Internal page links → keep title as plain text.
  s = s.replace(
    /<ac:link[^>]*>[\s\S]*?<ri:page[^>]*ri:content-title="([^"]+)"[^>]*\/>[\s\S]*?<\/ac:link>/g,
    "[[$1]]",
  );

  // 5. Other unknown macros — render as a placeholder.
  s = s.replace(
    /<ac:structured-macro[^>]*ac:name="([^"]+)"[^>]*>[\s\S]*?<\/ac:structured-macro>/g,
    "\n*[unsupported Confluence macro: $1]*\n",
  );
  s = s.replace(
    /<ac:structured-macro[^>]*ac:name="([^"]+)"[^>]*\/>/g,
    "*[$1]*",
  );

  // 6. Block-level XHTML tags.
  s = s
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/g, "\n# $1\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/g, "\n## $1\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/g, "\n### $1\n")
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/g, "\n#### $1\n")
    .replace(/<h5[^>]*>([\s\S]*?)<\/h5>/g, "\n##### $1\n")
    .replace(/<h6[^>]*>([\s\S]*?)<\/h6>/g, "\n###### $1\n")
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/g, "\n$1\n")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<hr\s*\/?>/g, "\n---\n")
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/g, (_m, inner: string) => {
      return "\n> " + stripTags(inner).replace(/\n/g, "\n> ") + "\n";
    })
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/g, "- $1")
    .replace(/<ul[^>]*>|<\/ul>|<ol[^>]*>|<\/ol>/g, "\n")
    .replace(/<strong>([\s\S]*?)<\/strong>/g, "**$1**")
    .replace(/<b>([\s\S]*?)<\/b>/g, "**$1**")
    .replace(/<em>([\s\S]*?)<\/em>/g, "*$1*")
    .replace(/<i>([\s\S]*?)<\/i>/g, "*$1*")
    .replace(/<code>([\s\S]*?)<\/code>/g, "`$1`")
    .replace(
      /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
      "[$2]($1)",
    );

  // 7. Strip any remaining XHTML tags + collapse whitespace.
  s = stripTags(s);
  s = decodeEntities(s);
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
