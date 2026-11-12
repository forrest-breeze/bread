"use client"

import { useState } from "react"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Publish confirmation dialog. Publishing pushes the draft to the PUBLIC
// portal, so it's an explicit two-step action: open the dialog, then confirm.
// The server independently requires { confirm: true }; this is the UI half.
// ---------------------------------------------------------------------------

interface PublishDialogProps {
  brandName: string
  dirty: boolean
  publishing: boolean
  onConfirm: () => Promise<boolean>
  disabled?: boolean
  className?: string
}

export function PublishDialog({
  brandName,
  dirty,
  publishing,
  onConfirm,
  disabled,
  className,
}: PublishDialogProps): React.ReactElement {
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            size="sm"
            disabled={disabled || publishing || dirty}
            className={cn("px-3", className)}
          />
        }
      >
        {publishing ? "Publishing..." : "Publish"}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish to the public portal?</DialogTitle>
          <DialogDescription>
            This replaces the live public knowledge base for <strong>{brandName}</strong> with
            the saved changes. Anyone with the portal link will see these changes immediately.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            disabled={publishing}
            onClick={async () => {
              if (await onConfirm()) setOpen(false)
            }}
          >
            {publishing ? "Publishing..." : "Publish now"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
