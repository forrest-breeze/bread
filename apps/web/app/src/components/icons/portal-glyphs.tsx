// ---------------------------------------------------------------------------
// Bread portal glyphs — the brand icon set.
//
// Hand-drawn duotone marks: a soft currentColor fill (12–16% opacity) under
// crisp 1.75px rounded strokes, plus a small filled "knowledge node" accent on
// most glyphs. Deliberately NOT the stock lucide look — these are the icons a
// generated knowledge base ships with, so they must read as designed, not
// defaulted. All glyphs are plain SVG (server-safe, no client JS) and inherit
// currentColor, so the portal's accent variable tints them for free.
//
// Resolution order everywhere portal icons render (PortalIcon, DslIcon):
// PORTAL_GLYPHS first; the open lucide set is only the long tail for exotic
// agent-authored names.
// ---------------------------------------------------------------------------

export interface PortalGlyphProps {
  className?: string
}

type Glyph = (props: PortalGlyphProps) => React.ReactElement

function glyph(children: React.ReactNode): Glyph {
  const Component = ({ className }: PortalGlyphProps): React.ReactElement => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  )
  return Component
}

// Soft duotone underlay + tiny filled accent node shared by the set.
const fill = { fill: "currentColor", fillOpacity: 0.14, stroke: "none" } as const
const node = { fill: "currentColor", stroke: "none" } as const

