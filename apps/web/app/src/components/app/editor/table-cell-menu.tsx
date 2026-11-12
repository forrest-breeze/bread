"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import {
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  ChevronDown,
  Heading,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface CellAnchor {
  /** Offset from the wrapper's top-left, in the wrapper's own (unzoomed) px. */
  top: number;
  left: number;
}

/** The DOM of the table cell holding the selection, if any. */
function selectedCellDom(editor: Editor): HTMLElement | null {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const name = $from.node(depth).type.name;
    if (name === "tableCell" || name === "tableHeader") {
      const dom = editor.view.nodeDOM($from.before(depth));
      return dom instanceof HTMLElement ? dom : null;
    }
  }
  return null;
}

// Chain methods come from TableKit at runtime; they aren't on the base type.
type TableChain = {
  focus: () => TableChain;
  addRowBefore: () => TableChain;
  addRowAfter: () => TableChain;
  addColumnBefore: () => TableChain;
  addColumnAfter: () => TableChain;
  deleteRow: () => TableChain;
  deleteColumn: () => TableChain;
  deleteTable: () => TableChain;
  toggleHeaderRow: () => TableChain;
  run: () => boolean;
};
type TableAction = Exclude<keyof TableChain, "focus" | "run">;

interface MenuEntry {
  label: string;
  action: TableAction;
  icon: ReactNode;
  danger?: boolean;
}

const MENU: MenuEntry[][] = [
  [
    {
      label: "Toggle header row",
      action: "toggleHeaderRow",
      icon: <Heading className="size-3.5" />,
    },
  ],
  [
    {
      label: "Insert row above",
      action: "addRowBefore",
      icon: <ArrowUpToLine className="size-3.5" />,
    },
    {
      label: "Insert row below",
      action: "addRowAfter",
      icon: <ArrowDownToLine className="size-3.5" />,
    },
    {
      label: "Insert column to the left",
      action: "addColumnBefore",
      icon: <ArrowLeftToLine className="size-3.5" />,
    },
    {
      label: "Insert column to the right",
      action: "addColumnAfter",
      icon: <ArrowRightToLine className="size-3.5" />,
    },
  ],
  [
    {
      label: "Delete row",
      action: "deleteRow",
      icon: <Trash2 className="size-3.5" />,
      danger: true,
    },
    {
      label: "Delete column",
      action: "deleteColumn",
      icon: <Trash2 className="size-3.5" />,
      danger: true,
    },
    {
      label: "Delete table",
      action: "deleteTable",
      icon: <Trash2 className="size-3.5" />,
      danger: true,
    },
  ],
];

/**
 * Google Docs-style cell menu: while the caret is in a table cell, a small
 * chevron sits in that cell's top-right corner and opens row/column/table
 * actions. Positioned like BlockHandle (rect ÷ wrapper zoom) so it stays
 * aligned inside the CSS-zoomed preview frame.
 */
export function TableCellMenu({
  editor,
  wrapperRef,
}: {
  editor: Editor;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
}): React.ReactElement | null {
  const [anchor, setAnchor] = useState<CellAnchor | null>(null);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(
    null,
  );
  const [theme, setTheme] = useState<"dark" | "light" | null>(null);

  const measure = useCallback(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || editor.isDestroyed || !editor.isEditable)
      return setAnchor(null);
    const cell = selectedCellDom(editor);
    if (!cell) {
      setAnchor(null);
      setOpen(false);
      return;
    }
    const wrapperRect = wrapper.getBoundingClientRect();
    const zoom =
      wrapper.offsetWidth > 0 ? wrapperRect.width / wrapper.offsetWidth : 1;
    const rect = cell.getBoundingClientRect();
    setAnchor({
      top: (rect.top - wrapperRect.top) / zoom + 4,
      left: (rect.right - wrapperRect.left) / zoom - 24,
    });
  }, [editor, wrapperRef]);

  useEffect(() => {
    measure();
    editor.on("selectionUpdate", measure);
    editor.on("update", measure);
    window.addEventListener("resize", measure);
    // Tables scroll horizontally inside their own wrapper.
    document.addEventListener("scroll", measure, true);
    return () => {
      editor.off("selectionUpdate", measure);
      editor.off("update", measure);
      window.removeEventListener("resize", measure);
      document.removeEventListener("scroll", measure, true);
    };
  }, [editor, measure]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !menuRef.current?.contains(target) &&
        !buttonRef.current?.contains(target)
      )
        setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // The dropdown is portaled to <body> with fixed positioning so overflow
  // clipping in the page layout (sidebars, scroll panes) can't cut it off.
  // It right-aligns under the chevron and is clamped into the viewport.
  useLayoutEffect(() => {
    if (!open) return setMenuPos(null);
    const place = () => {
      const button = buttonRef.current;
      const menu = menuRef.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      const width = menu?.offsetWidth ?? 224;
      const height = menu?.offsetHeight ?? 0;
      const pad = 8;
      let left = rect.right - width;
      left = Math.max(pad, Math.min(left, window.innerWidth - width - pad));
      let top = rect.bottom + 4;
      if (height && top + height > window.innerHeight - pad) {
        top = Math.max(pad, rect.top - height - 4);
      }
      setMenuPos({ top, left });
    };
    const themed = editor.view.dom.closest(".dark, .light");
    setTheme(
      themed ? (themed.classList.contains("dark") ? "dark" : "light") : null,
    );
    place();
    // Re-place once the menu has rendered and its real size is known.
    const frame = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [open, anchor, editor]);

  if (!anchor) return null;

  const run = (action: TableAction) => {
    const chain = editor.chain().focus() as unknown as TableChain;
    chain[action]().run();
    setOpen(false);
  };

  return (
    <div
      data-table-cell-menu=""
      contentEditable={false}
      className="absolute z-20"
      style={{ top: anchor.top, left: anchor.left }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label="Table options"
        aria-expanded={open}
        title="Table options"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex size-5 items-center justify-center rounded border border-border bg-popover text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground",
          open && "bg-accent text-foreground",
        )}
      >
        <ChevronDown className="size-3" />
      </button>
      {open
        ? createPortal(
            <div className={theme ?? undefined}>
              <div
                ref={menuRef}
                role="menu"
                className="fixed z-50 w-56 rounded-lg border border-border bg-popover p-1 shadow-lg"
                style={menuPos ?? { top: 0, left: 0, visibility: "hidden" }}
              >
                {MENU.map((group, index) => (
                  <div
                    key={index}
                    className={cn(
                      index > 0 && "mt-1 border-t border-border pt-1",
                    )}
                  >
                    {group.map((entry) => (
                      <button
                        key={entry.action}
                        type="button"
                        role="menuitem"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => run(entry.action)}
                        className={cn(
                          "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-popover-foreground transition-colors hover:bg-accent",
                          entry.danger &&
                            "hover:bg-destructive/10 hover:text-destructive",
                        )}
                      >
                        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                          {entry.icon}
                        </span>
                        {entry.label}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
