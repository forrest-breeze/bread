// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { PortalDnsInstructions } from "./portal-dns-instructions"

describe("PortalDnsInstructions", () => {
  it("shows provider-ready values and links to Cloudflare DNS", () => {
    render(
      <PortalDnsInstructions
        domain="help.acme.com"
        record={{
          type: "CNAME",
          host: "help",
          target: "app.example.com",
          isApex: false,
        }}
      />,
    )

    expect(screen.getByText("CNAME")).toBeInTheDocument()
    expect(screen.getByText("help")).toBeInTheDocument()
    expect(screen.getByText("app.example.com")).toBeInTheDocument()
    expect(screen.getByText("DNS only")).toBeInTheDocument()
    expect(
      screen.getByRole("link", { name: /Open Cloudflare DNS/i }),
    ).toHaveAttribute(
      "href",
      "https://dash.cloudflare.com/?to=%2F%3Aaccount%2F%3Azone%2Fdns%2Frecords",
    )
  })

  it("explains apex CNAME flattening", () => {
    render(
      <PortalDnsInstructions
        domain="acme.com"
        record={{
          type: "CNAME",
          host: "@",
          target: "app.example.com",
          isApex: true,
        }}
      />,
    )

    expect(screen.getByText(/Cloudflare flattens a CNAME/)).toBeInTheDocument()
  })
})
