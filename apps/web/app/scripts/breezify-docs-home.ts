import type { DslNode } from "../src/lib/portal/dsl/node"

// ---------------------------------------------------------------------------
// The Breezify Docs home page (docs/kb-docs → /p/breezify/docs).
//
// The home page used to be a hero over a category grid — six rows of section
// titles and nothing else. This module builds the v2 DSL `tree` that replaces
// it: an illustrated landing page with an ordered "start here" path, curated
// guide cards, and section-leading visuals, in the shape a reader expects from
// a documentation site.
//
// Why a tree and not more `body` blocks: the block union has no image, no card,
// and no grid — the composition this page needs only exists in the DSL. The
// renderer prefers `tree` over `body` (see PortalRenderer), so the seed script
// publishes both: this tree, plus the old hero+grid body as the fallback any
// build without tree support still renders.
//
// EVERY primitive used here already exists in the deployed registry
// (Stack/Section/Grid/Card/Row/Image/Icon/Heading/Text/Link/Button/Badge plus
// the legacy CategoryGrid/Callout leaves) and no prop is new. That is
// deliberate: publishing a spec the live build rejects makes it fall back to
// the default layout silently, with a 200 (see the changelog-page note in
// seed-breezify-docs.ts), so the home page must stay publishable against the
// build that is already serving it.
// ---------------------------------------------------------------------------

/** A root documentation section, as the seed script's folder tree defines it. */
export interface DocsHomeSection {
  /** Section key — the folder path under docs/kb-docs (e.g. "getting-started"). */
  key: string
  title: string
  icon: string
}

export interface BreezifyDocsHomeInput {
  /** In-portal link base for this project, e.g. "/p/breezify/docs". */
  base: string
  /**
   * Absolute origin serving the app's `public/` assets. Sub-folder portals
   * (example.com/docs, customer domains) are reverse-proxied, so a root-relative
   * image src would resolve against the PROXY host and 404 — only Next's own
   * `/_next/*` assets get an origin from `assetPrefix`.
   */
  assetOrigin: string
  /** Section folder id, keyed by section key. */
  folderIds: ReadonlyMap<string, string>
  /** Published document slug, keyed by path relative to docs/kb-docs. */
  docSlugs: ReadonlyMap<string, string>
  /** Root sections in sidebar order. */
  sections: readonly DocsHomeSection[]
  /** False while the changelog page is held back from a publish. */
  includeChangelogPage: boolean
  /**
   * Filenames present under `public/portal/docs`. A section visual is emitted
   * only for an asset that actually exists — publishing an <Image> for a file
   * we never shipped would put a broken image on the home page, and the page
   * reads fine without it. Defaults to "no assets" so a caller that hasn't
   * looked never ships a dead src.
   */
  assets?: ReadonlySet<string>
}

/**
 * One-line description per root section, shown on its card. Keyed by section
 * key so the seed script keeps owning the folder structure while the home
 * page's copy lives here with the rest of the page's copy.
 */
const SECTION_DESCRIPTIONS: Record<string, string> = {
  "getting-started": "Set up your workspace and learn the core workflow.",
  "using-breezify": "Write, organize, capture, review, and find knowledge.",
  integrations: "Connect the tools where your team's context already lives.",
  publishing: "Turn selected knowledge into a polished public docs site.",
  developers: "Connect AI agents and build with the API.",
  administration: "Manage members, permissions, security, and billing.",
}

/** Ordered first-run path. Each step links the guide that covers it in full. */
const START_STEPS: ReadonlyArray<{
  title: string
  body: string
  linkLabel: string
  doc: string
}> = [
  {
    title: "Write something worth keeping",
    body:
      "Create a page that answers one recognizable question — a deploy checklist, an escalation path, the reason you picked the queue you did. Short sections and explicit prerequisites are what make it findable later.",
    linkLabel: "Quickstart",
    doc: "getting-started/quickstart.md",
  },
  {
    title: "Connect the tools you already use",
    body:
      "Slack threads, pull-request discussions, meeting notes, and Drive files become captures. The librarian compares each one against what you already have and proposes a document to create, update, or merge.",
    linkLabel: "Capture knowledge",
    doc: "using-breezify/capture-knowledge.md",
  },
  {
    title: "Let people and agents ask",
    body:
      "Search the knowledge base directly, or ask the agent a question that spans several documents. Point Claude Code, Cursor, or Codex at the same content over MCP so they stop guessing at your conventions.",
    linkLabel: "Search and ask AI",
    doc: "using-breezify/search-and-ask-ai.md",
  },
]

