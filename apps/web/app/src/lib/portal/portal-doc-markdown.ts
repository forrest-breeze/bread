import "server-only"

import { JSDOM } from "jsdom"
import { documentHtmlToMarkdown } from "@/lib/document-export"

// ---------------------------------------------------------------------------
// Server-side "document body → markdown" for machine-readable portal output
// (llms-full.txt).
//
// Stored document content is either markdown (passed through) or authored HTML
// (Tiptap / ingestion). The HTML→markdown walker lives in document-export.ts and
// is shared with the in-app export UI; it needs a DOM, which the browser
// provides and the server does not. We inject a jsdom-backed `<template>` parser
// instead of forking the converter — the walker itself only uses standard DOM
// APIs and nodeType numbers, so it runs unchanged on jsdom.
//
// jsdom must stay in `serverExternalPackages` (next.config.mjs) or it does not
// survive bundling into the serverless function.
// ---------------------------------------------------------------------------

let sharedDocument: Document | null = null

// One JSDOM per process: constructing a window per document would dominate the
// cost of rendering a whole knowledge base into one file.
function serverDocument(): Document {
  if (!sharedDocument) {
    sharedDocument = new JSDOM("<!doctype html><html><body></body></html>").window
      .document as unknown as Document
  }
  return sharedDocument
}

export function portalDocumentToMarkdown(content: string | null | undefined): string {
  const raw = content?.trim()
  if (!raw) return ""
  return documentHtmlToMarkdown(raw, (html) => {
    const template = serverDocument().createElement("template")
    template.innerHTML = html
    return template
  })
}
