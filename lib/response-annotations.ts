/**
 * Codex-compatible "response annotations" protocol.
 *
 * Quoted excerpts (with optional user comments) selected from an earlier
 * assistant reply are sent as a structured envelope, and the model is asked to
 * embed `:codex-annotation{index="N"}` directives inline in its answer so the
 * UI can anchor answer fragments back to the annotated spans. Wire format
 * mirrors the Codex desktop app (app.asar v26.831):
 *
 *   \n# Response annotations:\n
 *   {instruction paragraph}\n
 *   <response-annotations>\n
 *   [{"text":"…","annotation":"…"},…]\n
 *   </response-annotations>\n
 *   \n## My request:\n
 *   {typed text}\n
 */

import type { PendingQuote } from "./draft-store";

export const ANNOTATIONS_HEADER = "# Response annotations:";
export const ANNOTATIONS_OPEN = "<response-annotations>";
export const ANNOTATIONS_CLOSE = "</response-annotations>";
export const MY_REQUEST_HEADER = "## My request:";

export interface ResponseAnnotation {
  text: string;
  annotation?: string;
}

const INSTRUCTIONS =
  "Each item contains text selected from an earlier Codex response and may include a user comment. " +
  "Treat items as Annotation 1, Annotation 2, and so on in array order. Use every selection as context and " +
  "address every comment. For every annotation you address, include its inline directive " +
  '`:codex-annotation{index="N"}`, where N is its one-based array position ' +
  '(for example, `:codex-annotation{index="1"}`). Do not use unstructured annotation labels.';

/** Compose the Codex-style annotations envelope followed by the typed request. */
export function buildAnnotationsEnvelope(quotes: PendingQuote[], typed: string): string {
  const items: ResponseAnnotation[] = quotes.map((q) =>
    q.comment ? { text: q.text, annotation: q.comment } : { text: q.text },
  );
  const json = JSON.stringify(items);
  return (
    `\n${ANNOTATIONS_HEADER}\n` +
    `${INSTRUCTIONS}\n` +
    `${ANNOTATIONS_OPEN}\n` +
    `${json}\n` +
    `${ANNOTATIONS_CLOSE}\n\n` +
    `${MY_REQUEST_HEADER}\n` +
    `${typed}\n`
  );
}

export interface ParsedAnnotationsEnvelope {
  annotations: ResponseAnnotation[];
  /** Typed text after `## My request:` (may be empty). */
  requestText: string;
}

/** Parse an annotations envelope out of a user message; null when absent/malformed. */
export function parseAnnotationsEnvelope(text: string): ParsedAnnotationsEnvelope | null {
  if (!text.includes(ANNOTATIONS_HEADER) || !text.includes(ANNOTATIONS_OPEN)) return null;
  const headerIdx = text.indexOf(ANNOTATIONS_HEADER);
  const openIdx = text.indexOf(ANNOTATIONS_OPEN, headerIdx);
  if (openIdx === -1) return null;
  const closeIdx = text.indexOf(ANNOTATIONS_CLOSE, openIdx + ANNOTATIONS_OPEN.length);
  if (closeIdx === -1) return null;
  const json = text.slice(openIdx + ANNOTATIONS_OPEN.length, closeIdx).trim();
  let annotations: ResponseAnnotation[];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;
    annotations = parsed.filter(
      (item): item is ResponseAnnotation =>
        !!item && typeof item === "object" && typeof (item as ResponseAnnotation).text === "string",
    );
  } catch {
    return null;
  }
  if (annotations.length === 0) return null;
  let requestText = text.slice(closeIdx + ANNOTATIONS_CLOSE.length);
  const reqIdx = requestText.indexOf(MY_REQUEST_HEADER);
  requestText = reqIdx !== -1 ? requestText.slice(reqIdx + MY_REQUEST_HEADER.length) : "";
  return { annotations, requestText: requestText.replace(/^\n+/, "").replace(/\n+$/, "") };
}

const DIRECTIVE_RE = /:codex-annotation\{index="(\d+)"\}/g;
const CODE_MASK_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g;

export interface AnnotationLabelFns {
  /** Localized inline label for Annotation N. */
  badge: (n: number) => string;
  /** Localized hover-tooltip text for Annotation N. */
  tooltip: (annotation: ResponseAnnotation, n: number) => string;
}

/**
 * Replace valid `:codex-annotation{index="N"}` directives with markdown badge
 * links carrying a hover tooltip. Code blocks/spans are masked out first, and
 * indices beyond the annotation list are left untouched (anti-hallucination,
 * mirroring the Codex app).
 */
export function renderAnnotationDirectives(
  text: string,
  annotations: ResponseAnnotation[] | undefined,
  labels: AnnotationLabelFns,
): string {
  if (!annotations?.length || !text.includes(":codex-annotation")) return text;
  const masks: string[] = [];
  const masked = text.replace(CODE_MASK_RE, (match) => {
    masks.push(match);
    return `\u0000${masks.length - 1}\u0000`;
  });
  const replaced = masked.replace(DIRECTIVE_RE, (raw, num: string) => {
    const index = Number(num);
    const annotation = annotations[index - 1];
    if (!annotation) return raw; // unknown index — keep the raw directive
    const label = labels.badge(index);
    const tip = labels.tooltip(annotation, index)
      .replace(/"/g, "&quot;")
      .replace(/\n+/g, " ")
      .slice(0, 400);
    return `[${label}](#omp-annotation-${index} "${tip}")`;
  });
  return replaced.replace(/\u0000(\d+)\u0000/g, (_, i: string) => masks[Number(i)] ?? "");
}
