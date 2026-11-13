"use client"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { CloudflarePortalConnector } from "@/components/cloudflare-portal-connector"
import { verifyPortalProjectAddress } from "@/lib/api/workspace"

export function CloudflareWorkerUpdateDialog({
  open,
  domain,
  pathPrefix,
  projectSlug,
  onOpenChange,
  onUpdated,
}: {
  open: boolean
  domain: string
  pathPrefix: string
  projectSlug: string
  onOpenChange: (open: boolean) => void
  onUpdated: () => void
}): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update the Cloudflare Worker?</DialogTitle>
          <DialogDescription>
            The project is published in Breezify, but the Worker for {domain} does
            not include <span className="font-mono">{pathPrefix}</span> yet.
            Update its route table to make this project available there.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border border-border bg-muted/20 p-3">
          <CloudflarePortalConnector
            domain={domain}
            verifyActivation={async () =>
              (await verifyPortalProjectAddress(projectSlug)).connected
            }
            onConnected={onUpdated}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Not now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
