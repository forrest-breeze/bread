// ---------------------------------------------------------------------------
// Shared category → portal taxonomy helpers.
//
// One home for the "make a generated knowledge base look intentional" rules
// that used to live only in scripts/publish-outbound-portal.ts (the cold-lead
// portal builder). Onboarding's website import and the default layout builder
// now use the SAME mapping, so a portal initialized during onboarding gets the
// same per-section icons and category breadth as an outbound prospect portal.
// ---------------------------------------------------------------------------

/**
 * Resolve a relevant portal icon name for a category/folder label. Matches on
 * the label's wording so "Billing & Plans" gets a credit card and
 * "Troubleshooting" a life buoy, instead of every section sharing one generic
 * folder glyph. Returns `fallback` when nothing matches.
 *
 * Icon names resolve through PortalIcon / DslIcon (custom brand glyphs first,
 * open lucide set as the long-tail fallback).
 */
export function iconForCategory(value: string, fallback = "layers"): string {
  const category = value.toLowerCase();
  if (/getting started|onboarding|overview|introduction|welcome|start here/.test(category))
    return "compass";
  if (/security|compliance|privacy|governance|trust/.test(category))
    return "shield-check";
  if (/\bapi\b|developer|\bcli\b|\bsdk\b|command line|webhook|endpoint/.test(category))
    return "terminal";
  if (/integration|platform|configuration|setup|install/.test(category))
    return "puzzle";
  if (/captur|ingest|\bimport\b|collect/.test(category)) return "upload";
  if (/search|retriev|discover/.test(category)) return "search";
  if (/billing|payment|finance|invoice|revenue|pricing|plan/.test(category))
    return "credit-card";
  if (/analytics|report|performance|insight|metric/.test(category))
    return "chart-no-axes-combined";
  if (/call|message|communication|voice|sms|chat|email/.test(category))
    return "messages-square";
  if (/campaign|outreach|engagement|marketing/.test(category)) return "send";
  if (/industr|solution|customer|supplier|procurement|company/.test(category))
    return "building-2";
  if (/using|usage|how to/.test(category)) return "mouse-pointer-click";
  if (/troubleshoot|support|faq|help|question/.test(category)) return "life-buoy";
  if (/guide|playbook|workflow|operation|process|manual/.test(category))
    return "book-open";
  if (/feature|capabilit|product/.test(category)) return "sparkles";
  if (/release|changelog|update|news|announcement/.test(category))
    return "sparkles";
  if (/learn|training|academy|tutorial|course/.test(category))
    return "graduation-cap";
  if (/reference|glossary|term/.test(category)) return "book-open";
  return fallback;
}

/**
 * When a generated doc set is large but nearly mono-category, re-bucket the
 * obvious outliers (pricing, integrations, getting started) so the portal's
 * category grid shows real breadth instead of one giant section.
 */
export function ensureCategoryBreadth<
  T extends { title: string; category?: string },
>(documents: T[]): T[] {
  const categories = new Set(
    documents.map((document) => (document.category ?? "Guides").trim() || "Guides"),
  );
  if (documents.length < 6 || categories.size >= 3) return documents;

  return documents.map((document) => {
    const signal = `${document.title} ${document.category ?? ""}`.toLowerCase();
    let category = (document.category ?? "Guides").trim() || "Guides";
    if (/pricing|plan|tier|billing/.test(signal)) category = "Pricing & Plans";
    else if (/integration|telephony|api|connect/.test(signal))
      category = "Integrations";
    else if (/onboarding|getting started|how we work|setup/.test(signal)) {
      category = "Getting Started";
    }
    return { ...document, category };
  });
}

// Ordered spare icons handed out when two categories in one set resolve to the
// same glyph (or both miss and share the fallback). Brand glyphs only, roughly
// ordered from most to least generic so reassignments still look intentional.
const ALTERNATE_CATEGORY_ICONS = [
  "layers",
  "book-open",
  "sparkles",
  "compass",
  "graduation-cap",
  "mouse-pointer-click",
  "building-2",
  "messages-square",
  "send",
  "chart-no-axes-combined",
  "life-buoy",
  "link",
  "hash",
  "refresh-ccw",
  "folder",
] as const;

/**
 * Icons for a SET of category entries (one render surface — a category grid or
 * a sidebar rail), aligned by index. An entry's explicit `icon` is honored
 * unless an earlier entry already claimed the glyph; unset or colliding
 * entries resolve through `iconForCategory` and then the ordered alternates,
 * so no two cards on the same surface share an icon. Stored layouts routinely
 * bake the same fallback glyph into several sections (unmatched labels all
 * resolve to "layers"), which is exactly the duplicate this repairs. Only
 * relevant per-surface — different surfaces may of course reuse glyphs.
 */
export function uniqueIconsForCategoryEntries(
  entries: Array<{ label: string; icon?: string }>,
  fallback = "layers",
): string[] {
  const used = new Set<string>();
  return entries.map((entry) => {
    let icon = entry.icon || iconForCategory(entry.label, fallback);
    if (used.has(icon)) {
      // The label's own mapping first (an explicit icon may have squatted on
      // it), then the first unused alternate.
      const own = iconForCategory(entry.label, fallback);
      icon = !used.has(own)
        ? own
        : (ALTERNATE_CATEGORY_ICONS.find((candidate) => !used.has(candidate)) ?? icon);
    }
    used.add(icon);
    return icon;
  });
}

/** `uniqueIconsForCategoryEntries` for bare labels with no explicit icons. */
export function uniqueIconsForCategories(
  labels: string[],
  fallback = "layers",
): string[] {
  return uniqueIconsForCategoryEntries(
    labels.map((label) => ({ label })),
    fallback,
  );
}

// getPublicTaxonomy (lib/public-kb.ts `isPortalWrapperFolder`) treats a folder
// whose name contains a whole-word docs/documentation/help center/knowledge
// base token as a structural "wrapper" and PROMOTES its children in place of
// it — a root category with that name would silently vanish from the portal.
const PORTAL_WRAPPER_NAME_RE =
  /\b(help center|knowledge base|docs|documentation)\b/i;

/**
 * A category label that is safe to use as a root portal section name: labels
 * colliding with the taxonomy's wrapper-folder heuristic fall back to
 * `fallback` so the section still renders.
 */
export function safePortalCategoryName(value: string, fallback = "Guides"): string {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return PORTAL_WRAPPER_NAME_RE.test(trimmed) ? fallback : trimmed;
}
