import { describe, expect, it } from "vitest";
import { isTransientSupabaseError } from "./transient-error";

describe("database failure classification", () => {
  it("recognizes a wrapped workspace schema-cache failure", () => {
    expect(isTransientSupabaseError(new Error("workspace lookup failed", { cause: { code: "PGRST002" } }))).toBe(true);
  });
  it.each(["42501", "23505", "PGRST116", "PGRST204"])("does not mask permanent errors (%s)", code => {
    expect(isTransientSupabaseError(new Error("workspace lookup failed", { cause: { code } }))).toBe(false);
  });
});
