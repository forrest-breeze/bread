"use client"

import { useState } from "react"
import { Check, Copy, ExternalLink } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { CustomDomainDnsRecord } from "@/lib/workspace-settings"

const CLOUDFLARE_DNS_RECORDS_URL =
  "https://dash.cloudflare.com/?to=%2F%3Aaccount%2F%3Azone%2Fdns%2Frecords"

export function PortalDnsInstructions({
  domain,
  record,
  className,
}: {
  domain: string
  record: CustomDomainDnsRecord
  className?: string
}): React.ReactElement {
  const [copied, setCopied] = useState<string | null>(null)

  const copy = async (value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(value)
      setTimeout(
        () => setCopied((current) => (current === value ? null : current)),
        1500,
      )
    } catch {
      // Clipboard unavailable in insecure contexts.
    }
  }

  return (
    <div className={cn("space-y-3 rounded-md border border-input bg-muted/30 p-3", className)}>
      <div>
        <p className="text-xs font-medium text-foreground">Set up your DNS record</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Add this record at the DNS provider that manages{" "}
          <span className="font-mono text-foreground">{domain}</span>.
        </p>
      </div>

      <ol className="list-decimal space-y-1 pl-4 text-[11px] text-muted-foreground marker:text-foreground">
        <li>Open the domain&apos;s DNS records and choose Add record.</li>
        <li>Enter the type, name, and target shown below.</li>
        <li>
          Keep TTL on Automatic. In Cloudflare, start with Proxy status set to
          DNS only, then save the record.
        </li>
      </ol>

      <div className="space-y-2">
        <DnsValue label="Type" value={record.type} />
        <DnsValue
          label="Name / host"
          value={record.host}
          copied={copied === record.host}
          onCopy={() => void copy(record.host)}
        />
        <DnsValue
          label="Target / content"
          value={record.target}
          copied={copied === record.target}
          onCopy={() => void copy(record.target)}
        />
        <div className="grid grid-cols-2 gap-2">
          <DnsValue label="Cloudflare proxy" value="DNS only" />
          <DnsValue label="TTL" value="Automatic" />
        </div>
      </div>

      {record.isApex ? (
        <p className="text-[11px] text-muted-foreground">
          This is a root domain. Cloudflare flattens a CNAME entered as{" "}
          <span className="font-mono">@</span>. At another provider, use its
          ALIAS/ANAME or CNAME-flattening option if a root CNAME is rejected.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <a
          href={CLOUDFLARE_DNS_RECORDS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Open Cloudflare DNS
          <ExternalLink className="ml-1 size-3" />
        </a>
        <p className="text-[10px] text-muted-foreground">
          Opens your zone&apos;s Records page; review the values before saving.
        </p>
      </div>
    </div>
  )
}

function DnsValue({
  label,
  value,
  copied = false,
  onCopy,
}: {
  label: string
  value: string
  copied?: boolean
  onCopy?: () => void
}): React.ReactElement {
  const content = (
    <>
      <span className="truncate">{value}</span>
      {onCopy ? (
        copied ? (
          <Check className="size-3.5 shrink-0 text-primary" />
        ) : (
          <Copy className="size-3.5 shrink-0 text-muted-foreground" />
        )
      ) : null}
    </>
  )

  return (
    <div className="space-y-0.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      {onCopy ? (
        <button
          type="button"
          onClick={onCopy}
          className="flex min-h-7 w-full items-center justify-between gap-2 rounded border border-input bg-background px-2 py-1 text-left font-mono text-xs transition-colors hover:bg-muted"
        >
          {content}
        </button>
      ) : (
        <div className="flex min-h-7 items-center rounded border border-input bg-background px-2 py-1 font-mono text-xs">
          {content}
        </div>
      )}
    </div>
  )
}
