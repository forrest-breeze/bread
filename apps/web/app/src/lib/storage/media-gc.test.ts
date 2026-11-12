import { describe, it, expect } from "vitest";
import { selectOrphans, type MediaRow } from "@/lib/storage/media-gc";

// A fixed grace cutoff for the suite. "old" rows sort before it; "new" after.
const CUTOFF = "2026-06-22T00:00:00.000Z";
const OLD = "2026-06-01T00:00:00.000Z"; // before cutoff → past grace period
const NEW = "2026-06-28T00:00:00.000Z"; // after cutoff → inside grace period

function row(overrides: Partial<MediaRow> & { id: string }): MediaRow {
  return {
    capture_id: null,
    storage_key: `media/ws/${overrides.id}.png`,
    created_at: OLD,
    ...overrides,
  };
}

describe("selectOrphans", () => {
  it("returns nothing for empty inputs", () => {
    expect(selectOrphans([], new Set(), new Set(), CUTOFF)).toEqual([]);
  });

  it("selects a genuinely-orphaned old row (no ref, no capture)", () => {
    const rows = [row({ id: "a" })];
    const orphans = selectOrphans(rows, new Set(), new Set(), CUTOFF);
    expect(orphans.map((r) => r.id)).toEqual(["a"]);
  });

  it("keeps a row still referenced by a document body", () => {
    const rows = [row({ id: "a" })];
    const orphans = selectOrphans(rows, new Set(["a"]), new Set(), CUTOFF);
    expect(orphans).toEqual([]);
  });

  it("keeps a row pinned to a still-live capture", () => {
    const rows = [row({ id: "a", capture_id: "cap-1" })];
    const orphans = selectOrphans(rows, new Set(), new Set(["cap-1"]), CUTOFF);
    expect(orphans).toEqual([]);
  });

  it("selects a row whose capture no longer exists", () => {
    const rows = [row({ id: "a", capture_id: "cap-gone" })];
    // liveCaptureIds has a different capture — cap-gone is dead.
    const orphans = selectOrphans(rows, new Set(), new Set(["cap-1"]), CUTOFF);
    expect(orphans.map((r) => r.id)).toEqual(["a"]);
  });

  it("keeps a too-new row even when fully unreferenced", () => {
    const rows = [row({ id: "a", created_at: NEW })];
    const orphans = selectOrphans(rows, new Set(), new Set(), CUTOFF);
    expect(orphans).toEqual([]);
  });

  it("does not reap a row exactly at the cutoff (strict <)", () => {
    const rows = [row({ id: "a", created_at: CUTOFF })];
    const orphans = selectOrphans(rows, new Set(), new Set(), CUTOFF);
    expect(orphans).toEqual([]);
  });

  it("handles null capture_id as not-pinned (eligible when old + unref'd)", () => {
    const rows = [row({ id: "a", capture_id: null })];
    // Even with a populated liveCaptureIds set, a null capture is never pinned.
    const orphans = selectOrphans(rows, new Set(), new Set(["cap-1"]), CUTOFF);
    expect(orphans.map((r) => r.id)).toEqual(["a"]);
  });

  it("filters a mixed batch to only the true orphans", () => {
    const rows = [
      row({ id: "orphan-old" }), // selected
      row({ id: "referenced" }), // kept: referenced
      row({ id: "too-new", created_at: NEW }), // kept: grace period
      row({ id: "live-cap", capture_id: "cap-live" }), // kept: live capture
      row({ id: "dead-cap", capture_id: "cap-dead" }), // selected
    ];
    const orphans = selectOrphans(
      rows,
      new Set(["referenced"]),
      new Set(["cap-live"]),
      CUTOFF,
    );
    expect(orphans.map((r) => r.id).sort()).toEqual(["dead-cap", "orphan-old"]);
  });

  it("requires ALL conditions — referenced AND new AND live stays kept", () => {
    const rows = [
      row({ id: "a", created_at: NEW, capture_id: "cap-live" }),
    ];
    const orphans = selectOrphans(
      rows,
      new Set(["a"]),
      new Set(["cap-live"]),
      CUTOFF,
    );
    expect(orphans).toEqual([]);
  });
});
