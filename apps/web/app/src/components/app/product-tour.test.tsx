// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const hoisted = vi.hoisted(() => ({
  profile: { onboarding_completed_at: null as string | null },
  mutate: vi.fn(),
  push: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: hoisted.push }),
  usePathname: () => "/knowledge",
}))
vi.mock("swr", () => ({ useSWRConfig: () => ({ mutate: hoisted.mutate }) }))
vi.mock("@/hooks/swr", () => ({ useProfile: () => ({ data: hoisted.profile }) }))
vi.mock("@/hooks/use-has-hydrated", () => ({ useHasHydrated: () => true }))

import { ProductTourProvider, TOUR_STEPS, useProductTour } from "./product-tour"

function ReplayButton() {
  const { start } = useProductTour()
  return <button onClick={start}>replay</button>
}

function renderTour() {
  return render(
    <ProductTourProvider>
      <button data-tour="search">Search</button>
      <ReplayButton />
    </ProductTourProvider>,
  )
}

describe("ProductTourProvider", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    hoisted.profile = { onboarding_completed_at: null }
    hoisted.mutate.mockReset()
    hoisted.push.mockReset()
    fetchMock = vi.fn().mockResolvedValue(new Response("{}"))
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("opens the welcome modal for users who have not finished the tutorial", () => {
    renderTour()
    expect(screen.getByText("Welcome to Breezify")).toBeTruthy()
  })

  it("stays closed once the tutorial is complete", () => {
    hoisted.profile = { onboarding_completed_at: "2026-11-01T00:00:00.000Z" }
    renderTour()
    expect(screen.queryByText("Welcome to Breezify")).toBeNull()
  })

  it("skip records completion without starting the tour", () => {
    renderTour()
    fireEvent.click(screen.getByRole("button", { name: "Skip" }))

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/profile",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ tutorial_completed: true }) }),
    )
    expect(screen.queryByTestId("product-tour")).toBeNull()
  })

  it("walks every step and records completion on Done", () => {
    renderTour()
    fireEvent.click(screen.getByRole("button", { name: "Show me around" }))

    for (let i = 0; i < TOUR_STEPS.length; i++) {
      act(() => { vi.advanceTimersByTime(2000) })
      expect(screen.getByText(`${i + 1} of ${TOUR_STEPS.length}`)).toBeTruthy()
      expect(screen.getByText(TOUR_STEPS[i]!.title, { selector: "h2" })).toBeTruthy()
      const label = i === TOUR_STEPS.length - 1 ? "Done" : "Next"
      fireEvent.click(screen.getByRole("button", { name: label }))
    }

    expect(screen.queryByTestId("product-tour")).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("Escape ends the tour", () => {
    renderTour()
    fireEvent.click(screen.getByRole("button", { name: "Show me around" }))
    act(() => { vi.advanceTimersByTime(2000) })
    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.queryByTestId("product-tour")).toBeNull()
  })

  it("can be replayed after completion without re-saving", () => {
    hoisted.profile = { onboarding_completed_at: "2026-11-01T00:00:00.000Z" }
    renderTour()
    fireEvent.click(screen.getByText("replay"))
    expect(screen.getByText("Welcome to Breezify")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Skip" }))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
