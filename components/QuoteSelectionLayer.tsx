"use client";

/**
 * LibreChat/ChatGPT-style "quote to chat" selection layer, extended with a
 * per-excerpt comment (评论) action.
 *
 * Watches document-level text selections; when a selection lives entirely
 * inside one rendered chat message (a `[data-omp-entry-id]` wrapper), a small
 * floating pair of actions appears near it:
 *   ❝ 引用  — queue the excerpt as-is
 *   💬 评论 — open an inline input; the remark is attached to the excerpt and
 *             sent together with it
 * Excerpts land in the composer's pending-quote queue (removable chips above
 * the textarea) and are drained into the next outgoing message / steer.
 *
 * Pointer and touch platforms surface selections differently: a mouse drag
 * ends in `mouseup`, while a long-press or native-handle drag (touch) emits
 * only `selectionchange` with no mouse event. Both paths are handled — mouse
 * selections show immediately, mouse-less ones after a short settle window —
 * so the popup is reachable on phones as well as desktops.
 *
 * Rendered through a portal so `fixed` positioning stays viewport-relative
 * regardless of transformed ancestors; positions track the selection while
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
/** Max characters for a user comment attached to an excerpt. */
const MAX_COMMENT_LENGTH = 500;
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
  /** Retained so scrolling can re-measure without re-walking the selection. */
  range: Range;
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

/** Place a popup on the preferred side of the anchor, fallback + clamp. */
function computePos(anchor: AnchorRect, el: HTMLElement, below: boolean): { left: number; top: number } {
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  const centerX = (anchor.left + anchor.right) / 2;
  const left = Math.min(
    Math.max(EDGE_MARGIN, centerX - width / 2),
    Math.max(EDGE_MARGIN, window.innerWidth - width - EDGE_MARGIN),
  );
  const maxTop = Math.max(EDGE_MARGIN, window.innerHeight - height - EDGE_MARGIN);
  const above = anchor.top - POPUP_OFFSET - height;
  const under = anchor.bottom + POPUP_OFFSET;
  const [preferred, fallback] = below ? [under, above] : [above, under];
  let top = preferred;
  if (top < EDGE_MARGIN || top > maxTop) top = fallback;
  top = Math.min(Math.max(top, EDGE_MARGIN), maxTop);
  return { left, top };
}

