import { JSDOM, VirtualConsole } from "jsdom";
import { scrapeFooterFromHtml, type ScrapedFooter } from "@/lib/portal/footer-scrape";

// ---------------------------------------------------------------------------
// Lightweight website crawler for onboarding starter-doc synthesis.
//
// Goal: gather a small, high-signal set of pages from a company's site so the
// LLM has real content to synthesize a knowledge base from. NOT a general web
// crawler — it is deliberately capped (pages, bytes, time) and best-effort:
// any failure returns whatever it gathered so the importer can fall back.
//
//   1. Resolve robots.txt and honor Disallow for our user-agent.
//   2. Discover candidate URLs from sitemap.xml + homepage links.
//   3. Prioritize docs/help/faq/pricing/about-style pages.
//   4. Fetch each (per-page timeout), extract readable text via jsdom.
// ---------------------------------------------------------------------------

const USER_AGENT =
  "BreadBot/1.0 (knowledge-base onboarding import)";
const MAX_PAGES = 12;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_CHARS_PER_PAGE = 20_000;
const MAX_TOTAL_CHARS = 120_000;
// Some third-party marketing sites ship malformed multi-megabyte inline CSS.
// jsdom reports every CSS parse failure to stderr by default even though HTML
// extraction succeeds, which can overflow bounded CLI buffers. The crawler is
// intentionally best-effort, so keep those non-fatal diagnostics local.
const QUIET_VIRTUAL_CONSOLE = new VirtualConsole();

function parseHtml(html: string): JSDOM {
  return new JSDOM(html, { virtualConsole: QUIET_VIRTUAL_CONSOLE });
}

export interface WebsiteCrawlOptions {
  maxPages?: number;
  maxTotalChars?: number;
}

// Path fragments that signal high-value content, in rough priority order.
const PRIORITY_HINTS = [
  "getting-started",
  "get-started",
  "docs",
  "documentation",
  "guide",
  "help",
  "support",
  "faq",
  "how-to",
  "tutorial",
  "features",
  "product",
  "pricing",
  "about",
];

// Extensions / paths that are never useful page content.
const SKIP_EXT = /\.(png|jpe?g|gif|svg|webp|ico|css|js|json|xml|pdf|zip|gz|mp4|mp3|woff2?|ttf)$/i;
const SKIP_PATH = /(?:^\/_\/?$)|\/(login|signin|sign-in|signup|sign-up|register|logout|cart|checkout|account|admin|api)(\/|$)/i;

export interface CrawledPage {
  url: string;
  title: string;
  text: string;
}

interface FetchedHtml {
  url: string;
  html: string;
}

export interface CrawlResult {
  pages: CrawledPage[];
  /** Footer scraped from the homepage (columns + social), or null if none. */
  footer: ScrapedFooter | null;
  /** Square-ish first-party brand mark discovered from homepage metadata. */
  logoUrl: string | null;
  /** Best-effort brand accent inferred from first-party page colors. */
  accentColor: string | null;
}

/** Crawl up to MAX_PAGES content pages from `startUrl`. Never throws — returns
 *  whatever was gathered (possibly empty), plus the homepage footer. */