export const PORTAL_GLYPHS: Record<string, Glyph> = {
  "file-text": glyph(
    <>
      <path
        d="M7 3.5h6.2L18.5 8.8V19a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5Z"
        {...fill}
      />
      <path d="M7 3.5h6.2L18.5 8.8V19a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5Z" />
      <path d="M13.2 3.5v5.3h5.3" />
      <path d="M9 13h6M9 16.5h3.8" />
      <circle cx="15.7" cy="16.5" r="1.1" {...node} />
    </>,
  ),
  folder: glyph(
    <>
      <path
        d="M4 6.8A1.8 1.8 0 0 1 5.8 5h3.4c.55 0 1.07.25 1.42.68L12 7.3h6.2A1.8 1.8 0 0 1 20 9.1v8.1a1.8 1.8 0 0 1-1.8 1.8H5.8A1.8 1.8 0 0 1 4 17.2Z"
        {...fill}
      />
      <path d="M4 6.8A1.8 1.8 0 0 1 5.8 5h3.4c.55 0 1.07.25 1.42.68L12 7.3h6.2A1.8 1.8 0 0 1 20 9.1v8.1a1.8 1.8 0 0 1-1.8 1.8H5.8A1.8 1.8 0 0 1 4 17.2Z" />
      <path d="M4 10.2h16" />
      <circle cx="12" cy="14.7" r="1.15" {...node} />
    </>,
  ),
  hash: glyph(
    <>
      <rect x="7.4" y="7.6" width="9.2" height="8.8" rx="1.5" {...fill} />
      <path d="M9.6 4 8.2 20M15.8 4l-1.4 16M4.6 9h15.2M4.2 15h15.2" />
    </>,
  ),
  "book-open": glyph(
    <>
      <path
        d="M12 6.6C10.4 5 7.9 4.5 4.5 4.8v13.4c3.4-.3 5.9.3 7.5 1.8 1.6-1.5 4.1-2.1 7.5-1.8V4.8C16.1 4.5 13.6 5 12 6.6Z"
        {...fill}
      />
      <path d="M12 6.6C10.4 5 7.9 4.5 4.5 4.8v13.4c3.4-.3 5.9.3 7.5 1.8 1.6-1.5 4.1-2.1 7.5-1.8V4.8C16.1 4.5 13.6 5 12 6.6Z" />
      <path d="M12 6.6V20" />
      <path d="M7.4 9.2c1.2 0 2.3.2 3.1.6M7.4 12.4c1.2 0 2.3.2 3.1.6" />
      <circle cx="15.8" cy="10.4" r="1.1" {...node} />
    </>,
  ),
  "pen-line": glyph(
    <>
      <path d="M13.9 5.9 18.1 10.1 9.4 18.8l-4.9.7.7-4.9 8.7-8.7Z" {...fill} />
      <path d="M13.9 5.9l2-2a1.6 1.6 0 0 1 2.2 0l2 2a1.6 1.6 0 0 1 0 2.2l-2 2M13.9 5.9 5.2 14.6l-.7 4.9 4.9-.7 8.7-8.7M13.9 5.9l4.2 4.2" />
      <path d="M13 20.5h7" />
    </>,
  ),
  sparkles: glyph(
    <>
      <path
        d="M11 4.5l1.7 4.3 4.3 1.7-4.3 1.7L11 16.5l-1.7-4.3L5 10.5l4.3-1.7L11 4.5Z"
        {...fill}
      />
      <path d="M11 4.5l1.7 4.3 4.3 1.7-4.3 1.7L11 16.5l-1.7-4.3L5 10.5l4.3-1.7L11 4.5Z" />
      <path
        d="M18.3 14.6l.85 2.15 2.15.85-2.15.85-.85 2.15-.85-2.15-2.15-.85 2.15-.85.85-2.15Z"
        {...node}
      />
    </>,
  ),
  compass: glyph(
    <>
      <circle cx="12" cy="12" r="8.4" {...fill} />
      <circle cx="12" cy="12" r="8.4" />
      <path d="M15.2 8.8 13.4 13.4 8.8 15.2 10.6 10.6 15.2 8.8Z" {...node} />
    </>,
  ),
  puzzle: glyph(
    <>
      <path
        d="M9.2 4.9A1.9 1.9 0 0 1 12.9 5.5V7h3.1A1.4 1.4 0 0 1 17.4 8.4v2.7h1.1a1.9 1.9 0 1 1 0 3.8h-1.1v3.2a1.4 1.4 0 0 1-1.4 1.4h-3.1v-1.2a1.9 1.9 0 1 0-3.8 0v1.2H6a1.4 1.4 0 0 1-1.4-1.4V15h1.2a1.9 1.9 0 1 0 0-3.8H4.6V8.4A1.4 1.4 0 0 1 6 7h3.1V5.5c0-.2 0-.4.1-.6Z"
        {...fill}
      />
      <path d="M9.2 4.9A1.9 1.9 0 0 1 12.9 5.5V7h3.1A1.4 1.4 0 0 1 17.4 8.4v2.7h1.1a1.9 1.9 0 1 1 0 3.8h-1.1v3.2a1.4 1.4 0 0 1-1.4 1.4h-3.1v-1.2a1.9 1.9 0 1 0-3.8 0v1.2H6a1.4 1.4 0 0 1-1.4-1.4V15h1.2a1.9 1.9 0 1 0 0-3.8H4.6V8.4A1.4 1.4 0 0 1 6 7h3.1V5.5c0-.2 0-.4.1-.6Z" />
    </>,
  ),
  "life-buoy": glyph(
    <>
      <circle cx="12" cy="12" r="8.4" {...fill} />
      <circle cx="12" cy="12" r="8.4" />
      <circle cx="12" cy="12" r="3.4" fill="var(--portal-bg, transparent)" fillOpacity={1} />
      <circle cx="12" cy="12" r="3.4" />
      <path d="M6.1 6.1 9.6 9.6M17.9 6.1l-3.5 3.5M17.9 17.9l-3.5-3.5M6.1 17.9l3.5-3.5" />
    </>,
  ),
  "graduation-cap": glyph(
    <>
      <path d="M2.8 9.4 12 4.8l9.2 4.6L12 14 2.8 9.4Z" {...fill} />
      <path d="M2.8 9.4 12 4.8l9.2 4.6L12 14 2.8 9.4Z" />
      <path d="M7 11.9v4c0 1.1 2.2 2.4 5 2.4s5-1.3 5-2.4v-4" />
      <path d="M21.2 9.4v4.4" />
      <circle cx="21.2" cy="15.3" r="1.05" {...node} />
    </>,
  ),
  layers: glyph(
    <>
      <path d="M12 3.8 20.5 8 12 12.2 3.5 8 12 3.8Z" {...fill} />
      <path d="M12 3.8 20.5 8 12 12.2 3.5 8 12 3.8Z" />
      <path d="m4.6 11.9-1.1.6L12 16.7l8.5-4.2-1.1-.6M4.6 16.4l-1.1.6L12 21.2l8.5-4.2-1.1-.6" />
    </>,
  ),
  search: glyph(
    <>
      <circle cx="10.8" cy="10.8" r="6.6" {...fill} />
      <circle cx="10.8" cy="10.8" r="6.6" />
      <path d="m16.1 16.1 4.4 4.4" />
      <path d="M8 10.6a2.9 2.9 0 0 1 2.5-2.5" />
    </>,
  ),
  info: glyph(
    <>
      <circle cx="12" cy="12" r="8.4" {...fill} />
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 11.2v5" />
      <circle cx="12" cy="7.9" r="1.15" {...node} />
    </>,
  ),
  "triangle-alert": glyph(
    <>
      <path
        d="M10.5 4.6 3.2 17.4A1.7 1.7 0 0 0 4.7 20h14.6a1.7 1.7 0 0 0 1.5-2.6L13.5 4.6a1.7 1.7 0 0 0-3 0Z"
        {...fill}
      />
      <path d="M10.5 4.6 3.2 17.4A1.7 1.7 0 0 0 4.7 20h14.6a1.7 1.7 0 0 0 1.5-2.6L13.5 4.6a1.7 1.7 0 0 0-3 0Z" />
      <path d="M12 9.4v4.2" />
      <circle cx="12" cy="16.6" r="1.1" {...node} />
    </>,
  ),
  "circle-check": glyph(
    <>
      <circle cx="12" cy="12" r="8.4" {...fill} />
      <circle cx="12" cy="12" r="8.4" />
      <path d="m8.4 12.3 2.4 2.4 4.8-5.2" />
    </>,
  ),
  "octagon-alert": glyph(
    <>
      <path
        d="M8.6 3.5h6.8L20.5 8.6v6.8l-5.1 5.1H8.6L3.5 15.4V8.6L8.6 3.5Z"
        {...fill}
      />
      <path d="M8.6 3.5h6.8L20.5 8.6v6.8l-5.1 5.1H8.6L3.5 15.4V8.6L8.6 3.5Z" />
      <path d="M12 8.2v4.6" />
      <circle cx="12" cy="15.9" r="1.1" {...node} />
    </>,
  ),
  "shield-check": glyph(
    <>
      <path
        d="M12 3.4c2.4 1.3 4.9 2 7 2.2v6c0 4.2-2.9 7.3-7 9-4.1-1.7-7-4.8-7-9v-6c2.1-.2 4.6-.9 7-2.2Z"
        {...fill}
      />
      <path d="M12 3.4c2.4 1.3 4.9 2 7 2.2v6c0 4.2-2.9 7.3-7 9-4.1-1.7-7-4.8-7-9v-6c2.1-.2 4.6-.9 7-2.2Z" />
      <path d="m8.8 12 2.3 2.3 4.4-4.8" />
    </>,
  ),
  "credit-card": glyph(
    <>
      <rect x="3.2" y="5.6" width="17.6" height="12.8" rx="2" {...fill} />
      <rect x="3.2" y="5.6" width="17.6" height="12.8" rx="2" />
      <path d="M3.2 9.8h17.6" strokeWidth={2.6} />
      <path d="M6.6 14.6h4" />
      <circle cx="16.9" cy="14.6" r="1.15" {...node} />
    </>,
  ),
  "chart-no-axes-combined": glyph(
    <>
      <path d="M5.4 13.6h2.4V20H5.4zM10.8 10.6h2.4V20h-2.4zM16.2 13.9h2.4V20h-2.4z" {...fill} />
      <path d="M5.4 20v-6.4M10.8 20v-9.4M16.2 20v-6.1M20.6 20H3.4" />
      <path d="m4.6 9.4 5-3.6 4.4 2.7 5.4-4.3" />
      <circle cx="19.4" cy="4.2" r="1.15" {...node} />
    </>,
  ),
  "messages-square": glyph(
    <>
      <path
        d="M4.2 4.6h10.2a1.6 1.6 0 0 1 1.6 1.6v6.2a1.6 1.6 0 0 1-1.6 1.6H8l-3.4 3V6.2a1.6 1.6 0 0 1 1.6-1.6Z"
        {...fill}
      />
      <path d="M4.2 4.6h10.2a1.6 1.6 0 0 1 1.6 1.6v6.2a1.6 1.6 0 0 1-1.6 1.6H8l-3.4 3V6.2a1.6 1.6 0 0 1 1.6-1.6Z" />
      <path d="M19.4 9.2a1.6 1.6 0 0 1 1.6 1.6v9.6l-3.4-3h-6.2" />
      <circle cx="7.9" cy="9.3" r="1" {...node} />
      <circle cx="11.6" cy="9.3" r="1" {...node} />
    </>,
  ),
  send: glyph(
    <>
      <path
        d="M20.3 3.7 4 10.2c-.85.34-.8 1.56.08 1.83l5.6 1.7 1.7 5.6c.27.88 1.5.93 1.83.08L19.7 3.7"
        {...fill}
      />
      <path d="M20.3 3.7 4 10.2c-.85.34-.8 1.56.08 1.83l5.6 1.7 1.7 5.6c.27.88 1.5.93 1.83.08L20.3 3.7Z" />
      <path d="M20.3 3.7 9.7 13.7" />
    </>,
  ),
  "building-2": glyph(
    <>
      <path d="M4.4 20V6.6A1.6 1.6 0 0 1 6 5h6a1.6 1.6 0 0 1 1.6 1.6V20" {...fill} />
      <path d="M4.4 20V6.6A1.6 1.6 0 0 1 6 5h6a1.6 1.6 0 0 1 1.6 1.6V20" />
      <path d="M13.6 10h4.4a1.6 1.6 0 0 1 1.6 1.6V20" />
      <path d="M2.8 20h18.4" />
      <path d="M7.4 8.4h3.2M7.4 11.8h3.2M7.4 15.2h3.2" />
      <circle cx="16.6" cy="14" r="1" {...node} />
      <circle cx="16.6" cy="17.3" r="1" {...node} />
    </>,
  ),
  "mouse-pointer-click": glyph(
    <>
      <path d="m9.4 9.4 9.6 3.7-4.3 1.6-1.6 4.3-3.7-9.6Z" {...fill} />
      <path d="m9.4 9.4 9.6 3.7-4.3 1.6-1.6 4.3-3.7-9.6Z" />
      <path d="M7.2 2.8l.8 2.9M2.8 7.2l2.9.8M12.6 3.6 11 6.2M3.6 12.6 6.2 11" />
    </>,
  ),
  "refresh-ccw": glyph(
    <>
      <path d="M12 4.4a7.6 7.6 0 0 1 7.2 5.2M12 19.6a7.6 7.6 0 0 1-7.2-5.2" {...fill} />
      <path d="M3.6 5.4v4.2h4.2M20.4 18.6v-4.2h-4.2" />
      <path d="M4.5 14.4a7.7 7.7 0 0 0 12.9 3.3l3-3.1M19.5 9.6A7.7 7.7 0 0 0 6.6 6.3l-3 3.1" />
      <circle cx="12" cy="12" r="1.15" {...node} />
    </>,
  ),
  terminal: glyph(
    <>
      <rect x="3.2" y="4.6" width="17.6" height="14.8" rx="2" {...fill} />
      <rect x="3.2" y="4.6" width="17.6" height="14.8" rx="2" />
      <path d="m7.2 9.2 3.1 2.8-3.1 2.8" />
      <path d="M12.4 15.4h3.4" />
      <circle cx="17.5" cy="15.4" r="1.05" {...node} />
    </>,
  ),
  link: glyph(
    <>
      <path d="M10 14a4.2 4.2 0 0 0 6 0l3-3a4.24 4.24 0 0 0-6-6l-1.4 1.4" />
      <path d="M14 10a4.2 4.2 0 0 0-6 0l-3 3a4.24 4.24 0 0 0 6 6l1.4-1.4" />
    </>,
  ),
  upload: glyph(
    <>
      <path d="M6.4 9.4 12 3.8l5.6 5.6" {...fill} />
      <path d="M12 3.8v11.4M6.4 9.4 12 3.8l5.6 5.6" />
      <path d="M4.4 16.4v2A1.8 1.8 0 0 0 6.2 20.2h11.6a1.8 1.8 0 0 0 1.8-1.8v-2" />
    </>,
  ),
}

/** Whether a portal icon name resolves to a brand glyph (vs the lucide tail). */
export function hasPortalGlyph(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(PORTAL_GLYPHS, name)
}

/** Brand glyph by name, with the file-text mark as the universal fallback. */
export function PortalGlyph({
  name,
  className,
}: {
  name?: string
  className?: string
}): React.ReactElement {
  const Icon = (name && PORTAL_GLYPHS[name]) || PORTAL_GLYPHS["file-text"]!
  return <Icon className={className} />
}
