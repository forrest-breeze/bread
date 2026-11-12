// @vitest-environment happy-dom

import { fireEvent, render, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { KbBrandMark, shouldInvertLogoPixels } from "./kb-brand-mark"

function pixels(...rgba: number[][]): Uint8ClampedArray {
  return new Uint8ClampedArray(rgba.flat())
}

describe("shouldInvertLogoPixels", () => {
  it("detects a black mark on a transparent canvas", () => {
    expect(
      shouldInvertLogoPixels(
        pixels(
          [0, 0, 0, 0],
          [0, 0, 0, 255],
          [15, 15, 15, 255],
          [0, 0, 0, 0],
        ),
      ),
    ).toBe(true)
  })

  it("does not invert an opaque black logo tile", () => {
    expect(
      shouldInvertLogoPixels(
        pixels(
          [0, 0, 0, 255],
          [0, 0, 0, 255],
          [0, 0, 0, 255],
          [0, 0, 0, 255],
        ),
      ),
    ).toBe(false)
  })

  it("does not invert transparent colorful or light artwork", () => {
    expect(
      shouldInvertLogoPixels(
        pixels(
          [0, 0, 0, 0],
          [111, 45, 255, 255],
          [20, 150, 220, 255],
          [0, 0, 0, 0],
        ),
      ),
    ).toBe(false)
    expect(
      shouldInvertLogoPixels(
        pixels(
          [0, 0, 0, 0],
          [255, 255, 255, 255],
          [230, 230, 230, 255],
          [0, 0, 0, 0],
        ),
      ),
    ).toBe(false)
  })
})

describe("KbBrandMark", () => {
  it("switches between dedicated light and dark logo assets", () => {
    const { container } = render(
      <div className="dark">
        <KbBrandMark
          name="Acme"
          logoUrl="/logo-light.svg"
          darkLogoUrl="/logo-dark.svg"
          accentColor="#123456"
        />
      </div>,
    )

    const lightLogo = container.querySelector('img[src="/logo-light.svg"]')
    const darkLogo = container.querySelector('img[src="/logo-dark.svg"]')

    expect(lightLogo).toHaveClass("dark:hidden")
    expect(darkLogo).toHaveClass("hidden", "dark:block")
  })

  it("uses the light logo in both modes when no dark asset is configured", () => {
    const { container } = render(
      <KbBrandMark
        name="Acme"
        logoUrl="/logo-light.svg"
        accentColor="#123456"
      />,
    )

    expect(container.querySelector('img[src="/logo-light.svg"]')).not.toHaveClass(
      "dark:hidden",
    )
  })

  it("auto-inverts a detected transparent black logo in dark mode", async () => {
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({
        clearRect: vi.fn(),
        drawImage: vi.fn(),
        getImageData: vi.fn(() => ({
          data: pixels(
            [0, 0, 0, 0],
            [0, 0, 0, 255],
            [10, 10, 10, 255],
            [0, 0, 0, 0],
          ),
        })),
      } as never)

    const { container } = render(
      <div className="dark">
        <KbBrandMark
          name="Acme"
          logoUrl="/logo-light.svg"
          accentColor="#123456"
        />
      </div>,
    )
    const logo = container.querySelector<HTMLImageElement>(
      'img[src="/logo-light.svg"]',
    )
    expect(logo).not.toBeNull()
    Object.defineProperties(logo, {
      naturalWidth: { configurable: true, value: 2 },
      naturalHeight: { configurable: true, value: 2 },
    })

    fireEvent.load(logo!)

    await waitFor(() => {
      expect(logo).toHaveClass("dark:brightness-0", "dark:invert")
    })
    getContext.mockRestore()
  })

  it("also inspects and inverts a configured black dark-mode asset", async () => {
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({
        clearRect: vi.fn(),
        drawImage: vi.fn(),
        getImageData: vi.fn(() => ({
          data: pixels(
            [0, 0, 0, 0],
            [0, 0, 0, 255],
            [10, 10, 10, 255],
            [0, 0, 0, 0],
          ),
        })),
      } as never)

    const { container } = render(
      <div className="dark">
        <KbBrandMark
          name="Acme"
          logoUrl="/logo-light.svg"
          darkLogoUrl="/logo-dark.svg"
          accentColor="#123456"
        />
      </div>,
    )
    const darkLogo = container.querySelector<HTMLImageElement>(
      'img[src="/logo-dark.svg"]',
    )
    expect(darkLogo).not.toBeNull()
    Object.defineProperties(darkLogo, {
      naturalWidth: { configurable: true, value: 2 },
      naturalHeight: { configurable: true, value: 2 },
    })

    fireEvent.load(darkLogo!)

    await waitFor(() => {
      expect(darkLogo).toHaveClass("dark:brightness-0", "dark:invert")
    })
    getContext.mockRestore()
  })
})
