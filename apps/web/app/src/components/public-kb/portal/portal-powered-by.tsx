import { cn } from "@/lib/utils"

// Portals render on hosts we don't own the asset root of (custom domains and
// sub-folder mounts behind the Cloudflare Worker), where a root-relative
// "/breeze-mark.svg" would 404. Load the mark from the app's own origin instead;
// fall back to root-relative when NEXT_PUBLIC_APP_URL is unset (local dev).
const APP_ORIGIN = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "")
const BREEZE_MARK_URL = `${APP_ORIGIN}/breeze-mark.svg`

// The "Powered by Breeze" credit. Rendered either inline at the bottom of an
// article (above the helpful widget) when there's no footer band, or inside the
// rich footer's bottom row. Showing it is gated by plan entitlement at the call
// site — this component only renders the mark.
export function PortalPoweredBy({ className }: { className?: string }): React.ReactElement {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs text-muted-foreground",
        className,
      )}
      id="footer-powered-by-link"
    >
      <span>Powered by</span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={BREEZE_MARK_URL}
        alt=""
        aria-hidden="true"
        className="size-3.5 shrink-0 object-contain"
      />
      <span className="font-semibold text-foreground">Breeze</span>
    </span>
  )
}
