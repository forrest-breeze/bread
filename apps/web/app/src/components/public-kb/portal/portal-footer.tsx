import type { ComponentType } from "react"
import { Github, Instagram, Linkedin, Youtube } from "lucide-react"
import { KbBrandMark } from "@/components/kb/kb-brand-mark"
import { PortalPoweredBy } from "@/components/public-kb/portal/portal-powered-by"
import {
  footerHasContent,
  isSafeHref,
  type FooterBlock,
  type FooterSocialPlatform,
} from "@/lib/portal/schema"
import { cn } from "@/lib/utils"

// The X (formerly Twitter) mark. lucide has no X logo, so it's inlined here.
function XLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
    </svg>
  )
}

// Social platform → icon + accessible label.
const SOCIAL_META: Record<
  FooterSocialPlatform,
  { icon: ComponentType<{ className?: string }>; label: string }
> = {
  x: { icon: XLogo, label: "X" },
  linkedin: { icon: Linkedin, label: "LinkedIn" },
  github: { icon: Github, label: "GitHub" },
  youtube: { icon: Youtube, label: "YouTube" },
  instagram: { icon: Instagram, label: "Instagram" },
}

// The "Powered by Bread" credit alone does NOT count as footer content — a
// portal with no configured footer links renders no footer band at all (the
// credit moves into the article instead). Callers use `footerHasContent` (from
// the portal schema) to decide where the credit lives.
export { footerHasContent as footerHasLinks }

interface PortalFooterProps {
  footer: FooterBlock
  allowPoweredByRemoval?: boolean
  /** Brand identity for the rich footer's logo block (from the portal theme). */
  brandName?: string
  brandLogoUrl?: string | null
  brandDarkLogoUrl?: string | null
  brandAccentColor?: string
  variant?: "global" | "content"
}

// Global portal footer. Renders a divider + right-aligned Bread credit at the
// bottom of every page as a minimal footer when no links are configured, and
// extends to a full/rich link footer when configured. Removing the credit is
// gated by the caller's plan.
export function PortalFooter({
  footer,
  allowPoweredByRemoval = false,
  brandName,
  brandLogoUrl,
  brandDarkLogoUrl,
  brandAccentColor,
  variant = "global",
}: PortalFooterProps): React.ReactElement | null {
  const showPoweredBy = footer.showPoweredBy !== false || !allowPoweredByRemoval
  const hasLinks = footerHasContent(footer)

  if (!hasLinks && !showPoweredBy) return null

  // Re-apply the href gate — footer links render outside the validated body.
  const links = footer.links?.filter((link) => isSafeHref(link.href)) ?? []
  const columns = (footer.columns ?? [])
    .map((col) => ({ ...col, links: col.links.filter((l) => isSafeHref(l.href)) }))
    .filter((col) => col.links.length > 0)
  // Unvalidated layouts (the builder's draft) can still carry a platform that
  // was since dropped (facebook, bluesky, …); skip those rather than crash.
  const social = (footer.social ?? []).filter(
    (s) => Object.hasOwn(SOCIAL_META, s.platform) && isSafeHref(s.href),
  )
  const isRich = columns.length > 0 || social.length > 0

  const bottomBar = (
    <div className="flex w-full flex-col items-center justify-between gap-3 text-xs text-muted-foreground sm:flex-row">
      <div className="flex flex-wrap items-center gap-4">
        {footer.note && <span>{footer.note}</span>}
        {links.map((link) => (
          <a
            key={`${link.label}:${link.href}`}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-foreground"
          >
            {link.label}
          </a>
        ))}
      </div>
      {showPoweredBy && <PortalPoweredBy />}
    </div>
  )

  const Tag = variant === "content" ? "div" : "footer"
  const innerClass = variant === "content"
    ? "w-full border-t border-border/70 py-6"
    : "mx-auto w-full max-w-7xl border-t border-border/70 px-6 py-6 sm:px-8"
  const richInnerClass = variant === "content"
    ? "w-full border-t border-border/70 py-12"
    : "mx-auto w-full max-w-7xl border-t border-border/70 px-6 py-12 sm:px-8"

  if (!hasLinks) {
    return (
      <Tag className="mt-auto">
        <div className={cn(innerClass, "flex justify-end")}>
          <PortalPoweredBy />
        </div>
      </Tag>
    )
  }

  if (!isRich) {
    return (
      <Tag className="mt-auto">
        <div className={innerClass}>{bottomBar}</div>
      </Tag>
    )
  }

  return (
    <Tag className="mt-auto">
      <div className={richInnerClass}>
        <div className="flex flex-col gap-10 lg:flex-row lg:justify-between">
          <div className="flex flex-col gap-6">
            <div className="flex items-center gap-2.5">
              <KbBrandMark
                name={brandName ?? ""}
                logoUrl={brandLogoUrl ?? null}
                darkLogoUrl={brandDarkLogoUrl ?? null}
                accentColor={brandAccentColor ?? "#2f5520"}
                className="size-7 shrink-0 rounded-md"
              />
              {brandName ? (
                <span className="text-2xl font-semibold leading-7 tracking-tight text-foreground">{brandName}</span>
              ) : null}
            </div>
            {social.length > 0 && (
              <div className="flex items-center gap-4">
                {social.map((s) => {
                  const meta = SOCIAL_META[s.platform]
                  const Icon = meta.icon
                  return (
                    <a
                      key={`${s.platform}:${s.href}`}
                      href={s.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={meta.label}
                      className="text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <Icon className="size-5" />
                    </a>
                  )
                })}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-x-10 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
            {columns.map((col) => (
              <div key={col.heading} className="flex flex-col gap-3">
                <p className="text-sm font-semibold text-foreground">{col.heading}</p>
                <ul className="flex flex-col gap-2.5">
                  {col.links.map((link) => (
                    <li key={`${link.label}:${link.href}`}>
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-12 pt-2">{bottomBar}</div>
      </div>
    </Tag>
  )
}
