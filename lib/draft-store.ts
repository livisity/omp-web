export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

/** A quoted excerpt captured from a chat message via the selection popup. */
export interface QuoteDraft {
  text: string;
  /** Session entry the excerpt came from, when known. */
  entryId?: string;
  entryIndex?: number;
}

/** A pending quote queued in the composer (QuoteDraft + stable key). */
export interface PendingQuote extends QuoteDraft {
  id: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
  quotes?: PendingQuote[];
}

const drafts = new Map<string, ChatDraft>();

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
    quotes: draft.quotes?.map((quote) => ({ ...quote })),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0 && (!draft.quotes || draft.quotes.length === 0);
}

export function getDraft(key: string): ChatDraft | null {
  const draft = drafts.get(key);
  return draft ? cloneDraft(draft) : null;
}

export function setDraft(key: string, draft: ChatDraft): void {
  if (isEmptyDraft(draft)) {
    drafts.delete(key);
    return;
  }
  drafts.set(key, cloneDraft(draft));
}

export function clearDraft(key: string): void {
  drafts.delete(key);
}
