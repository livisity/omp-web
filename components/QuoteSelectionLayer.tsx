"use client";

/**
 * LibreChat/ChatGPT-style "quote to chat" selection layer.
 *
 * Watches document-level text selections; when a selection lives entirely
 * inside one rendered chat message (a `[data-omp-entry-id]` wrapper), a small
 * floating button appears near it. Activating the button pushes the excerpt
 * into the composer's pending-quote queue (rendered as removable chips above
 * the textarea and drained into the next outgoing message).
 *
 * Pointer and touch platforms surface selections differently: a mouse drag
 * ends in `mouseup`, while a long-press or native-handle drag (touch) emits
 * only `selectionchange` with no mouse event. Both paths are handled — mouse
 * selections show immediately, mouse-less ones after a short settle window —
 * so the button is reachable on phones as well as desktops.
 *
 * Rendered through a portal so `fixed` positioning stays viewport-relative
 * regardless of transformed ancestors; the position tracks the selection while
 * the page scrolls instead of dismissing on the first scroll event.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import type { QuoteDraft } from "@/lib/draft-store";

interface Props {
  /** Scrollable element that hosts the rendered chat messages. */
  containerRef: React.RefObject<HTMLElement | null>;
  onQuote: (quote: QuoteDraft) => void;
  disabled?: boolean;
}

/** Max characters captured per excerpt (defense against giant selections). */
const MAX_QUOTE_LENGTH = 1500;
/** Vertical gap (px) between the selection and the popup. */
const POPUP_OFFSET = 8;
/** Keep the popup this far (px) from the viewport edges. */
const EDGE_MARGIN = 12;
/** Quiet period before a mouse-less selection (touch long-press, native
 *  handle drag, keyboard extend) is treated as final. Every change restarts
 *  it, so the popup lands once the selection stops moving. */
const SETTLE_MS = 300;

type AnchorRect = { top: number; bottom: number; left: number; right: number };

interface SelectionInfo {
  quote: QuoteDraft;
  anchor: AnchorRect;
  /** Touch selections carry an OS callout above them, so the popup goes below. */
  below: boolean;
}

function elementFromNode(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const el = node instanceof Element ? node : node.parentElement;
  return el instanceof HTMLElement ? el : null;
}

function anchorFromRange(range: Range): AnchorRect | null {
  let top = Infinity;
  let bottom = -Infinity;
  let left = Infinity;
  let right = -Infinity;
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width === 0 && rect.height === 0) continue;
    top = Math.min(top, rect.top);
    bottom = Math.max(bottom, rect.bottom);
    left = Math.min(left, rect.left);
    right = Math.max(right, rect.right);
  }
  if (!Number.isFinite(top)) {
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
  }
  return { top, bottom, left, right };
}

const sameAnchor = (a: AnchorRect, b: AnchorRect): boolean =>
  a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right;

