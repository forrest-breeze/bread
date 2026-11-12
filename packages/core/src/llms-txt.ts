// ---------------------------------------------------------------------------
// llms.txt document model + renderer (https://llmstxt.org).
//
// Shared by both web surfaces so they emit the same document shape:
//   • the marketing site  — example.com/llms.txt (hand-authored sections)
//   • every KB portal     — <portal>/llms.txt (generated from the portal's
//                           folders + published documents)
//
// The format is plain markdown with a fixed skeleton: one H1 (the name), an
// optional blockquote summary, free-form detail paragraphs, then H2 sections of
// `- [title](url): note` links. A section headed "Optional" has spec meaning —
// clients may skip it when context is tight — so callers should reserve that
// heading for genuinely skippable links (legal pages, changelogs).
// ---------------------------------------------------------------------------

export interface LlmsTxtLink {
  title: string;
  /** Absolute URL. Relative links are legal markdown but useless to a fetcher. */
  url: string;
  /** One-line note rendered after the link: `- [title](url): note`. */
  note?: string;
}

export interface LlmsTxtSection {
  /** H2 heading. "Optional" marks the section as skippable (spec behavior). */
  heading: string;
  /** Markdown blocks rendered under the heading, before the links. */
  body?: string[];
  links?: LlmsTxtLink[];
}

export interface LlmsTxtDocument {
  /** H1 — the site or portal name. */
  title: string;
  /** Blockquote summary directly under the H1. */
  summary?: string;
  /** Paragraphs between the summary and the first section. */
  details?: string[];
  sections?: LlmsTxtSection[];
}

/** Collapse whitespace so a note/summary can never break the line format. */
export function llmsTxtOneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Escape markdown link-label delimiters so titles can't break the link. */
function escapeLinkTitle(value: string): string {
  return llmsTxtOneLine(value).replace(/([[\]])/g, "\\$1");
}

// Characters that would terminate a markdown URL early. encodeURIComponent
// leaves parentheses alone, so they are mapped explicitly.
const URL_ESCAPES: Record<string, string> = { "(": "%28", ")": "%29" };

function escapeLinkUrl(value: string): string {
  return value
    .trim()
    .replace(/[()\s]/g, (char) => URL_ESCAPES[char] ?? encodeURIComponent(char));
}

export function renderLlmsTxtLink(link: LlmsTxtLink): string {
  const label = escapeLinkTitle(link.title) || "Untitled";
  const line = `- [${label}](${escapeLinkUrl(link.url)})`;
  const note = link.note ? llmsTxtOneLine(link.note) : "";
  return note ? `${line}: ${note}` : line;
}

export function renderLlmsTxt(doc: LlmsTxtDocument): string {
  const blocks: string[] = [`# ${llmsTxtOneLine(doc.title) || "Untitled"}`];

  if (doc.summary) {
    const summary = llmsTxtOneLine(doc.summary);
    if (summary) blocks.push(`> ${summary}`);
  }

  for (const detail of doc.details ?? []) {
    const trimmed = detail.trim();
    if (trimmed) blocks.push(trimmed);
  }

  for (const section of doc.sections ?? []) {
    const body = (section.body ?? []).map((b) => b.trim()).filter(Boolean);
    const links = (section.links ?? []).filter((link) => link.url.trim());
    // A heading with nothing under it is noise for a reader with a token budget.
    if (body.length === 0 && links.length === 0) continue;
    blocks.push(`## ${llmsTxtOneLine(section.heading)}`);
    blocks.push(...body);
    if (links.length > 0) blocks.push(links.map(renderLlmsTxtLink).join("\n"));
  }

  return `${blocks.join("\n\n")}\n`;
}
