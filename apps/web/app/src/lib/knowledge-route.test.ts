// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  canOpenKnowledgeDocumentInPlace,
  knowledgeDocumentIdFromPath,
  knowledgeDocumentPath,
  openKnowledgeDocumentInPlace,
} from "./knowledge-route"

const ID = "3f2b8c1e-5a47-4d09-9c3e-1b2a4d6f8e90"

describe("knowledgeDocumentIdFromPath", () => {
  it("returns the id for a document route", () => {
    expect(knowledgeDocumentIdFromPath(`/knowledge/${ID}`)).toBe(ID)
  })

  it("ignores every other Knowledge route", () => {
    expect(knowledgeDocumentIdFromPath("/knowledge")).toBeNull()
    expect(knowledgeDocumentIdFromPath("/knowledge/changes")).toBeNull()
    expect(knowledgeDocumentIdFromPath(`/knowledge/folder/${ID}`)).toBeNull()
    expect(knowledgeDocumentIdFromPath(`/knowledge/${ID}/extra`)).toBeNull()
    expect(knowledgeDocumentIdFromPath(`/settings/${ID}`)).toBeNull()
    expect(knowledgeDocumentIdFromPath("/knowledge/%E0%A4%A")).toBeNull()
    expect(knowledgeDocumentIdFromPath(null)).toBeNull()
  })
})

describe("opening a document in place", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    window.history.replaceState(null, "", "/")
  })

  it("is only allowed while the Knowledge layout is mounted", () => {
    expect(canOpenKnowledgeDocumentInPlace("/knowledge", ID)).toBe(true)
    expect(canOpenKnowledgeDocumentInPlace(`/knowledge/${ID}`, ID)).toBe(true)
    expect(canOpenKnowledgeDocumentInPlace("/knowledge/changes", ID)).toBe(true)
    expect(canOpenKnowledgeDocumentInPlace("/settings/profile", ID)).toBe(false)
    expect(canOpenKnowledgeDocumentInPlace("/knowledge", "not-a-uuid")).toBe(false)
  })

  it("pushes the document URL without a navigation", () => {
    const pushState = vi.spyOn(window.history, "pushState")
    openKnowledgeDocumentInPlace(ID)

    expect(pushState).toHaveBeenCalledWith(null, "", knowledgeDocumentPath(ID))
    expect(window.location.pathname).toBe(`/knowledge/${ID}`)
  })

  it("does not add a history entry for the document already open", () => {
    window.history.replaceState(null, "", knowledgeDocumentPath(ID))
    const pushState = vi.spyOn(window.history, "pushState")
    openKnowledgeDocumentInPlace(ID)

    expect(pushState).not.toHaveBeenCalled()
  })
})
