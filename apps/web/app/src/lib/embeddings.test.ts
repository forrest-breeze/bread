import { describe, expect, it } from "vitest";
import {
  EMBEDDINGS_ENABLED,
  generateEmbedding,
  generateEmbeddings,
  isEmbeddingQuotaError,
} from "./embeddings";

// The Breeze internal build has no AI subprocessors: embeddings must never
// call out and must always come back empty.
describe("embeddings (disabled)", () => {
  it("returns null without contacting any provider", async () => {
    const fetchSpy = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("network call attempted");
    }) as typeof fetch;
    try {
      expect(EMBEDDINGS_ENABLED).toBe(false);
      expect(await generateEmbedding("hello", "RETRIEVAL_QUERY")).toBeNull();
      expect(await generateEmbeddings(["a", "b"])).toEqual([null, null]);
      expect(isEmbeddingQuotaError(new Error("429"))).toBe(false);
    } finally {
      globalThis.fetch = fetchSpy;
    }
  });
});