interface DocCard {
  icon: string
  title: string
  body: string
  doc: string
}

const POPULAR_GUIDES: readonly DocCard[] = [
  {
    icon: "pen-line",
    title: "Create and edit documents",
    body: "The editor, document structure, and what makes a page retrievable.",
    doc: "using-breezify/create-and-edit-documents.md",
  },
  {
    icon: "folder-tree",
    title: "Organize your knowledge base",
    body: "Folders, nesting, visibility, and ordering across your workspace.",
    doc: "using-breezify/organize-your-knowledge-base.md",
  },
  {
    icon: "list-checks",
    title: "Review librarian proposals",
    body: "Approve, edit, or reject what the librarian wants to change.",
    doc: "using-breezify/review-librarian-proposals.md",
  },
]

const AGENT_CARDS: readonly DocCard[] = [
  {
    icon: "sparkles",
    title: "MCP overview",
    body: "Hosted and local transports, the tools they expose, and how auth works.",
    doc: "developers/mcp/overview.md",
  },
  {
    icon: "plug",
    title: "Connect your AI tools",
    body: "Copy-paste configuration for Claude Code, Cursor, Codex, and more.",
    doc: "developers/mcp/connect-ai-tools.md",
  },
  {
    icon: "code",
    title: "REST API",
    body: "Search, read, and capture from your own services.",
    doc: "developers/api/overview.md",
  },
  {
    icon: "key-round",
    title: "Authentication",
    body: "Workspace API keys, personal tokens, and what each one can reach.",
    doc: "developers/api/authentication.md",
  },
]

const PUBLISH_CARDS: readonly DocCard[] = [
  {
    icon: "layout-template",
    title: "Create a docs project",
    body: "Pick a template, choose the scope, and publish your first version.",
    doc: "publishing/create-a-docs-project.md",
  },
  {
    icon: "palette",
    title: "Customize and publish",
    body: "Branding, navigation, pages, and the AI assistant on your portal.",
    doc: "publishing/customize-and-publish.md",
  },
  {
    icon: "globe",
    title: "Custom domains and paths",
    body: "Serve a project from your own domain or a sub-folder of your site.",
    doc: "publishing/custom-domains-and-paths.md",
  },
]

function requireEntry(
  map: ReadonlyMap<string, string>,
  key: string,
  what: string,
): string {
  const value = map.get(key)
  if (!value) throw new Error(`docs home: no ${what} for "${key}"`)
  return value
}

/**
 * Build the Breezify Docs home tree. Throws when a linked document or section is
 * missing rather than emitting a dead card — a missing entry means the seed
 * script's document list and this page have drifted, which is a bug to fix at
 * publish time, not a broken link to ship.
 */
