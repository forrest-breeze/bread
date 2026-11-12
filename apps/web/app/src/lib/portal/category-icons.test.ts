import { describe, expect, it } from "vitest";

import {
  iconForCategory,
  uniqueIconsForCategories,
  uniqueIconsForCategoryEntries,
} from "@/lib/portal/category-icons";

describe("iconForCategory", () => {
  it("routes developer surfaces to the terminal glyph ahead of integrations", () => {
    expect(iconForCategory("API and Developer Tools")).toBe("terminal");
    expect(iconForCategory("API Reference")).toBe("terminal");
    expect(iconForCategory("CLI")).toBe("terminal");
    expect(iconForCategory("Integrations")).toBe("puzzle");
  });

  it("resolves capture and search categories to dedicated glyphs", () => {
    expect(iconForCategory("Capturing Knowledge")).toBe("upload");
    expect(iconForCategory("Search and Retrieval")).toBe("search");
  });

  it("keeps 'rapid' out of the api word-boundary match", () => {
    expect(iconForCategory("Rapid Prototyping")).toBe("layers");
  });
});

describe("uniqueIconsForCategories", () => {
  it("assigns a distinct icon to every category in one surface", () => {
    // The dogfood help center's real topic set.
    const icons = uniqueIconsForCategories([
      "Getting Started",
      "Capturing Knowledge",
      "Search and Retrieval",
      "Integrations & Developer Tools",
      "Account and Billing",
      "Security and Administration",
    ]);
    expect(new Set(icons).size).toBe(icons.length);
    expect(icons[0]).toBe("compass");
    expect(icons[4]).toBe("credit-card");
  });

  it("reassigns collisions to unused alternates, keeping the first natural match", () => {
    const icons = uniqueIconsForCategories(["Integrations", "Platform Setup"]);
    expect(icons[0]).toBe("puzzle");
    expect(icons[1]).not.toBe("puzzle");
    expect(new Set(icons).size).toBe(2);
  });

  it("spreads unmatched labels off the shared fallback", () => {
    const icons = uniqueIconsForCategories(["Zebra", "Quokka"], "folder");
    expect(icons[0]).toBe("folder");
    expect(icons[1]).not.toBe("folder");
  });
});

describe("uniqueIconsForCategoryEntries", () => {
  it("honors distinct explicit icons verbatim", () => {
    const icons = uniqueIconsForCategoryEntries([
      { label: "Getting Started", icon: "sparkles" },
      { label: "Billing", icon: "credit-card" },
    ]);
    expect(icons).toEqual(["sparkles", "credit-card"]);
  });

  it("reassigns explicit duplicates baked into a stored layout", () => {
    // The prospect-portal failure mode: every unmatched title published with
    // the same fallback glyph.
    const icons = uniqueIconsForCategoryEntries([
      { label: "Evaluation and Testing", icon: "layers" },
      { label: "Guardrails and Controls", icon: "layers" },
      { label: "Agent Safety", icon: "layers" },
      { label: "General", icon: "layers" },
    ]);
    expect(icons[0]).toBe("layers");
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("frees a label's natural match when an explicit icon squatted on it", () => {
    const icons = uniqueIconsForCategoryEntries([
      { label: "Zebra", icon: "credit-card" },
      { label: "Billing" },
    ]);
    // "Billing" resolves to credit-card, which Zebra claimed explicitly — it
    // must land on an unused alternate instead of colliding.
    expect(icons[0]).toBe("credit-card");
    expect(icons[1]).not.toBe("credit-card");
    expect(new Set(icons).size).toBe(2);
  });
});
