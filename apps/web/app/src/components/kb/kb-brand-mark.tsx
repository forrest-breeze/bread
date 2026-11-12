"use client"

import { BookOpen } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

const MAX_SAMPLE_SIZE = 64
const TRANSPARENT_ALPHA = 16
const VISIBLE_ALPHA = 32
const MIN_TRANSPARENT_RATIO = 0.2
const MIN_DARK_NEUTRAL_RATIO = 0.8

/**
 * Return whether an image is a dark, effectively monochrome mark on a
 * transparent canvas. Requiring both transparency and neutral pixels prevents
 * dark-mode inversion from turning opaque logo tiles or colorful artwork into
 * photographic negatives.
 */
export function shouldInvertLogoPixels(pixels: Uint8ClampedArray): boolean {
  const pixelCount = Math.floor(pixels.length / 4)
  if (pixelCount === 0) return false

  let transparentPixels = 0
  let visibleWeight = 0
  let darkNeutralWeight = 0

  for (let index = 0; index < pixelCount * 4; index += 4) {
    const red = pixels[index] ?? 0
    const green = pixels[index + 1] ?? 0
    const blue = pixels[index + 2] ?? 0
    const alpha = pixels[index + 3] ?? 0

    if (alpha <= TRANSPARENT_ALPHA) transparentPixels += 1
    if (alpha <= VISIBLE_ALPHA) continue

    const weight = alpha / 255
    const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255
    const chroma = (Math.max(red, green, blue) - Math.min(red, green, blue)) / 255

    visibleWeight += weight
    if (luminance <= 0.35 && chroma <= 0.18) {
      darkNeutralWeight += weight
    }
  }

  if (visibleWeight === 0) return false

  return (
    transparentPixels / pixelCount >= MIN_TRANSPARENT_RATIO &&
    darkNeutralWeight / visibleWeight >= MIN_DARK_NEUTRAL_RATIO
  )
}

function inspectLogoImage(image: HTMLImageElement): boolean | null {
  const naturalWidth = image.naturalWidth
  const naturalHeight = image.naturalHeight
  if (naturalWidth === 0 || naturalHeight === 0) return null

  const scale = Math.min(1, MAX_SAMPLE_SIZE / Math.max(naturalWidth, naturalHeight))
  const width = Math.max(1, Math.round(naturalWidth * scale))
  const height = Math.max(1, Math.round(naturalHeight * scale))
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height

  try {
    const context = canvas.getContext("2d", { willReadFrequently: true })
    if (!context) return null
    context.clearRect(0, 0, width, height)
    context.drawImage(image, 0, 0, width, height)
    return shouldInvertLogoPixels(context.getImageData(0, 0, width, height).data)
  } catch {
    // A cross-origin image without CORS headers can be displayed but not read
    // from a canvas. The optional CORS probe below gets one more safe chance.
    return null
  }
}

function inspectLogoUrlWithCors(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const image = new Image()
    image.crossOrigin = "anonymous"
    image.decoding = "async"
    image.onload = () => resolve(inspectLogoImage(image) ?? false)
    image.onerror = () => resolve(false)
    image.src = url
  })
}

interface KbBrandMarkProps {
  name: string
  logoUrl?: string | null
  darkLogoUrl?: string | null
  accentColor: string
  /**
   * The mark is cropped to a circle: inset the logo so its corners stay inside
   * the circle (a square fits a circle at ~71% of its diameter).
   */
  circular?: boolean
  className?: string
}

export function KbBrandMark({
  name,
  logoUrl,
  darkLogoUrl,
  accentColor,
  circular = false,
  className,
}: KbBrandMarkProps): React.ReactElement {
  const initial = name.trim().slice(0, 1).toUpperCase()
  const lightLogoRef = useRef<HTMLImageElement>(null)
  const darkLogoRef = useRef<HTMLImageElement>(null)
  const darkModeLogoUrl = darkLogoUrl || logoUrl || null
  const [contrastResult, setContrastResult] = useState<{
    url: string
    invertInDark: boolean
  } | null>(null)
  const invertLogoInDark =
    Boolean(darkModeLogoUrl) &&
    contrastResult?.url === darkModeLogoUrl &&
    contrastResult?.invertInDark === true

  useEffect(() => {
    if (!darkModeLogoUrl) return

    // Inspect the asset that is actually visible in dark mode. A configured
    // dark URL is not necessarily a light-colored variant: imports and manual
    // setup can point both slots at the same black logo.
    const image = darkLogoUrl ? darkLogoRef.current : lightLogoRef.current
    if (!image) return

    let active = true
    const inspect = async (): Promise<void> => {
      const directResult = inspectLogoImage(image)
      const invertInDark =
        directResult ?? (await inspectLogoUrlWithCors(darkModeLogoUrl))

      if (active) setContrastResult({ url: darkModeLogoUrl, invertInDark })
    }
    const handleLoad = (): void => {
      void inspect()
    }

    if (image.complete && image.naturalWidth > 0) {
      void inspect()
    } else {
      image.addEventListener("load", handleLoad)
    }

    return () => {
      active = false
      image.removeEventListener("load", handleLoad)
    }
  }, [darkLogoUrl, darkModeLogoUrl])

  // Crawled accent colors are usually sampled from the brand's own logo, so
  // painting the accent behind a transparent logo cancels it out (purple mark
  // on purple chip). Real logo images render on a transparent container; the
  // accent chip only backs the initial/icon fallback.
  return (
    <span
      className={cn(
        "grid size-9 shrink-0 place-items-center overflow-hidden rounded-lg text-sm font-semibold",
        "bg-transparent text-white",
        !logoUrl && !darkLogoUrl && "shadow-sm",
        className,
        // A real logo sits on a transparent box, so rounded corners only clip
        // it — an edge-to-edge mark lost its corners. Rounding is kept for the
        // initial-chip fallback and for an explicitly circular mark (whose
        // image is inset to fit; see `circular`).
        (logoUrl || darkLogoUrl) && !circular && "overflow-visible rounded-none",
      )}
      aria-hidden="true"
    >
      {!logoUrl ? (
        <span
          className={cn(
            "col-start-1 row-start-1 grid size-full place-items-center",
            darkLogoUrl && "dark:hidden",
          )}
          style={{ backgroundColor: accentColor }}
        >
          {initial ? initial : <BookOpen className="size-4" />}
        </span>
      ) : null}
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={lightLogoRef}
          src={logoUrl}
          alt=""
          className={cn(
            "col-start-1 row-start-1 size-full object-contain",
            circular && "p-[15%]",
            darkLogoUrl && "dark:hidden",
            !darkLogoUrl && invertLogoInDark && "dark:brightness-0 dark:invert",
          )}
        />
      ) : null}
      {darkLogoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={darkLogoRef}
          src={darkLogoUrl}
          alt=""
          className={cn(
            "col-start-1 row-start-1 hidden size-full object-contain dark:block",
            circular && "p-[15%]",
            invertLogoInDark && "dark:brightness-0 dark:invert",
          )}
        />
      ) : null}
    </span>
  )
}
