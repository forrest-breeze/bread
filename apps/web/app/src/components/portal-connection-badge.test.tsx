// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PortalConnectionBadge } from "./portal-connection-badge";

describe("PortalConnectionBadge", () => {
  it.each([
    ["pending", "Pending"],
    ["connected", "Connected"],
    ["needs_update", "Update required"],
    ["not_connected", "Not connected"],
  ] as const)("renders the %s state", (status, label) => {
    render(<PortalConnectionBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