export async function crawlWebsite(
  startUrl: string,
  seedUrls: string[] = [],
  options: WebsiteCrawlOptions = {},
): Promise<CrawlResult> {
  const maxPages = Math.max(1, Math.min(options.maxPages ?? MAX_PAGES, 24));
  const maxTotalChars = Math.max(
    MAX_CHARS_PER_PAGE,
    Math.min(options.maxTotalChars ?? MAX_TOTAL_CHARS, 240_000),
  );
  let origin: URL;
  try {
    origin = new URL(normalizeUrl(startUrl));
    origin.hash = "";
  } catch {
    return { pages: [], footer: null, logoUrl: null, accentColor: null };
  }

  const disallow = await loadRobotsDisallow(origin);
  const isAllowed = (u: URL): boolean =>
    !disallow.some((rule) => rule && u.pathname.startsWith(rule));

  // Discover candidate URLs: homepage always, then sitemap + homepage links.
  const candidates = new Map<string, URL>();
  candidates.set(origin.href, origin);
  const seeded = new Set<string>();

  const home = await fetchHtml(origin.href);
  // Scrape the homepage footer once (columns + social) to seed the portal's
  // footer. Best-effort: a site with no structured footer yields null.
  let footer: ScrapedFooter | null = null;
  let logoUrl: string | null = null;
  let accentColor: string | null = null;
  if (home) {
    const scraped = scrapeFooterFromHtml(home.html, origin.href);
    if (scraped.columns.length > 0 || scraped.social.length > 0) {
      footer = scraped;
    }
    logoUrl = extractBrandLogo(home.html, origin.href);
    accentColor = extractBrandAccentColor(home.html);
    for (const link of extractLinks(home.html, origin)) {
      if (sameSite(link, origin) && isAllowed(link) && isContentUrl(link)) {
        candidates.set(link.href, link);
      }
    }
  }

  for (const rawUrl of seedUrls) {
    try {
      const seed = new URL(rawUrl, origin);
      seed.hash = "";
      if (sameSite(seed, origin) && isAllowed(seed) && isContentUrl(seed)) {
        candidates.set(seed.href, seed);
        seeded.add(seed.href);
      }
    } catch {
      // Ignore malformed evidence URLs; the payload validator reports them.
    }
  }

  for (const sm of await discoverSitemapUrls(origin, disallow)) {
    if (sameSite(sm, origin) && isAllowed(sm) && isContentUrl(sm)) {
      candidates.set(sm.href, sm);
    }
  }

  const ordered = [...candidates.values()]
    .sort((a, b) => {
      const aScore = seeded.has(a.href) ? -0.5 : priorityScore(a, origin);
      const bScore = seeded.has(b.href) ? -0.5 : priorityScore(b, origin);
      return aScore - bScore;
    })
    .slice(0, maxPages);

  const pages: CrawledPage[] = [];
  let totalChars = 0;

  for (const url of ordered) {
    if (totalChars >= maxTotalChars) break;
    const fetched =
      url.href === origin.href && home ? home : await fetchHtml(url.href);
    if (!fetched) continue;

    const { title, text } = extractReadable(fetched.html);
    const remainingChars = maxTotalChars - totalChars;
    const trimmed = text.slice(0, Math.min(MAX_CHARS_PER_PAGE, remainingChars)).trim();
    if (trimmed.length < 80) continue; // too thin to be useful

    pages.push({ url: url.href, title, text: trimmed });
    totalChars += trimmed.length;
  }

  return { pages, footer, logoUrl, accentColor };
}

// ---------------------------------------------------------------------------

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function sameSite(u: URL, origin: URL): boolean {
  // Treat apex and www as the same site.
  const host = u.hostname.replace(/^www\./, "");
  const base = origin.hostname.replace(/^www\./, "");
  return host === base;
}

function isContentUrl(u: URL): boolean {
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (SKIP_EXT.test(u.pathname)) return false;
  if (SKIP_PATH.test(u.pathname)) return false;
  return true;
}

/** Lower score = higher priority. Homepage first, then priority-hint pages by
 *  hint rank, then everything else by path depth. */
function priorityScore(u: URL, origin: URL): number {
  if (u.href === origin.href || u.pathname === "/") return -1;
  const path = u.pathname.toLowerCase();
  const hintIdx = PRIORITY_HINTS.findIndex((h) => path.includes(h));
  if (hintIdx >= 0) return hintIdx;
  // Shallower paths rank above deep ones, after all hint pages.
  return PRIORITY_HINTS.length + path.split("/").filter(Boolean).length;
}

async function fetchHtml(url: string): Promise<FetchedHtml | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("html")) return null;
    const html = await res.text();
    return { url, html };
  } catch {
    return null;
  }
}

async function loadRobotsDisallow(origin: URL): Promise<string[]> {
  try {
    const res = await fetch(new URL("/robots.txt", origin).href, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    return parseRobotsDisallow(await res.text());
  } catch {
    return [];
  }
}

/** Parse Disallow rules that apply to "*" (and our bot). Minimal but safe —
 *  on anything unexpected we simply collect fewer rules (never over-block). */
export function parseRobotsDisallow(robots: string): string[] {
  const rules: string[] = [];
  let applies = false;
  for (const rawLine of robots.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [field, ...rest] = line.split(":");
    const key = field?.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      applies = value === "*" || /breadbot/i.test(value);
    } else if (key === "disallow" && applies) {
      if (value && value !== "/") rules.push(value);
      // Disallow: / blocks the whole site — represent as "/" sentinel.
      else if (value === "/") rules.push("/");
    }
  }
  return rules;
}