export function buildBreezifyDocsHomeTree(input: BreezifyDocsHomeInput): DslNode {
  const { base, assetOrigin, folderIds, docSlugs, sections } = input
  const assets = input.assets ?? new Set<string>()
  const origin = assetOrigin.replace(/\/+$/, "")

  const docHref = (relPath: string): string =>
    `${base}/doc/${requireEntry(docSlugs, relPath, "document slug")}`
  const folderHref = (key: string): string =>
    `${base}/folder/${requireEntry(folderIds, key, "section folder")}`
  const asset = (file: string): string => `${origin}/portal/docs/${file}`

  /** Icon + title + body + "read this" link, the shape every card grid uses. */
  const docCard = (card: DocCard, idPrefix: string, index: number): DslNode => ({
    id: `${idPrefix}-${index + 1}`,
    type: "Card",
    props: { pad: "lg", gap: "sm" },
    children: [
      {
        id: `${idPrefix}-${index + 1}-icon`,
        type: "Icon",
        props: { name: card.icon, size: "md", tone: "accent" },
      },
      {
        id: `${idPrefix}-${index + 1}-title`,
        type: "Heading",
        props: { text: card.title, level: 3 },
      },
      {
        id: `${idPrefix}-${index + 1}-body`,
        type: "Text",
        props: { text: card.body, tone: "muted", size: "sm" },
      },
      {
        id: `${idPrefix}-${index + 1}-link`,
        type: "Link",
        props: { label: "Read the guide", href: docHref(card.doc) },
      },
    ],
  })

  const cardGrid = (
    id: string,
    cards: readonly DocCard[],
    columns: number,
  ): DslNode => ({
    id,
    type: "Grid",
    props: { columns, gap: "md" },
    children: cards.map((card, index) => docCard(card, id, index)),
  })

  const sectionVisual = (id: string, file: string, alt: string): DslNode[] =>
    assets.has(file)
      ? [
          {
            id,
            type: "Image",
            props: { src: asset(file), alt, radius: "xl", width: "full" },
          },
        ]
      : []

  const children: DslNode[] = [
    {
      id: "home-hero",
      type: "Hero",
      props: {
        eyebrow: "Breezify Documentation",
        heading: "Use Breezify with confidence",
        subtitle:
          "Capture what your team knows, keep it organized, and serve it to people and AI agents — then publish the parts your customers need.",
      },
    },
    ...sectionVisual(
      "home-hero-visual",
      "home-workflow.webp",
      "Captured notes flowing into a single reviewed knowledge base",
    ),
    {
      id: "home-intro",
      type: "Text",
      props: {
        text: "Breezify is a shared knowledge base for teams and the AI agents they work with. These guides cover the whole loop: capture raw context, review what the librarian proposes, retrieve answers with citations, and publish the parts of your workspace that belong in front of customers.",
        tone: "muted",
      },
    },

    // ----- start here ------------------------------------------------------
    {
      id: "home-start",
      type: "Section",
      props: { title: "Start here", gap: "md" },
      children: [
        {
          id: "home-start-lede",
          type: "Text",
          props: {
            text: "Three steps take a new workspace from empty to answering questions. Each links the guide that covers it in full.",
            tone: "muted",
            size: "sm",
          },
        },
        {
          id: "home-start-grid",
          type: "Grid",
          props: { columns: 1, gap: "md" },
          children: START_STEPS.map((step, index) => ({
            id: `home-step-${index + 1}`,
            type: "Card",
            props: { pad: "lg", gap: "sm" },
            children: [
              {
                id: `home-step-${index + 1}-head`,
                type: "Row",
                props: { gap: "sm", align: "center" },
                children: [
                  {
                    id: `home-step-${index + 1}-num`,
                    type: "Badge",
                    props: { text: String(index + 1), tone: "accent" },
                  },
                  {
                    id: `home-step-${index + 1}-title`,
                    type: "Heading",
                    props: { text: step.title, level: 3 },
                  },
                ],
              },
              {
                id: `home-step-${index + 1}-body`,
                type: "Text",
                props: { text: step.body, tone: "muted", size: "sm" },
              },
              {
                id: `home-step-${index + 1}-link`,
                type: "Link",
                props: { label: step.linkLabel, href: docHref(step.doc) },
              },
            ],
          })),
        },
        {
          id: "home-start-cta",
          type: "Row",
          props: { gap: "sm", wrap: true },
          children: [
            {
              id: "home-start-cta-quickstart",
              type: "Button",
              props: {
                label: "Read the quickstart",
                href: docHref("getting-started/quickstart.md"),
                variant: "primary",
              },
            },
            {
              id: "home-start-cta-concepts",
              type: "Button",
              props: {
                label: "Core concepts",
                href: docHref("getting-started/core-concepts.md"),
                variant: "secondary",
              },
            },
          ],
        },
      ],
    },

    {
      id: "home-dogfood",
      type: "Callout",
      props: {
        tone: "info",
        title: "This site is a Breezify workspace",
        body: `<p>Every page you are reading is a document in our own knowledge base, published through the same portal editor you get in yours. When you are ready to do the same, start with <a href="${docHref(
          "publishing/create-a-docs-project.md",
        )}">Create a docs project</a>.</p>`,
      },
    },

    // ----- browse ----------------------------------------------------------
    {
      id: "home-browse",
      type: "Section",
      props: { title: "Browse the documentation", gap: "md" },
      children: [
        {
          id: "home-browse-lede",
          type: "Text",
          props: {
            text: "Six areas, ordered roughly the way teams work through them.",
            tone: "muted",
            size: "sm",
          },
        },
        {
          // NOT `n-categories`: that id marks the GENERATED folder grid, which
          // normalize keeps in lockstep with every root folder in scope — which
          // would append the changelog feed to this curated list.
          id: "home-sections",
          type: "CategoryGrid",
          props: {
            items: sections.map((section) => ({
              id: requireEntry(folderIds, section.key, "section folder"),
              title: section.title,
              description: SECTION_DESCRIPTIONS[section.key],
              icon: section.icon,
              href: folderHref(section.key),
            })),
          },
        },
      ],
    },

    // ----- popular guides --------------------------------------------------
    {
      id: "home-guides",
      type: "Section",
      props: { title: "Popular guides", gap: "md" },
      children: [cardGrid("home-guide", POPULAR_GUIDES, 2)],
    },

    // ----- agents ----------------------------------------------------------
    {
      id: "home-agents",
      type: "Section",
      props: { title: "Build with Breezify", gap: "md" },
      children: [
        ...sectionVisual(
          "home-agents-visual",
          "home-search.webp",
          "A grounded answer assembled from cited workspace documents",
        ),
        {
          id: "home-agents-lede",
          type: "Text",
          props: {
            text: "Your knowledge base is reachable over MCP and a REST API, so coding agents and your own services can search it, read it, and add to it.",
            tone: "muted",
            size: "sm",
          },
        },
        cardGrid("home-agent", AGENT_CARDS, 2),
      ],
    },

    // ----- publishing ------------------------------------------------------
    {
      id: "home-publish",
      type: "Section",
      props: { title: "Publish your own docs", gap: "md" },
      children: [
        ...sectionVisual(
          "home-publish-visual",
          "home-publish.webp",
          "Workspace documents published as a branded public documentation site",
        ),
        {
          id: "home-publish-lede",
          type: "Text",
          props: {
            text: "A portal project publishes a selected part of your workspace as a docs site — on your own domain, with search and an optional AI assistant.",
            tone: "muted",
            size: "sm",
          },
        },
        cardGrid("home-publishing", PUBLISH_CARDS, 2),
      ],
    },
  ]

  // ----- what's next -------------------------------------------------------
  const nextActions: DslNode[] = [
    {
      id: "home-next-app",
      type: "Button",
      props: {
        label: "Open Breezify",
        href: process.env.NEXT_PUBLIC_APP_URL || "/",
        variant: "primary",
      },
    },
    {
      id: "home-next-integrations",
      type: "Button",
      props: {
        label: "Browse integrations",
        href: docHref("integrations/overview.md"),
        variant: "secondary",
      },
    },
  ]
  if (input.includeChangelogPage) {
    nextActions.push({
      id: "home-next-changelog",
      type: "Button",
      props: {
        label: "What's new",
        href: `${base}/page/changelog`,
        variant: "ghost",
      },
    })
  }
  children.push({
    id: "home-next",
    type: "Section",
    props: { title: "Keep going", gap: "md" },
    children: [
      {
        id: "home-next-lede",
        type: "Text",
        props: {
          text: "Everything above lives in a workspace you can open right now. Ship a change, then check what shipped here.",
          tone: "muted",
          size: "sm",
        },
      },
      {
        id: "home-next-actions",
        type: "Row",
        props: { gap: "sm", wrap: true },
        children: nextActions,
      },
    ],
  })

  return { id: "home-root", type: "Stack", props: { gap: "xl" }, children }
}
