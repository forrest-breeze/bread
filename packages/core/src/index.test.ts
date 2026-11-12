/**
 * Tests for the pure runtime exports in @bread/core.
 *
 * @bread/core is predominantly a type-only package, but a handful of runtime
 * values encode domain rules that the rest of the monorepo depends on:
 *   - `CORE_VERSION`          — module identity
 *   - `ROLE_RANKS`            — workspace role hierarchy
 *   - `canManageRole`         — permission predicate derived from the ranks
 *
 * If any of these drift, workspace member management (RLS-free checks in
 * API routes, role pickers in the UI) will silently allow or deny the
 * wrong actions.
 */
import { describe, it, expect } from "vitest";
import {
  canManageRole,
  CORE_VERSION,
  portalUrl,
  ROLE_RANKS,
  BREAD_PORTAL_SLUGS,
  type WorkspaceRole,
} from "./index.js";

describe("portalUrl", () => {
  it("builds a root-relative path with no appUrl", () => {
    expect(portalUrl("bread-help")).toBe("/p/bread-help");
  });

  it("prefixes the origin and trims a trailing slash", () => {
    expect(portalUrl("bread", { appUrl: "https://app.example.com/" })).toBe(
      "https://app.example.com/p/bread",
    );
  });

  it("appends a subpath, normalizing a leading slash", () => {
    expect(portalUrl("bread", { appUrl: "https://app.example.com", subpath: "/doc/abc" })).toBe(
      "https://app.example.com/p/bread/doc/abc",
    );
    expect(portalUrl("bread", { subpath: ":path*" })).toBe("/p/bread/:path*");
  });

  it("exposes the dogfood slug registry", () => {
    expect(BREAD_PORTAL_SLUGS.docs).toBe("bread");
    expect(BREAD_PORTAL_SLUGS.help).toBe("help");
  });
});

describe("CORE_VERSION", () => {
  it("is a non-empty string", () => {
    expect(typeof CORE_VERSION).toBe("string");
    expect(CORE_VERSION.length).toBeGreaterThan(0);
  });
});

describe("ROLE_RANKS", () => {
  it("includes every known WorkspaceRole", () => {
    const expected: WorkspaceRole[] = [
      "owner",
      "admin",
      "editor",
      "viewer",
      "agent-only",
    ];
    for (const role of expected) {
      expect(ROLE_RANKS[role]).toBeTypeOf("number");
    }
    expect(Object.keys(ROLE_RANKS).sort()).toEqual([...expected].sort());
  });

  it("orders roles from owner (highest) to agent-only (lowest)", () => {
    expect(ROLE_RANKS.owner).toBeGreaterThan(ROLE_RANKS.admin);
    expect(ROLE_RANKS.admin).toBeGreaterThan(ROLE_RANKS.editor);
    expect(ROLE_RANKS.editor).toBeGreaterThan(ROLE_RANKS.viewer);
    expect(ROLE_RANKS.viewer).toBeGreaterThan(ROLE_RANKS["agent-only"]);
  });
});

describe("canManageRole", () => {
  const roles: WorkspaceRole[] = [
    "owner",
    "admin",
    "editor",
    "viewer",
    "agent-only",
  ];

  it("owners can manage every role including themselves", () => {
    for (const target of roles) {
      expect(canManageRole("owner", target)).toBe(true);
    }
  });

  it("admins can manage admin and below, not owners", () => {
    expect(canManageRole("admin", "owner")).toBe(false);
    expect(canManageRole("admin", "admin")).toBe(true);
    expect(canManageRole("admin", "editor")).toBe(true);
    expect(canManageRole("admin", "viewer")).toBe(true);
    expect(canManageRole("admin", "agent-only")).toBe(true);
  });

  it("editors cannot manage anyone at or above admin", () => {
    expect(canManageRole("editor", "owner")).toBe(false);
    expect(canManageRole("editor", "admin")).toBe(false);
    expect(canManageRole("editor", "editor")).toBe(true);
    expect(canManageRole("editor", "viewer")).toBe(true);
    expect(canManageRole("editor", "agent-only")).toBe(true);
  });

  it("viewers can only manage viewer and agent-only roles", () => {
    expect(canManageRole("viewer", "owner")).toBe(false);
    expect(canManageRole("viewer", "admin")).toBe(false);
    expect(canManageRole("viewer", "editor")).toBe(false);
    expect(canManageRole("viewer", "viewer")).toBe(true);
    expect(canManageRole("viewer", "agent-only")).toBe(true);
  });

  it("agent-only can only manage agent-only (self)", () => {
    expect(canManageRole("agent-only", "owner")).toBe(false);
    expect(canManageRole("agent-only", "admin")).toBe(false);
    expect(canManageRole("agent-only", "editor")).toBe(false);
    expect(canManageRole("agent-only", "viewer")).toBe(false);
    expect(canManageRole("agent-only", "agent-only")).toBe(true);
  });

  it("is reflexive for every role (a role can always manage peers)", () => {
    for (const role of roles) {
      expect(canManageRole(role, role)).toBe(true);
    }
  });
});