export function QuoteSelectionLayer({ containerRef, onQuote, disabled = false }: Props) {
  const { t } = useI18n();
  const [sel, setSel] = useState<SelectionInfo | null>(null);
  const selRef = useRef<SelectionInfo | null>(null);
  const popupRef = useRef<HTMLButtonElement | null>(null);
  /** Excerpt captured when a press begins, committed only if it completes on the button. */
  const pressedRef = useRef<SelectionInfo | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const belowRef = useRef(false);

  const publish = useCallback((next: SelectionInfo | null) => {
    setSel((prev) => {
      if (
        next &&
        prev &&
        prev.quote.text === next.quote.text &&
        prev.below === next.below &&
        sameAnchor(prev.anchor, next.anchor)
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  const hide = useCallback(() => {
    pressedRef.current = null;
    publish(null);
  }, [publish]);

  const readSelection = useCallback((): SelectionInfo | null => {
    const container = containerRef.current;
    const selection = typeof window === "undefined" ? null : window.getSelection();
    if (!container || !selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    const startEl = elementFromNode(range.startContainer);
    const endEl = elementFromNode(range.endContainer);
    if (!startEl || !endEl) return null;
    if (!container.contains(startEl) || !container.contains(endEl)) return null;
    // The selection must live inside a single rendered message wrapper.
    const wrapper = startEl.closest<HTMLElement>("[data-omp-entry-id]");
    if (!wrapper || !wrapper.contains(endEl)) return null;
    const raw = selection.toString().replace(/\r\n/g, "\n").trim();
    if (!raw) return null;
    const anchor = anchorFromRange(range);
    if (!anchor) return null;
    const entryId = wrapper.getAttribute("data-omp-entry-id") ?? undefined;
    const idxRaw = wrapper.getAttribute("data-omp-msg-index");
    const entryIndex = idxRaw !== null && idxRaw !== "" ? Number(idxRaw) : undefined;
    const text = raw.length > MAX_QUOTE_LENGTH ? `${raw.slice(0, MAX_QUOTE_LENGTH)}…` : raw;
    return { quote: { text, entryId, entryIndex }, anchor, below: belowRef.current };
  }, [containerRef]);

  // Selection lifecycle: mouse paths show on mouseup, mouse-less paths settle.
  useEffect(() => {
    if (disabled) {
      publish(null);
      return;
    }
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let mouseDragging = false;

    const clearSettle = () => {
      if (settleTimer !== undefined) {
        clearTimeout(settleTimer);
        settleTimer = undefined;
      }
    };

    const show = () => {
      clearSettle();
      publish(readSelection());
    };

    const onSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        hide();
        return;
      }
      if (mouseDragging) return; // shown on mouseup instead
      if (belowRef.current) {
        // Touch/keyboard path: wait for the selection to settle.
        clearSettle();
        settleTimer = setTimeout(show, SETTLE_MS);
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      belowRef.current = e.pointerType !== "mouse";
      mouseDragging = e.pointerType === "mouse";
      if (popupRef.current && e.target instanceof Node && popupRef.current.contains(e.target)) return;
      hide();
    };
    const onMouseUp = () => {
      mouseDragging = false;
      show();
    };
    // Reposition while scrolling (capture: the chat list scrolls itself).
    const onReflow = () => {
      if (selRef.current) show();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };

    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("mouseup", onMouseUp, true);
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      clearSettle();
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("mouseup", onMouseUp, true);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [disabled, hide, publish, readSelection]);

  // Keep a ref in sync for event handlers, and drop stale press state.
  useEffect(() => {
    selRef.current = sel;
    if (!sel) pressedRef.current = null;
  }, [sel]);

  // Measure + position: prefer above the selection, fallback below, clamped.
  useLayoutEffect(() => {
    if (!sel || !popupRef.current) {
      setPos(null);
      return;
    }
    const width = popupRef.current.offsetWidth;
    const height = popupRef.current.offsetHeight;
    const centerX = (sel.anchor.left + sel.anchor.right) / 2;
    const left = Math.min(
      Math.max(EDGE_MARGIN, centerX - width / 2),
      Math.max(EDGE_MARGIN, window.innerWidth - width - EDGE_MARGIN),
    );
    const maxTop = Math.max(EDGE_MARGIN, window.innerHeight - height - EDGE_MARGIN);
    const above = sel.anchor.top - POPUP_OFFSET - height;
    const below = sel.anchor.bottom + POPUP_OFFSET;
    const [preferred, fallback] = sel.below ? [below, above] : [above, below];
    let top = preferred;
    if (top < EDGE_MARGIN || top > maxTop) top = fallback;
    top = Math.min(Math.max(top, EDGE_MARGIN), maxTop);
    setPos({ left, top });
  }, [sel]);

  const commit = useCallback(
    (cap: SelectionInfo) => {
      onQuote(cap.quote);
      publish(null);
      try {
        window.getSelection()?.removeAllRanges();
      } catch {
        // ignore
      }
    },
    [onQuote, publish],
  );

  if (!sel || typeof document === "undefined") return null;

  const style: React.CSSProperties = {
    position: "fixed",
    left: pos?.left ?? -9999,
    top: pos?.top ?? -9999,
    visibility: pos ? "visible" : "hidden",
    zIndex: 1000,
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 12px",
    borderRadius: 10,
    border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
    background: "var(--bg-panel, var(--bg))",
    color: "var(--text)",
    fontSize: 13,
    lineHeight: 1,
    boxShadow: "0 4px 16px -4px rgba(15,23,42,0.18)",
    cursor: "pointer",
  };

  return createPortal(
    <button
      ref={popupRef}
      type="button"
      style={style}
      title={t("chat.quoteAdd")}
      aria-label={t("chat.quoteAdd")}
      onPointerDown={(e) => {
        // Preserve the live selection on mouse; touch captures at press start.
        if (e.pointerType === "mouse") e.preventDefault();
        pressedRef.current = selRef.current;
      }}
      onPointerUp={(e) => {
        const cap = pressedRef.current;
        pressedRef.current = null;
        if (cap && e.currentTarget.contains(e.target as Node)) commit(cap);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          commit(sel);
        }
      }}
    >
      <span aria-hidden style={{ fontSize: 14, lineHeight: 1 }}>
        ❝
      </span>
      {t("chat.quoteAdd")}
    </button>,
    document.body,
  );
}
