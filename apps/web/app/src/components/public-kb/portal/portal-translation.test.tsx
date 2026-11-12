// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useState, type ReactElement } from "react"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import {
  PortalLanguageSelector,
  PortalTranslationProvider,
} from "./portal-translation"

describe("PortalTranslationProvider", () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { strings: string[] }
        const translations = body.strings.map((value) =>
          value === "Hello world" ? "Hola mundo" : `es:${value}`,
        )
        return new Response(JSON.stringify({ translations }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }),
    )
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("uses the translated default, skips code, and restores English", async () => {
    render(
      <PortalTranslationProvider
        portal="acme/docs"
        localization={{
          enabledLanguages: ["es"],
          defaultLanguage: "es",
        }}
      >
        <div data-portal-root>
          <p>Hello world</p>
          <code>Hello world</code>
          <PortalLanguageSelector />
        </div>
      </PortalTranslationProvider>,
    )

    await waitFor(() => {
      expect(screen.getByText("Hola mundo")).toBeTruthy()
    })
    expect(screen.getByText("Hello world", { selector: "code" })).toBeTruthy()

    fireEvent.change(screen.getByLabelText("Portal language"), {
      target: { value: "en" },
    })

    await waitFor(() => {
      expect(screen.getAllByText("Hello world")).toHaveLength(2)
    })
  })

  it("translates content added after the first render", async () => {
    function DynamicContent(): ReactElement {
      const [visible, setVisible] = useState(false)
      return (
        <div data-portal-root>
          <button type="button" onClick={() => setVisible(true)}>
            Show more
          </button>
          {visible ? <p>Hello world</p> : null}
        </div>
      )
    }

    render(
      <PortalTranslationProvider
        portal="acme"
        localization={{ enabledLanguages: ["es"], defaultLanguage: "es" }}
      >
        <DynamicContent />
      </PortalTranslationProvider>,
    )

    const button = await screen.findByRole("button")
    fireEvent.click(button)
    await waitFor(() => {
      expect(screen.getByText("Hola mundo")).toBeTruthy()
    })
  })

  it("repairs source text restored by a scroll-driven render before paint", async () => {
    render(
      <PortalTranslationProvider
        portal="acme"
        localization={{ enabledLanguages: ["es"], defaultLanguage: "es" }}
      >
        <div data-portal-root>
          <p>Hello world</p>
        </div>
      </PortalTranslationProvider>,
    )

    const translated = await screen.findByText("Hola mundo")
    const text = translated.firstChild as Text

    // Stateful portal chrome (notably the blog table of contents) can render
    // while the visitor scrolls. React then restores its English source prop on
    // an already translated text node. The observer runs in the microtask
    // checkpoint before paint, so cached text must be repaired synchronously.
    await act(async () => {
      text.data = "Hello world"
      await Promise.resolve()
    })

    expect(text.data).toBe("Hola mundo")
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("routes translation through a reverse-proxy portal mount", async () => {
    render(
      <PortalTranslationProvider
        portal="acme/docs"
        localization={{ enabledLanguages: ["es"], defaultLanguage: "es" }}
      >
        <div data-portal-root data-portal-href-base="/docs">
          <p>Hello world</p>
        </div>
      </PortalTranslationProvider>,
    )

    await waitFor(() => {
      expect(screen.getByText("Hola mundo")).toBeTruthy()
    })
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      "/docs/_bread/api/translate",
    )
  })

  it("requests large pages concurrently instead of waiting batch-by-batch", async () => {
    const pending: Array<{
      body: { strings: string[] }
      resolve: (response: Response) => void
    }> = []
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { strings: string[] }
      return new Promise<Response>((resolve) => {
        pending.push({ body, resolve })
      })
    })
    vi.stubGlobal("fetch", fetchMock)

    render(
      <PortalTranslationProvider
        portal="acme"
        localization={{ enabledLanguages: ["es"], defaultLanguage: "es" }}
      >
        <div data-portal-root>
          {Array.from({ length: 49 }, (_, index) => (
            <p key={index}>{`Source string ${index}`}</p>
          ))}
        </div>
      </PortalTranslationProvider>,
    )

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(4)
    })
    for (const request of pending) {
      request.resolve(
        new Response(
          JSON.stringify({
            translations: request.body.strings.map((value) => `es:${value}`),
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
    }
    await waitFor(() => {
      expect(screen.getByText("es:Source string 48")).toBeTruthy()
    })
  })

  it("restores the stored language before the first paint", async () => {
    window.localStorage.setItem("bread-portal-language:acme", "es")

    render(
      <PortalTranslationProvider
        portal="acme"
        localization={{ enabledLanguages: ["es"], defaultLanguage: "en" }}
      >
        <div data-portal-root>
          <p>Hello world</p>
          <PortalLanguageSelector />
        </div>
      </PortalTranslationProvider>,
    )

    // Synchronously after mount — not a tick later. Deferring this to a passive
    // effect rendered the default language first, so every load flashed English
    // and then ran a second full translation pass.
    const selector = screen.getByLabelText(
      "Portal language",
    ) as HTMLSelectElement
    expect(selector.value).toBe("es")
    expect(document.querySelector("svg.animate-spin")).toBeTruthy()

    await waitFor(() => {
      expect(screen.getByText("Hola mundo")).toBeTruthy()
    })
  })

  it("hides all portal chrome before a newly selected language can paint", async () => {
    const pending: { resolve?: (response: Response) => void } = {}
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            pending.resolve = resolve
          }),
      ),
    )

    render(
      <PortalTranslationProvider
        portal="acme"
        localization={{ enabledLanguages: ["es"], defaultLanguage: "en" }}
      >
        <div data-portal-root>
          <header>Portal navigation</header>
          <main>Hello world</main>
          <PortalLanguageSelector />
        </div>
      </PortalTranslationProvider>,
    )

    fireEvent.change(screen.getByLabelText("Portal language"), {
      target: { value: "es" },
    })

    const root = document.querySelector("[data-portal-root]")
    expect(root?.getAttribute("data-portal-translating")).toBe("all")

    await waitFor(() => expect(pending.resolve).toBeTypeOf("function"))
    pending.resolve?.(
      new Response(
        JSON.stringify({
          translations: ["Navegación del portal", "Hola mundo"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
    await waitFor(() => {
      expect(screen.getByText("Hola mundo")).toBeTruthy()
      expect(root?.hasAttribute("data-portal-translating")).toBe(false)
    })
  })

  it("keeps source content hidden for the full in-flight translation", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})))

    render(
      <PortalTranslationProvider
        portal="acme"
        localization={{ enabledLanguages: ["es"], defaultLanguage: "es" }}
      >
        <div data-portal-root>
          <main>Hello world</main>
        </div>
      </PortalTranslationProvider>,
    )

    const root = document.querySelector("[data-portal-root]")
    expect(root?.getAttribute("data-portal-translating")).toBe("all")

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_001)
    })

    expect(root?.getAttribute("data-portal-translating")).toBe("all")
  })

  it("hides replacement page content until its translation is ready", async () => {
    const pendingNextPage: { resolve?: (response: Response) => void } = {}
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { strings: string[] }
      if (body.strings.includes("Second page")) {
        return new Promise<Response>((resolve) => {
          pendingNextPage.resolve = resolve
        })
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            translations: body.strings.map((value) => `es:${value}`),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
    })
    vi.stubGlobal("fetch", fetchMock)

    function PortalPage({ page }: { page: string }): ReactElement {
      return (
        <PortalTranslationProvider
          portal="acme"
          localization={{ enabledLanguages: ["es"], defaultLanguage: "es" }}
        >
          <div data-portal-root>
            <header>
              {Array.from({ length: 8 }, (_, index) => (
                <span key={index}>{`Navigation ${index}`}</span>
              ))}
            </header>
            <main>{page}</main>
          </div>
        </PortalTranslationProvider>
      )
    }

    const view = render(<PortalPage page="First page" />)
    await screen.findByText("es:First page")

    view.rerender(<PortalPage page="Second page" />)

    const root = document.querySelector("[data-portal-root]")
    expect(root?.getAttribute("data-portal-translating")).toBe("content")
    await waitFor(() =>
      expect(pendingNextPage.resolve).toBeTypeOf("function"),
    )

    pendingNextPage.resolve?.(
      new Response(JSON.stringify({ translations: ["es:Second page"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    await waitFor(() => {
      expect(screen.getByText("es:Second page")).toBeTruthy()
      expect(root?.hasAttribute("data-portal-translating")).toBe(false)
    })
  })

  it("applies each batch as it resolves instead of waiting for the slowest", async () => {
    const pending: Array<{
      body: { strings: string[] }
      resolve: (response: Response) => void
    }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { strings: string[] }
        return new Promise<Response>((resolve) => {
          pending.push({ body, resolve })
        })
      }),
    )

    render(
      <PortalTranslationProvider
        portal="acme"
        localization={{ enabledLanguages: ["es"], defaultLanguage: "es" }}
      >
        <div data-portal-root>
          {Array.from({ length: 32 }, (_, index) => (
            <p key={index}>{`Batch source ${index}`}</p>
          ))}
        </div>
      </PortalTranslationProvider>,
    )

    await waitFor(() => {
      expect(pending).toHaveLength(2)
    })
    const root = document.querySelector("[data-portal-root]")
    expect(root?.hasAttribute("data-portal-translating")).toBe(true)

    const [first, second] = pending
    first.resolve(
      new Response(
        JSON.stringify({
          translations: first.body.strings.map((value) => `es:${value}`),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )

    // The first batch paints while the second is still in flight.
    await waitFor(() => {
      expect(screen.getByText(`es:${first.body.strings[0]}`)).toBeTruthy()
    })
    expect(screen.getByText(second.body.strings[0])).toBeTruthy()

    second.resolve(
      new Response(
        JSON.stringify({
          translations: second.body.strings.map((value) => `es:${value}`),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
    await waitFor(() => {
      expect(screen.getByText(`es:${second.body.strings[0]}`)).toBeTruthy()
    })
    // Content is never left hidden once the pass settles.
    await waitFor(() => {
      expect(root?.hasAttribute("data-portal-translating")).toBe(false)
    })
  })

  it("stops loading and aborts a translation request that never settles", async () => {
    vi.useFakeTimers()
    const requestSignals: AbortSignal[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        const requestSignal = init?.signal as AbortSignal
        requestSignals.push(requestSignal)
        return new Promise<Response>((_resolve, reject) => {
          requestSignal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"))
          })
        })
      }),
    )

    render(
      <PortalTranslationProvider
        portal="acme"
        localization={{ enabledLanguages: ["es"], defaultLanguage: "es" }}
      >
        <div data-portal-root>
          <p>Hello world</p>
          <PortalLanguageSelector />
        </div>
      </PortalTranslationProvider>,
    )

    expect(document.querySelector("svg.animate-spin")).toBeTruthy()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_500)
    })
    expect(requestSignals).toHaveLength(2)
    expect(requestSignals.every((signal) => signal.aborted)).toBe(true)
    expect(document.querySelector("svg.animate-spin")).toBeNull()
    expect(
      screen.getByRole("button", { name: "Retry portal translation" }),
    ).toBeTruthy()
  })
})
