"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { Dialog } from "@base-ui/react/dialog"
import { X } from "lucide-react"
import { PORTAL_GLYPHS } from "@/components/icons/portal-glyphs"
import { cn } from "@/lib/utils"
import { publicPortalApiPath, publicPortalHref } from "@/lib/portal/public-base-path"

// Brand glyphs (not stock lucide) for every content mark; only the ✕ close
// affordance stays a generic UI icon.
const ChatGlyph = PORTAL_GLYPHS["messages-square"]!
const SparkGlyph = PORTAL_GLYPHS["sparkles"]!
const SendGlyph = PORTAL_GLYPHS["send"]!

interface AskCitation {
  title: string
  docId: string
  href: string
}

interface ChatMessage {
  role: "user" | "assistant"
  content: string
  /** Sanitized HTML from the API (markdown already rendered server-side). */
  html?: string
  citations?: AskCitation[]
  error?: boolean
}

// Matches the API's history bound (max 12 turns per request).
const HISTORY_LIMIT = 12

// Typography for the server-sanitized markdown inside an assistant bubble.
const ANSWER_HTML_CLASS =
  "space-y-2 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-4 [&_ol]:pl-4 [&_li]:mt-1 " +
  "[&_a]:font-medium [&_a]:text-[var(--portal-accent)] [&_a]:underline-offset-4 [&_a:hover]:underline " +
  "[&_code]:rounded [&_code]:bg-background/70 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] " +
  "[&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-background/70 [&_pre]:p-2 [&_strong]:font-semibold " +
  "[&_sup]:ml-px [&_sup_a]:font-semibold [&_sup_a]:no-underline [&_sup_a:hover]:underline"