// useLayoutEffect warns during SSR; the popups only mount client-side anyway.
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function QuoteSelectionLayer({ containerRef, onQuote, disabled = false }: Props) {
  const { t } = useI18n();
  const [sel, setSel] = useState<SelectionInfo | null>(null);
  const [commentFor, setCommentFor] = useState<SelectionInfo | null>(null);
  const [commentText, setCommentText] = useState("");
  const selRef = useRef<SelectionInfo | null>(null);
  const commentRef = useRef<SelectionInfo | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const commentBoxRef = useRef<HTMLDivElement | null>(null);
  const commentInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [commentPos, setCommentPos] = useState<{ left: number; top: number } | null>(null);
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
    publish(null);
  }, [publish]);

  const closeComment = useCallback(() => {
    commentRef.current = null;
    setCommentFor(null);
    setCommentText("");
  }, []);

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
    return { quote: { text, entryId, entryIndex }, anchor, below: belowRef.current, range };
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
      const target = e.target instanceof Node ? e.target : null;
      if (target && popupRef.current?.contains(target)) return;
      if (target && commentBoxRef.current?.contains(target)) return;
      hide();
      closeComment();
    };
    const onMouseUp = () => {
      mouseDragging = false;
      show();
    };
    // Reposition while scrolling (capture: the chat list scrolls itself).
    const onReflow = () => {
      if (selRef.current) show();
      const open = commentRef.current;
      if (open) {
        const anchor = anchorFromRange(open.range);
        if (!anchor) {
          closeComment();
        } else {
          const next: SelectionInfo = sameAnchor(open.anchor, anchor) ? open : { ...open, anchor };
          setCommentFor(next);
        }
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        hide();
        closeComment();
      }
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
  }, [disabled, hide, publish, readSelection, closeComment]);

  // Keep a ref in sync for event handlers.
  useEffect(() => {
    selRef.current = sel;
  }, [sel]);

  // Measure + position both popups (prefer above the selection, fallback below).
  useIsoLayoutEffect(() => {
    if (!sel || !popupRef.current) {
      setPos(null);
      return;
    }
    setPos(computePos(sel.anchor, popupRef.current, sel.below));
  }, [sel]);

  useIsoLayoutEffect(() => {
    if (!commentFor || !commentBoxRef.current) {
      setCommentPos(null);
      return;
    }
    setCommentPos(computePos(commentFor.anchor, commentBoxRef.current, commentFor.below));
  }, [commentFor]);

  const commitQuote = useCallback(() => {
    const cap = selRef.current;
    if (!cap) return;
    onQuote(cap.quote);
    hide();
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      // ignore
    }
  }, [onQuote, hide]);

  const startComment = useCallback(() => {
    const cap = selRef.current;
    if (!cap) return;
    commentRef.current = cap;
    setCommentFor(cap);
    setCommentText("");
    publish(null); // hide the action row; the comment box takes over
    requestAnimationFrame(() => commentInputRef.current?.focus());
  }, [publish]);

  const confirmComment = useCallback(() => {
    const cap = commentRef.current;
    if (!cap) return;
    const comment = commentText.trim().slice(0, MAX_COMMENT_LENGTH);
    onQuote({ ...cap.quote, comment: comment || undefined });
    closeComment();
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      // ignore
    }
  }, [commentText, onQuote, closeComment]);

  const popupStyle: React.CSSProperties = {
    position: "fixed",
    left: pos?.left ?? -9999,
    top: pos?.top ?? -9999,
    visibility: pos ? "visible" : "hidden",
    zIndex: 1000,
    display: "flex",
    alignItems: "stretch",
    gap: 2,
    padding: 3,
    borderRadius: 10,
    border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
    background: "var(--bg-panel, var(--bg))",
    boxShadow: "0 4px 16px -4px rgba(15,23,42,0.18)",
  };

  const actionStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 12px",
    borderRadius: 7,
    border: "none",
    background: "none",
    color: "var(--text)",
    fontSize: 13,
    lineHeight: 1,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };

  return (
    <>
      {sel && !commentFor && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={popupRef}
              style={popupStyle}
              onPointerDown={(e) => {
                // Preserve the live selection on mouse (suppresses focus/selection clearing).
                if (e.pointerType === "mouse") e.preventDefault();
              }}
            >
              <button
                type="button"
                style={actionStyle}
                title={t("chat.quoteAdd")}
                onPointerUp={(e) => {
                  if (e.currentTarget.contains(e.target as Node)) commitQuote();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    commitQuote();
                  }
                }}
              >
                <span aria-hidden style={{ fontSize: 14, lineHeight: 1 }}>
                  ❝
                </span>
                {t("chat.quoteAdd")}
              </button>
              <span aria-hidden style={{ width: 1, background: "var(--border)", margin: "2px 0" }} />
              <button
                type="button"
                style={actionStyle}
                title={t("chat.commentAdd")}
                onPointerUp={(e) => {
                  if (e.currentTarget.contains(e.target as Node)) startComment();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    startComment();
                  }
                }}
              >
                <span aria-hidden style={{ fontSize: 13, lineHeight: 1 }}>
                  💬
                </span>
                {t("chat.commentAdd")}
              </button>
            </div>,
            document.body,
          )
        : null}

      {commentFor && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={commentBoxRef}
              style={{
                position: "fixed",
                left: commentPos?.left ?? -9999,
                top: commentPos?.top ?? -9999,
                visibility: commentPos ? "visible" : "hidden",
                zIndex: 1000,
                width: 320,
                maxWidth: `calc(100vw - ${EDGE_MARGIN * 2}px)`,
                padding: 10,
                borderRadius: 10,
                border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
                background: "var(--bg-panel, var(--bg))",
                boxShadow: "0 8px 24px -8px rgba(15,23,42,0.25)",
              }}
            >
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 6 }}>
                💬 {t("chat.commentAdd")}
              </div>
              <div
                style={{
                  maxHeight: 72,
                  overflowY: "auto",
                  padding: "4px 8px",
                  marginBottom: 6,
                  borderRadius: 6,
                  background: "color-mix(in srgb, var(--border) 25%, transparent)",
                  fontSize: 11,
                  color: "var(--text-muted)",
                  lineHeight: 1.5,
                }}
              >
                {commentFor.quote.text}
              </div>
              <textarea
                ref={commentInputRef}
                value={commentText}
                maxLength={MAX_COMMENT_LENGTH}
                placeholder={t("chat.commentPlaceholder")}
                rows={3}
                onChange={(e) => setCommentText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    e.stopPropagation();
                    confirmComment();
                  }
                }}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  resize: "none",
                  border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
                  borderRadius: 6,
                  background: "var(--bg)",
                  color: "var(--text)",
                  fontSize: 12,
                  lineHeight: 1.5,
                  padding: "6px 8px",
                  outline: "none",
                }}
              />
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 6 }}>
                <button
                  type="button"
                  onClick={closeComment}
                  style={{
                    border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
                    background: "none",
                    color: "var(--text-muted)",
                    fontSize: 12,
                    padding: "4px 10px",
                    borderRadius: 6,
                    cursor: "pointer",
                  }}
                >
                  {t("chat.quoteCancel")}
                </button>
                <button
                  type="button"
                  onClick={confirmComment}
                  style={{
                    border: "none",
                    background: "var(--accent, #2563eb)",
                    color: "#fff",
                    fontSize: 12,
                    padding: "4px 10px",
                    borderRadius: 6,
                    cursor: "pointer",
                  }}
                >
                  {t("chat.quoteConfirm")}
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
