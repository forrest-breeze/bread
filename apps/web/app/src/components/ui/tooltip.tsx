"use client"

import type { ReactElement, ReactNode } from "react"
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import { Info } from "lucide-react"

import { cn } from "@/lib/utils"

function TooltipProvider({
  delay = 0,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      {...props}
    />
  )
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-2 rounded-lg border border-background/15 bg-foreground/95 px-2.5 py-1.5 text-xs text-background shadow-[0_10px_30px_-10px_rgb(0_0_0/0.55)] backdrop-blur-md data-[side=bottom]:slide-in-from-top-1 data-[side=inline-end]:slide-in-from-left-1 data-[side=inline-start]:slide-in-from-right-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        >
          {children}
          <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground data-[side=bottom]:top-1 data-[side=inline-end]:top-1/2! data-[side=inline-end]:-left-1 data-[side=inline-end]:-translate-y-1/2 data-[side=inline-start]:top-1/2! data-[side=inline-start]:-right-1 data-[side=inline-start]:-translate-y-1/2 data-[side=left]:top-1/2! data-[side=left]:-right-1 data-[side=left]:-translate-y-1/2 data-[side=right]:top-1/2! data-[side=right]:-left-1 data-[side=right]:-translate-y-1/2 data-[side=top]:-bottom-2.5" />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

interface AppTooltipProps {
  children: ReactElement
  label: ReactNode
  description?: ReactNode
  shortcut?: ReactNode
  side?: TooltipPrimitive.Positioner.Props["side"]
  sideOffset?: number
  align?: TooltipPrimitive.Positioner.Props["align"]
  alignOffset?: number
  className?: string
}

/**
 * The standard tooltip for app controls. It keeps labels, optional supporting
 * copy, and keyboard hints visually consistent without making every caller
 * rebuild the Base UI trigger/content composition.
 */
function AppTooltip({
  children,
  label,
  description,
  shortcut,
  side = "top",
  sideOffset = 8,
  align = "center",
  alignOffset = 0,
  className,
}: AppTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        className={cn(description && "max-w-64 items-start py-2", className)}
      >
        <span className="min-w-0">
          <span className="block font-medium leading-4">{label}</span>
          {description && (
            <span className="mt-0.5 block text-[11px] leading-4 text-background/65">
              {description}
            </span>
          )}
        </span>
        {shortcut && (
          <kbd
            data-slot="kbd"
            className="ml-auto inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded border border-background/15 bg-background/10 px-1.5 font-mono text-[10px] font-medium leading-none text-background/75 shadow-sm"
          >
            {shortcut}
          </kbd>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

interface InfoHintProps {
  children: ReactNode
  side?: TooltipPrimitive.Positioner.Props["side"]
  className?: string
}

/**
 * A muted info glyph that reveals help copy on hover/focus. Use it beside a
 * label or section heading instead of a persistent explainer paragraph when
 * the copy is guidance rather than state the user must see.
 */
function InfoHint({ children, side = "top", className }: InfoHintProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="More information"
            className={cn(
              "inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              className
            )}
          >
            <Info className="size-3.5" />
          </button>
        }
      />
      <TooltipContent
        side={side}
        className="max-w-64 items-start py-2 text-[11px] leading-4 font-normal"
      >
        <span className="min-w-0">{children}</span>
      </TooltipContent>
    </Tooltip>
  )
}

export {
  AppTooltip,
  InfoHint,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
}