async function discoverSitemapUrls(
  origin: URL,
  disallow: string[],
): Promise<URL[]> {
  const sitemapHrefs = new Set<string>([new URL("/sitemap.xml", origin).href]);
  // robots.txt may also declare Sitemap: lines — fetch + scan once.
  try {
    const robotsRes = await fetch(new URL("/robots.txt", origin).href, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (robotsRes.ok) {
      const txt = await robotsRes.text();
      for (const m of txt.matchAll(/^\s*sitemap:\s*(\S+)/gim)) {
        if (m[1]) sitemapHrefs.add(m[1]);
      }
    }
  } catch {
    // ignore
  }

  const urls: URL[] = [];
  for (const href of sitemapHrefs) {
    try {
      const res = await fetch(href, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const xml = await res.text();
      for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
        const loc = m[1];
        if (!loc) continue;
        try {
          const url = new URL(loc);
          url.hash = "";
          urls.push(url);
        } catch {
          // skip malformed
        }
      }
    } catch {
      // ignore
    }
    if (urls.length > 200) break; // bound parse work on huge sitemaps
  }
  void disallow;
  return urls;
}

function extractLinks(html: string, base: URL): URL[] {
  const out: URL[] = [];
  try {
    const dom = parseHtml(html);
    const anchors = dom.window.document.querySelectorAll("a[href]");
    for (const a of anchors) {
      const href = a.getAttribute("href");
      if (!href) continue;
      try {
        const url = new URL(href, base);
        url.hash = "";
        out.push(url);
      } catch {
        // skip malformed hrefs
      }
    }
  } catch {
    // jsdom parse failure — no links
  }
  return out;
}

/** Resolve a first-party square brand mark from standard homepage metadata.
 *  Touch icons are preferred because they remain legible in the portal's
 *  compact square header slot. */
export function extractBrandLogo(html: string, baseUrl: string): string | null {
  try {
    const base = new URL(baseUrl);
    const doc = parseHtml(html).window.document;
    const candidates = [
      ...doc.querySelectorAll<HTMLLinkElement>('link[rel~="apple-touch-icon"][href]'),
      ...doc.querySelectorAll<HTMLLinkElement>('link[rel~="icon"][href]'),
      ...doc.querySelectorAll<HTMLImageElement>("header img[src]"),
    ];
    for (const element of candidates) {
      const raw = element.getAttribute("href") || element.getAttribute("src");
      if (!raw) continue;
      const resolved = new URL(raw, base);
      if (resolved.protocol !== "https:") continue;
      // Explicit icon metadata is controlled by the site but commonly hosted
      // on a managed CDN. Generic header images remain same-site only.
      if (element.tagName !== "LINK" && !sameSite(resolved, base)) continue;
      return resolved.href;
    }
  } catch {
    // Invalid HTML/base URL simply means the caller uses its favicon fallback.
  }
  return null;
}

function expandHex(value: string): string | null {
  const hex = value.toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(hex)) return hex
  if (/^#[0-9a-f]{3}$/.test(hex)) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
  }
  return null
}

function colorQuality(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const saturation = max === 0 ? 0 : (max - min) / max
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  if (saturation < 0.2 || luminance < 0.035 || luminance > 0.92) return -1
  return saturation * 20 + (1 - Math.abs(luminance - 0.45)) * 5
}

export function extractBrandAccentColor(html: string): string | null {
  const counts = new Map<string, number>()
  for (const match of html.matchAll(/#[0-9a-f]{3}(?:[0-9a-f]{3})?\b/gi)) {
    const hex = expandHex(match[0])
    if (!hex || colorQuality(hex) < 0) continue
    counts.set(hex, (counts.get(hex) ?? 0) + 1)
  }
  const ranked = [...counts.entries()]
    .map(([hex, count]) => ({ hex, score: count + colorQuality(hex) }))
    .sort((left, right) => right.score - left.score)
  return ranked[0]?.hex ?? null
}

/** Extract a title + readable body text, stripping chrome (nav/header/footer/
 *  script/style). Collapses whitespace. */
export function extractReadable(html: string): { title: string; text: string } {
  try {
    const dom = parseHtml(html);
    const doc = dom.window.document;
    for (const sel of [
      "script",
      "style",
      "noscript",
      "nav",
      "header",
      "footer",
      "aside",
      "svg",
      "form",
      "iframe",
    ]) {
      doc.querySelectorAll(sel).forEach((el) => el.remove());
    }

    const title =
      doc.querySelector("h1")?.textContent?.trim() ||
      doc.title?.trim() ||
      "";

    const main = doc.querySelector("main") ?? doc.body;
    const raw = main?.textContent ?? "";
    const text = raw
      .split(/\n+/)
      .map((l) => l.replace(/[ \t]+/g, " ").trim())
      .filter(Boolean)
      .join("\n");

    return { title, text };
  } catch {
    return { title: "", text: "" };
  }
}
