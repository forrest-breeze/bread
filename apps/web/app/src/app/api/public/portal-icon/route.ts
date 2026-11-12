import { createElement } from "react"
import { ImageResponse } from "next/og"
import type { NextRequest } from "next/server"
import { z } from "zod"
import { requirePortal } from "@/lib/public-kb-route"
import { parsePortalPath } from "@/lib/portal/portal-path"
import { safeSearchParams, slugSchema } from "@/lib/validation"
import { breezeOnlyResponse } from "@/lib/auth/require-breeze"

export const dynamic = "force-dynamic"

const ICON_SIZE = { width: 32, height: 32 }
const CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300"
const querySchema = z
  .object({
    workspace: slugSchema.optional(),
    project: slugSchema.optional(),
  })
  .strict()

function imageUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (!["https:", "http:"].includes(url.protocol)) return null
    if (url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

// ImageResponse fetches image URLs on the server. Only render files from our
// public Supabase storage origin so a persisted branding URL can never turn
// this public endpoint into an arbitrary network fetch.
function publicStorageImageUrl(value: string | null | undefined): string | null {
  if (!value || !process.env.NEXT_PUBLIC_SUPABASE_URL) return null
  try {
    const candidate = new URL(value)
    const storageOrigin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL)
    if (candidate.origin !== storageOrigin.origin) return null
    if (!candidate.pathname.startsWith("/storage/v1/object/public/")) return null
    return candidate.toString()
  } catch {
    return null
  }
}

export async function GET(request: NextRequest): Promise<ImageResponse | Response> {
  // Breeze internal tool: portals are Breeze-only (see lib/auth/require-breeze.ts).
  const denied = await breezeOnlyResponse();
  if (denied) return denied;

  const query = safeSearchParams(request.nextUrl, querySchema)
  if (!query.ok) return query.response

  const { workspace: workspaceSlug, project: projectSlug } = query.data
  const parsed = workspaceSlug
    ? parsePortalPath(projectSlug ? [workspaceSlug, projectSlug] : [workspaceSlug])
    : null
  if (!parsed) return new Response("Not found", { status: 404 })

  const portalPath = projectSlug
    ? `/p/${workspaceSlug}/${projectSlug}`
    : `/p/${workspaceSlug}`
  const { workspace, layout } = await requirePortal(
    parsed.workspaceSlug,
    parsed.projectSlug,
    portalPath,
  )
  const theme = layout?.theme
  // A project-specific favicon is the only override. Otherwise portal tabs
  // stay aligned with the workspace brand kit, even when a project has its own
  // light/dark header logos.
  const faviconUrl = [
    theme?.faviconUrl,
    workspace.branding.logoUrl,
    workspace.iconUrl,
    theme?.logoUrl,
    theme?.darkLogoUrl,
  ]
    .map(imageUrl)
    .find((value): value is string => value !== null)
  // Imported branding can live on an external CDN. Let the browser load it
  // directly instead of discarding it or fetching arbitrary URLs on the server.
  if (faviconUrl && !publicStorageImageUrl(faviconUrl)) {
    return new Response(null, {
      status: 302,
      headers: { Location: faviconUrl, "Cache-Control": CACHE_CONTROL },
    })
  }
  const circle = theme?.faviconShape === "circle"
  const borderRadius = circle ? "50%" : "22%"
  // Inset the image so its corners sit inside the rounded/circular crop: a
  // square fits a circle at ~71% of its diameter.
  const inset = circle ? 0.15 : 0.06
  const icon = faviconUrl
    ? createElement(
        "div",
        {
          style: {
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
            borderRadius,
            background: "transparent",
          },
        },
        createElement("img", {
          src: faviconUrl,
          alt: "",
          width: Math.round(ICON_SIZE.width * (1 - inset * 2)),
          height: Math.round(ICON_SIZE.height * (1 - inset * 2)),
          style: { objectFit: "contain" },
        }),
      )
    : createElement(
        "div",
        {
          style: {
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
            borderRadius,
            background: theme?.accentColor || workspace.branding.accentColor,
            color: "white",
            fontSize: 20,
            fontWeight: 700,
          },
        },
        (theme?.logoText || theme?.brandName || workspace.name)
          .trim()
          .slice(0, 1)
          .toUpperCase(),
      )

  return new ImageResponse(icon, {
    ...ICON_SIZE,
    headers: { "Cache-Control": CACHE_CONTROL },
  })
}