export function PortalAiAssistant({
  slug,
  hrefBase,
  label,
}: {
  slug: string
  hrefBase?: string
  label: string
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState("")
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [pending, setPending] = useState(false)
  const publicBase = hrefBase ?? `/p/${slug}`
  const containerRef = useRef<HTMLDivElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Keep the newest message in view as the thread grows.
  useEffect(() => {
    const thread = threadRef.current
    if (thread) thread.scrollTop = thread.scrollHeight
  }, [messages, pending])

  const ask = async (question: string): Promise<void> => {
    // Snapshot before appending: the API wants prior turns, not the new one.
    const history = messages
      .filter((message) => !message.error)
      .slice(-HISTORY_LIMIT)
      .map(({ role, content }) => ({ role, content }))
    setMessages((current) => [...current, { role: "user", content: question }])
    setPending(true)
    try {
      const res = await fetch(publicPortalApiPath("ask"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ portal: slug, question, history }),
      })
      if (!res.ok) {
        setMessages((current) => [
          ...current,
          {
            role: "assistant",
            error: true,
            content:
              res.status === 429
                ? "Too many questions. Please wait a moment and try again."
                : "We couldn't answer that right now. Please try again.",
          },
        ])
        return
      }
      const data = (await res.json()) as {
        answer?: string
        answerHtml?: string
        citations?: AskCitation[]
      }
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: data.answer ?? "",
          html:
            typeof data.answerHtml === "string"
              ? data.answerHtml.replaceAll(`/p/${slug}`, publicBase)
              : undefined,
          citations: Array.isArray(data.citations) ? data.citations : [],
        },
      ])
    } catch {
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          error: true,
          content: "We couldn't answer that right now. Please try again.",
        },
      ])
    } finally {
      setPending(false)
      inputRef.current?.focus()
    }
  }

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const question = draft.trim()
    if (!question || pending) return
    setDraft("")
    void ask(question)
  }

  return (
    <div ref={containerRef}>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger
          aria-label={label}
          className="fixed bottom-6 right-6 z-40 inline-flex size-12 items-center justify-center rounded-full bg-[var(--portal-accent)] text-white shadow-lg transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChatGlyph className="size-5" />
        </Dialog.Trigger>
        <Dialog.Portal container={containerRef}>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/20" />
          <Dialog.Popup
            aria-label={label}
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col overflow-hidden border-l border-border bg-background text-foreground shadow-2xl"
          >
            <div className="flex items-center gap-3 border-b border-border px-4 py-3">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[color-mix(in_srgb,var(--portal-accent)_12%,transparent)] text-[var(--portal-accent)]">
                <ChatGlyph className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <Dialog.Title className="truncate text-sm font-semibold">{label}</Dialog.Title>
                <p className="text-[11px] text-muted-foreground">Answers from this knowledge base</p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close AI assistant"
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>

            <div ref={threadRef} className="min-h-0 flex-1 overflow-y-auto p-4">
              {messages.length === 0 ? (
                <div className="py-8 text-center">
                  <SparkGlyph className="mx-auto size-6 text-[var(--portal-accent)]" />
                  <p className="mt-3 text-sm font-medium">How can I help?</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Ask a question and I’ll answer using the published content in this portal.
                  </p>
                </div>
              ) : (
                <ol className="flex flex-col gap-3" aria-label="Conversation">
                  {messages.map((message, index) => (
                    <li
                      key={index}
                      className={cn(
                        "text-sm leading-relaxed",
                        message.role === "user" && "flex justify-end",
                      )}
                    >
                      {message.role === "user" ? (
                        <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-[var(--portal-accent)] px-3 py-2 text-white">
                          {message.content}
                        </p>
                      ) : (
                        <div
                          className={cn(
                            "max-w-[92%] rounded-2xl rounded-bl-md bg-muted px-3 py-2",
                            message.error && "text-muted-foreground",
                          )}
                        >
                          {message.html ? (
                            // Server-sanitized by the shared public-KB pipeline —
                            // the same trust path as rendered doc bodies.
                            <div
                              className={ANSWER_HTML_CLASS}
                              dangerouslySetInnerHTML={{ __html: message.html }}
                            />
                          ) : (
                            <p className="whitespace-pre-wrap">{message.content}</p>
                          )}
                          {message.citations && message.citations.length > 0 ? (
                            <div className="mt-2 border-t border-border/60 pt-2">
                              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                Sources
                              </p>
                              <ul className="mt-1 space-y-0.5">
                                {message.citations.map((citation) => (
                                  <li key={citation.docId}>
                                    <Link
                                      href={
                                        citation.href.startsWith(`/p/${slug}`)
                                          ? publicPortalHref(
                                              publicBase,
                                              citation.href.slice(`/p/${slug}`.length),
                                            )
                                          : citation.href
                                      }
                                      className="text-xs font-medium text-[var(--portal-accent)] underline-offset-4 hover:underline"
                                    >
                                      {citation.title}
                                    </Link>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                        </div>
                      )}
                    </li>
                  ))}
                  {pending ? (
                    <li
                      className="max-w-[92%] rounded-2xl rounded-bl-md bg-muted px-3 py-2 text-sm text-muted-foreground"
                      aria-live="polite"
                    >
                      <span className="inline-flex items-center gap-1.5">
                        Reading the docs
                        <span className="inline-flex gap-0.5">
                          <span className="size-1 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
                          <span className="size-1 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
                          <span className="size-1 animate-bounce rounded-full bg-current" />
                        </span>
                      </span>
                    </li>
                  ) : null}
                </ol>
              )}
            </div>

            <form onSubmit={submit} className="border-t border-border p-3">
              <div className="flex items-center gap-2 rounded-xl border border-border bg-card p-1.5 pl-3 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
                <input
                  ref={inputRef}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={messages.length === 0 ? "Ask a question…" : "Ask a follow-up…"}
                  aria-label="Question for AI assistant"
                  autoFocus
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
                <button
                  type="submit"
                  disabled={!draft.trim() || pending}
                  aria-label="Ask question"
                  className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--portal-accent)] text-white transition-opacity disabled:opacity-40"
                >
                  <SendGlyph className="size-3.5" />
                </button>
              </div>
            </form>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}
