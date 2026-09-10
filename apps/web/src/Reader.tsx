import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AnchorSelector, DocumentEditOperation, DocumentRepresentation, SourceCitation, SourceSelector } from "@profread/shared";
import Markdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { api, stream } from "./api.js";
import {PdfReader, isPdfSelector, type PdfMarker, type PdfProgress, type PdfReaderHandle, type PdfSelection, type PdfSelector} from './PdfReader.js';
import {
  WriterPanel,
  type WriterSource,
  type WriterWorkspace,
} from "./WriterPanel.js";
type DocumentInfo = {
  id: string;
  title: string;
  version_id: string;
  version: number;
  block_id: string | null;
  offset_ratio: number | null;
  last_thread_id: string | null;
  representations?: DocumentRepresentation[];
  preferredRepresentationId?: string | null;
  pdfSourceAvailable?: boolean;
  pdfJobId?: string | null;
  pdfJobStatus?: string | null;
};
type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  parentMessageId?: string;
  createdAt: string;
  sourceCitations?: SourceCitation[];
};
type Thread = {
  id: string;
  representation_id?: string | null;
  document_id: string;
  anchor_id?: string;
  parent_message_id?: string;
  title?: string;
  block_id?: string;
  exact_quote?: string;
  prefix_text?: string;
  suffix_text?: string;
  status?: "attached" | "unmatched";
  block_type?: string;
  local_start_offset?: number;
  local_end_offset?: number;
  action?: string;
  kind?: "discussion" | "writer";
  selector?: SourceSelector | null;
  representation?: "html" | "pdf";
  annotation_text?: string | null;
  annotation_candidate_text?: string | null;
  annotation_candidate_source_message_id?: string | null;
  annotation_candidate_status?: "pending" | "accepted" | "dismissed" | null;
  annotation_candidate_created_at?: string | null;
  messages: Message[];
};
type HighlightKind = "important" | "question" | "comment";
type Highlight = {
  id: string;
  anchor_id: string;
  block_id: string;
  exact_quote: string;
  prefix_text?: string;
  suffix_text?: string;
  status?: "attached" | "unmatched";
  checked: number;
  local_start_offset: number;
  local_end_offset: number;
  kind: HighlightKind;
  color: string;
  note: string | null;
  selector?: SourceSelector | null;
  representation?: "html" | "pdf";
};
type Model = { id: string; label: string; providerId: string; ready?: boolean };
type TaskRoute = { action: string; modelId: string };
type Artifact = {
  id: string;
  representation_id?: string | null;
  basis_extraction_revision?: number | null;
  kind: string;
  version: number;
  content: any;
  sourceRefs: string[];
  promoted: boolean;
  scope_type: "document" | "section" | "answer" | "thread";
  scope_id: string;
  created_at?: string;
  createdAt?: string;
  freshness?: {
    status: "current" | "needs-review" | "unknown";
    reasons: string[];
  };
  latestReview?: {
    id: string;
    status: "pending" | "applied" | "superseded" | "failed" | "cancelled";
    decision: "KEEP" | "REPLACE" | null;
    rationale: string | null;
    sourceStatus: "adequate" | "material-gap" | "contradiction" | null;
    modelId: string | null;
    artifactVersion: number;
    basis: {
      documentVersionId: string;
      revision: number;
      signalHash: string;
    };
    createdAt: string;
    appliedAt: string | null;
  } | null;
};
export type ThreadPreviewSource =
  | "annotation"
  | "candidate"
  | "thread-compact"
  | "answer-compact"
  | "answer";
export type ThreadPreview = { text: string; source: ThreadPreviewSource };
type ActiveEntry = {
  type: "thread" | "artifact" | "highlight" | "writer";
  id: string;
};
export type SidebarSource = {
  anchor_id?: string | null;
  block_id?: string | null;
  block_type?: string | null;
  exact_quote?: string | null;
  status?: "attached" | "unmatched";
  local_start_offset?: number | null;
  local_end_offset?: number | null;
  selector?: SourceSelector | null;
  representation?: "html" | "pdf";
};
export type SidebarSourceNavigationPayload = {
  type: "reveal-selection";
  blockId: string;
  startOffset: number;
  endOffset: number;
};
export function sidebarSourceNavigationPayload(
  source: SidebarSource,
): SidebarSourceNavigationPayload | null {
  if (source.status === "unmatched" || !source.anchor_id?.trim()) return null;
  const blockId = source.block_id?.trim(),
    startOffset = source.local_start_offset,
    endOffset = source.local_end_offset;
  if (
    !blockId ||
    typeof startOffset !== "number" ||
    !Number.isInteger(startOffset) ||
    startOffset < 0 ||
    typeof endOffset !== "number" ||
    !Number.isInteger(endOffset) ||
    endOffset < startOffset
  )
    return null;
  const visual = Boolean(source.block_type && source.block_type !== "text");
  if (visual) {
    if (startOffset !== 0 || endOffset !== 0) return null;
  } else {
    if (endOffset === startOffset) return null;
    if (
      typeof source.exact_quote === "string" &&
      endOffset - startOffset !== source.exact_quote.length
    )
      return null;
  }
  return { type: "reveal-selection", blockId, startOffset, endOffset };
}
type AskRetry = {
  key: string;
  threadId: string;
  anchorId: string;
  prompt: string;
  requestId: string;
};
export type ReplyRetryState = ReadonlyMap<
  string,
  ReadonlyMap<string, string>
>;
type RunResult = { completed: boolean; requestId: string };
type Selection = AnchorSelector & {
  rect: { top: number; left: number; width: number; height: number };
  visual?: { mimeType: "image/png"; data: string };
  pdfSelector?: PdfSelector;
};
export function pdfSelectionForReader(selection: PdfSelection): Selection {
  const {selector, rect} = selection, first = selector.segments[0]!;
  return {blockId: `pdf:${selector.representationId}:${first.page}:${first.quads[0]?.join(',')}`, blockType: selector.kind === 'pdf-region' ? 'image' : 'text', exact: selector.exact, prefix: '', suffix: '', startOffset: first.startOffset ?? 0, endOffset: first.endOffset ?? 0, rect, pdfSelector: selector};
}
export function sourceRepresentationLabel(source: SidebarSource): string {
  return isPdfSelector(source.selector) ? 'PDF' : 'HTML';
}
export function matchesReadingSource(sourceId: string | null | undefined, activeId: string | null, pdf: boolean): boolean {
  return pdf ? sourceId === activeId : !sourceId || sourceId === activeId || sourceId.startsWith('html-');
}
export function sourceDocumentVersion(document: Pick<DocumentInfo, 'version_id' | 'representations'>, sourceId: string | null | undefined): string {
  return document.representations?.find(source => source.id === sourceId)?.documentVersionId ?? document.version_id;
}
function migratedReaderStorage(storage: Storage, key: string, legacyKey: string): string | null {
  const current = storage.getItem(key);
  if (current !== null) return current;
  const legacy = storage.getItem(legacyKey);
  if (legacy !== null) storage.setItem(key, legacy);
  return legacy;
}
export type SelectionRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};
type PopoverSize = { width: number; height: number };
export type PopoverPlacement = {
  top: number;
  left: number;
  side: "above" | "below" | "top-dock" | "bottom-dock";
  mode: "overlay" | "dock";
};
export type PopoverRecalculationReason =
  | "geometry"
  | "observer"
  | "external";
type PositionedPopover = PopoverPlacement & { geometryKey: string };

export function translateIframeRect(
  rect: SelectionRect,
  frame: Pick<DOMRect, "top" | "left">,
): SelectionRect {
  return {
    ...rect,
    top: frame.top + rect.top,
    left: frame.left + rect.left,
  };
}

export function relativeSelectionGeometryKey(
  selection: SelectionRect,
  frame: Pick<DOMRect, "top" | "left">,
): string {
  return [
    selection.top - frame.top,
    selection.left - frame.left,
    selection.width,
    selection.height,
  ]
    .map((value) => Math.round(value * 100) / 100)
    .join(":");
}

export function shouldKeepPopoverPlacement(
  currentMode: PopoverPlacement["mode"],
  currentGeometryKey: string,
  nextGeometryKey: string,
  reason: PopoverRecalculationReason,
): boolean {
  if (reason === "external") return false;
  if (reason === "observer")
    return currentMode === "dock" || currentGeometryKey !== nextGeometryKey;
  return currentMode === "dock" && currentGeometryKey === nextGeometryKey;
}

export function placeSelectionPopover(
  selection: SelectionRect,
  popover: PopoverSize,
  pane: SelectionRect,
  gap = 12,
  inset = 8,
): PopoverPlacement {
  const paneRight = pane.left + pane.width;
  const paneBottom = pane.top + pane.height;
  const selectionBottom = selection.top + selection.height;
  const minLeft = pane.left + inset;
  const maxLeft = Math.max(minLeft, paneRight - inset - popover.width);
  const left = Math.min(
    maxLeft,
    Math.max(
      minLeft,
      selection.left + selection.width / 2 - popover.width / 2,
    ),
  );
  const above = selection.top - gap - popover.height;
  const below = selectionBottom + gap;
  const topEdge = pane.top + inset;

  if (above >= topEdge)
    return { top: above, left, side: "above", mode: "overlay" };
  if (below + popover.height <= paneBottom - inset)
    return { top: below, left, side: "below", mode: "overlay" };

  const roomAbove = Math.max(0, selection.top - pane.top);
  const roomBelow = Math.max(0, paneBottom - selectionBottom);
  return roomAbove >= roomBelow
    ? { top: 0, left: 0, side: "top-dock", mode: "dock" }
    : { top: 0, left: 0, side: "bottom-dock", mode: "dock" };
}
type EditContext = {
  blockId: string;
  altBlockId: string;
  kind: "text" | "heading" | "visual";
  tag: string;
  text: string;
  startOffset: number;
  endOffset: number;
  selectedText: string;
  formats: Record<"bold" | "italic" | "underline", boolean>;
  folded: boolean | null;
  caption: {
    label: string;
    number: string;
    caption: string;
    structured: boolean;
  } | null;
  altText: string;
  moveLabel?: string;
  objectLayout: {
    width: "auto" | "content" | "full";
    alignment: "left" | "center" | "right";
    enlargeable: boolean;
    folded: boolean;
  } | null;
  rect: { top: number; left: number; width: number; height: number };
};
export type AcademicObjectEditState = {
  blockId: string;
  altBlockId: string;
  altText: string;
  width: "auto" | "content" | "full";
  alignment: "left" | "center" | "right";
  enlargeable: boolean;
  folded: boolean;
};
export type CaptionEditState = {
  blockId: string;
  label: string;
  number: string;
  caption: string;
  structured: boolean;
};
type MoveDraft = {
  sourceBlockId: string;
  sourceLabel: string;
  destinationBlockId: string | null;
  destinationLabel: string;
};

export function academicObjectEditOperations(
  current: AcademicObjectEditState,
  next: Omit<AcademicObjectEditState, "blockId" | "altBlockId">,
): DocumentEditOperation[] {
  const operations: DocumentEditOperation[] = [];
  const altText = next.altText.trim();
  if (altText !== current.altText.trim())
    operations.push({
      type: "set-alt-text",
      blockId: current.altBlockId,
      text: altText,
    });
  if (
    next.width !== current.width ||
    next.alignment !== current.alignment ||
    next.enlargeable !== current.enlargeable ||
    next.folded !== current.folded
  )
    operations.push({
      type: "set-object-layout",
      blockId: current.blockId,
      width: next.width,
      alignment: next.alignment,
      enlargeable: next.enlargeable,
      folded: next.folded,
    });
  return operations;
}

export function captionEditOperation(
  current: CaptionEditState,
  next: Pick<CaptionEditState, "label" | "number" | "caption">,
): DocumentEditOperation {
  return {
    type: "set-caption",
    blockId: current.blockId,
    label: next.label.trim(),
    number: next.number.trim(),
    caption: current.structured ? current.caption : next.caption.trim(),
  };
}

export function moveObjectOperation(
  sourceBlockId: string,
  destinationBlockId: string,
  position: "before" | "after",
): DocumentEditOperation | null {
  if (!sourceBlockId || !destinationBlockId || sourceBlockId === destinationBlockId)
    return null;
  return {
    type: "move-object",
    blockId: sourceBlockId,
    destinationBlockId,
    position,
  };
}

export function safeReaderExternalUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const href = value.trim();
  if (/[\r\n]/.test(href) || /%0[ad]/i.test(href)) return null;
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "mailto:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function openReaderExternalLink(
  value: unknown,
  opener?: (url: string, target: string, features: string) => unknown,
): boolean {
  const url = safeReaderExternalUrl(value);
  if (!url) return false;
  const open = opener ?? ((href, target, features) => window.open(href, target, features));
  open(url, "_blank", "noopener,noreferrer");
  return true;
}
type EditRevision = {
  revision: number;
  summary: Record<string, number>;
  restored_from_revision: number | null;
  created_at: string;
};
type EditHistory = { currentRevision: number; revisions: EditRevision[] };
const actionLabels = {
  define: "Define",
  explain: "Explain",
  eli14: "Explain for a 14-year-old",
  ask: "Ask",
  highlight: "Highlight",
  compact: "Compact",
  tldr: "TL;DR",
  "half-page": "Half-page",
  "visual-recap": "Visual recap",
  visualize: "Visualize",
  research: "Research",
} as const;
type SelectionAction = keyof typeof actionLabels;
export function availableSelectionActions(
  editMode: boolean,
  hasSelectedText: boolean,
): SelectionAction[] {
  return (Object.keys(actionLabels) as SelectionAction[]).filter(
    (action) => action !== "highlight" || (!editMode && hasSelectedText),
  );
}
export function retryRequestId(
  current: string,
  terminalFailure: boolean,
  replacement: () => string = crypto.randomUUID,
): string {
  return terminalFailure ? replacement() : current;
}
export function writerRequestIdentity(input: {
  instruction: string;
  modelOverride: string;
  documentVersionId: string;
  revision: number;
  sources: Array<{ id: string; snapshotHash?: string }>;
}): string {
  return JSON.stringify([
    input.instruction.trim(),
    input.modelOverride,
    input.documentVersionId,
    input.revision,
    input.sources
      .map((source) => [source.id, source.snapshotHash ?? ""])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  ]);
}
export function summaryReviewRequestIdentity(input: {
  artifactId: string;
  artifactVersion: number;
  documentVersionId: string;
  revision: number;
  representationId?: string;
  extractionRevision?: number;
  modelOverride: string;
  signals: Array<{
    id: string;
    kind: HighlightKind;
    exactQuote: string;
    note: string | null;
  }>;
}): string {
  return JSON.stringify([
    input.artifactId,
    input.artifactVersion,
    input.documentVersionId,
    input.revision,
    input.representationId ?? null,
    input.extractionRevision ?? null,
    input.signals
      .filter(
        (signal) =>
          signal.kind === "important" || signal.kind === "comment",
      )
      .map((signal) => [
        signal.id,
        signal.kind,
        signal.exactQuote,
        signal.note ?? "",
      ])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    input.modelOverride,
  ]);
}
export function threadReplyRetryRequestId(
  retries: ReplyRetryState,
  threadId: string,
  prompt: string,
): string | undefined {
  return retries.get(threadId)?.get(prompt);
}
export function rememberThreadReplyRetry(
  retries: ReplyRetryState,
  threadId: string,
  prompt: string,
  requestId: string,
): ReplyRetryState {
  const next = new Map(retries);
  const prompts = new Map(retries.get(threadId) ?? []);
  prompts.set(prompt, requestId);
  next.set(threadId, prompts);
  return next;
}
export function clearThreadReplyRetry(
  retries: ReplyRetryState,
  threadId: string,
  prompt: string,
): ReplyRetryState {
  const current = retries.get(threadId);
  if (!current?.has(prompt)) return retries;
  const next = new Map(retries);
  const prompts = new Map(current);
  prompts.delete(prompt);
  if (prompts.size) next.set(threadId, prompts);
  else next.delete(threadId);
  return next;
}
export function shouldSubmitComposerKey(
  event: Pick<
    KeyboardEvent,
    "key" | "isComposing" | "metaKey" | "ctrlKey"
  >,
  requireModifier = false,
): boolean {
  return (
    event.key === "Enter" &&
    !event.isComposing &&
    (!requireModifier || event.metaKey || event.ctrlKey)
  );
}
export function tryAcquireLock(lock: { current: boolean }): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}
export function releaseLock(lock: { current: boolean }): void {
  lock.current = false;
}
export function normalizeThreadPreview(
  value: unknown,
  maxLength = 240,
): string {
  if (typeof value !== "string") return "";
  const normalized = value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/gm, "")
    .replace(/[`*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const characters = Array.from(normalized);
  const limit = Math.max(1, Math.floor(maxLength));
  if (characters.length <= limit) return normalized;
  return `${characters.slice(0, Math.max(0, limit - 1)).join("").trimEnd()}…`;
}
export function limitUnicodeCodePoints(value: string, maxLength: number): string {
  return Array.from(value).slice(0, Math.max(0, maxLength)).join("");
}
export function threadAnnotationCandidate(thread: Thread): string {
  if (thread.annotation_text?.trim()) return "";
  if (thread.annotation_candidate_status !== "pending") return "";
  return normalizeThreadPreview(thread.annotation_candidate_text, 500);
}
export function deriveThreadPreview(
  thread: Thread,
  artifacts: Artifact[],
): ThreadPreview | null {
  const annotation = normalizeThreadPreview(thread.annotation_text);
  if (annotation) return { text: annotation, source: "annotation" };
  const candidate = threadAnnotationCandidate(thread);
  if (candidate) return { text: candidate, source: "candidate" };

  const assistantIds = new Set(
    thread.messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          message.id !== "draft" &&
          Boolean(message.content.trim()),
      )
      .map((message) => message.id),
  );
  const compact = artifacts
    .map((artifact, index) => ({ artifact, index }))
    .filter(({ artifact }) => {
      if (artifact.kind !== "compact") return false;
      if (artifact.scope_type === "thread")
        return artifact.scope_id === thread.id;
      return (
        artifact.scope_type === "answer" && assistantIds.has(artifact.scope_id)
      );
    })
    .map(({ artifact, index }) => ({
      artifact,
      index,
      text: normalizeThreadPreview(artifact.content),
      created: Date.parse(artifact.created_at ?? artifact.createdAt ?? ""),
    }))
    .filter((candidate) => Boolean(candidate.text))
    .sort((left, right) => {
      const leftTime = Number.isFinite(left.created) ? left.created : 0;
      const rightTime = Number.isFinite(right.created) ? right.created : 0;
      return rightTime - leftTime || left.index - right.index;
    })[0];
  if (compact)
    return {
      text: compact.text,
      source:
        compact.artifact.scope_type === "thread"
          ? "thread-compact"
          : "answer-compact",
    };

  const answer = thread.messages
    .map((message, index) => ({
      message,
      index,
      created: Date.parse(message.createdAt),
    }))
    .filter(
      ({ message }) =>
        message.role === "assistant" &&
        message.id !== "draft" &&
        Boolean(normalizeThreadPreview(message.content)),
    )
    .sort((left, right) => {
      const leftTime = Number.isFinite(left.created) ? left.created : 0;
      const rightTime = Number.isFinite(right.created) ? right.created : 0;
      return rightTime - leftTime || right.index - left.index;
    })[0]?.message;
  const text = normalizeThreadPreview(answer?.content);
  return text ? { text, source: "answer" } : null;
}
const SIDEBAR_MIN = 420;
const SIDEBAR_MAX = 960;
const UNMATCHED_SOURCE_ERROR = "This source passage needs anchor repair.";
const sidebarLimit = () =>
  Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, window.innerWidth - 360));
const clampSidebar = (value: number) =>
  Math.min(sidebarLimit(), Math.max(SIDEBAR_MIN, value));
function closeSummaryMenus(): void {
  document
    .querySelectorAll<HTMLDetailsElement>(".summary-menu[open]")
    .forEach((menu) => (menu.open = false));
}
type ClipboardWriter = { writeText: (text: string) => Promise<void> };

function copyWithTemporaryTextarea(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

export async function copyTextToClipboard(
  text: string,
  clipboard: ClipboardWriter | undefined =
    typeof navigator === "undefined" ? undefined : navigator.clipboard,
  fallback: (value: string) => boolean = copyWithTemporaryTextarea,
): Promise<void> {
  if (clipboard) {
    try {
      await clipboard.writeText(text);
      return;
    } catch {
      // Permission policies can reject the modern API even on HTTPS.
    }
  }
  if (!fallback(text)) throw new Error("Your browser blocked clipboard access");
}


export function Reader({
  documentId,
  onBack,
}: {
  documentId: string;
  onBack: () => void;
}) {
  const [doc, setDoc] = useState<DocumentInfo | null>(null),
    [representationId, setRepresentationId] = useState<string | null>(null),
    [pdfPreparing, setPdfPreparing] = useState(false),
    [pdfEnableOpen, setPdfEnableOpen] = useState(false),
    [pdfOcrLanguage, setPdfOcrLanguage] = useState<'eng' | 'eng+kor'>('eng'),
    [threads, setThreads] = useState<Thread[]>([]),
    [highlights, setHighlights] = useState<Highlight[]>([]),
    [artifacts, setArtifacts] = useState<Artifact[]>([]),
    [writerWorkspace, setWriterWorkspace] =
      useState<WriterWorkspace | null>(null),
    [writerInstruction, setWriterInstruction] = useState(""),
    [writerModelOverride, setWriterModelOverride] = useState(""),
    [reviewModelOverrides, setReviewModelOverrides] = useState<
      Record<string, string>
    >({}),
    [models, setModels] = useState<Model[]>([]),
    [taskRoutes, setTaskRoutes] = useState<TaskRoute[]>([]),
    [modelOverride, setModelOverride] = useState(""),
    [repairId, setRepairId] = useState(
      () => migratedReaderStorage(sessionStorage, "profread-repair-id", "afterdraft-repair-id") ?? "",
    ),
    [selection, setSelection] = useState<Selection | null>(null),
    [selectionPanel, setSelectionPanel] = useState<
      "actions" | "composing" | "highlighting"
    >("actions"),
    [popoverPosition, setPopoverPosition] =
      useState<PositionedPopover | null>(null),
    [copiedSelectionKey, setCopiedSelectionKey] = useState(""),
    [error, setError] = useState(""),
    [question, setQuestion] = useState(""),
    [threadReplyDrafts, setThreadReplyDrafts] = useState<
      Record<string, string>
    >({}),
    [threadAnnotationDrafts, setThreadAnnotationDrafts] = useState<
      Record<string, string>
    >({}),
    [highlightKind, setHighlightKind] =
      useState<HighlightKind>("important"),
    [highlightNote, setHighlightNote] = useState(""),
    [askRetry, setAskRetry] = useState<AskRetry | null>(null),
    [running, setRunning] = useState<string | null>(null),
    [activeRunReady, setActiveRunReady] = useState(false),
    [routeInfo, setRouteInfo] = useState(""),
    [drawer, setDrawer] = useState(false),
    [activeEntry, setActiveEntry] = useState<ActiveEntry | null>(null),
    [editMode, setEditMode] = useState(false),
    [pendingEdits, setPendingEdits] = useState<DocumentEditOperation[]>([]),
    [editHistory, setEditHistory] = useState<EditHistory | null>(null),
    [editContext, setEditContext] = useState<EditContext | null>(null),
    [captionDraft, setCaptionDraft] = useState<EditContext | null>(null),
    [objectDraft, setObjectDraft] = useState<EditContext | null>(null),
    [moveDraft, setMoveDraft] = useState<MoveDraft | null>(null),
    [historyOpen, setHistoryOpen] = useState(false),
    [savingEdits, setSavingEdits] = useState(false),
    [contentEpoch, setContentEpoch] = useState(0),
    [sidebarWidth, setSidebarWidth] = useState(() => {
      const stored = Number(migratedReaderStorage(localStorage, "profread-sidebar-width", "afterdraft-sidebar-width"));
      return clampSidebar(Number.isFinite(stored) && stored ? stored : 640);
    });
  const paper = useRef<HTMLElement>(null),
    iframe = useRef<HTMLIFrameElement>(null),
    pdfReader = useRef<PdfReaderHandle>(null),
    pdfProgress = useRef<PdfProgress | null>(null),
    currentRepresentationId = useRef<string | null>(null),
    pendingSourceNavigation = useRef<SidebarSource | PdfSelector | null>(null),
    toolbar = useRef<HTMLDivElement>(null),
    questionInput = useRef<HTMLInputElement>(null),
    highlightKindSelect = useRef<HTMLSelectElement>(null),
    highlightNoteInput = useRef<HTMLTextAreaElement>(null),
    aborter = useRef<AbortController | null>(null),
    activeRunId = useRef(""),
    submissionLock = useRef(false),
    editSaveLock = useRef(false),
    scrollRatio = useRef(0),
    replyRetries = useRef<ReplyRetryState>(new Map()),
    writerRetry = useRef<{ key: string; requestId: string } | null>(
      null,
    ),
    reviewRetries = useRef(new Map<string, string>()),
    editHistoryRef = useRef<EditHistory | null>(null),
    popoverSidebarWidth = useRef(sidebarWidth),
    pendingEditsRef = useRef<DocumentEditOperation[]>([]),
    editFinishResolvers = useRef(new Map<string, () => void>());
  const activeRepresentation = doc?.representations?.find(item => item.id === representationId);
  currentRepresentationId.current = representationId;
  const pdfView = activeRepresentation?.kind === 'pdf';
  const htmlRepresentation = doc?.representations?.find(item => item.kind === 'html');
  const pdfRepresentation = doc?.representations?.find(item => item.kind === 'pdf');
  const pdfMarkers = useMemo<PdfMarker[]>(() => [
    ...threads.filter(thread => thread.anchor_id && !thread.parent_message_id && isPdfSelector(thread.selector)).map(thread => ({id: thread.anchor_id!, selector: thread.selector as PdfSelector, label: deriveThreadPreview(thread, artifacts)?.text || thread.title || '', note: thread.annotation_text ?? null, status: thread.status ?? 'attached'})),
    ...highlights.filter(highlight => isPdfSelector(highlight.selector)).map(highlight => ({id: highlight.anchor_id, selector: highlight.selector as PdfSelector, kind: highlight.kind, note: highlight.note, status: highlight.status ?? 'attached'})),
  ], [threads, highlights, artifacts]);
  useEffect(() => {
    if (!pdfPreparing && !doc?.pdfJobId && !['preparing', 'indexing'].includes(pdfRepresentation?.status ?? '')) return;
    let stopped = false;
    const poll = async () => {
      try {
        const info = await api<DocumentInfo>(`/api/documents/${documentId}`);
        if (stopped) return;
        setDoc(info);
        const next = info.representations?.find(item => item.kind === 'pdf');
        if (pdfPreparing && next && ['indexing', 'ready', 'partial'].includes(next.status)) {
          setRepresentationId(next.id); setPdfPreparing(false);
        }
        if (next?.status === 'failed' || info.pdfJobStatus === 'failed') {setPdfPreparing(false); setError(next?.error || 'The PDF could not be prepared. You can retry from the original source.');}
      } catch (error) {if (!stopped) setError((error as Error).message);}
    };
    const timer = setInterval(() => void poll(), 2500);
    return () => {stopped = true; clearInterval(timer);};
  }, [documentId, pdfPreparing, doc?.pdfJobId, pdfRepresentation?.status]);
  const loadThreads = useCallback(
    () =>
      api<any[]>(`/api/documents/${documentId}/threads`).then((data) =>
        setThreads(
          data.map((t) => ({
            ...t,
            messages:
              typeof t.messages === "string"
                ? JSON.parse(t.messages)
                : (t.messages ?? []),
          })),
        ),
      ),
    [documentId],
  );
  const loadHighlights = useCallback(
    () =>
      api<Highlight[]>(`/api/documents/${documentId}/highlights`).then(
        setHighlights,
      ),
    [documentId],
  );
  const loadArtifacts = useCallback(
    () =>
      api<Artifact[]>(`/api/documents/${documentId}/artifacts`).then((data) => {
        setArtifacts(data);
        return data;
      }),
    [documentId],
  );
  const loadWriter = useCallback(
    () =>
      api<WriterWorkspace>(`/api/documents/${documentId}/writer`).then(
        (workspace) => {
          setWriterWorkspace(workspace);
          return workspace;
        },
      ),
    [documentId],
  );
  const anchorPayloads = useMemo(
    () => [
      ...threads
        .filter(
          (thread) =>
            thread.kind !== "writer" &&
            thread.anchor_id &&
            !isPdfSelector(thread.selector) &&
            !thread.parent_message_id,
        )
        .map((thread) => {
          const preview = deriveThreadPreview(thread, artifacts);
          return {
            id: thread.anchor_id,
            blockId: thread.block_id,
            exact: thread.exact_quote,
            prefix: thread.prefix_text,
            suffix: thread.suffix_text,
            status: thread.status,
            checked: false,
            action: thread.action,
            annotationText:
              thread.annotation_text || threadAnnotationCandidate(thread) || null,
            preview: preview?.text,
            previewSource: preview?.source,
            localStartOffset: thread.local_start_offset,
            localEndOffset: thread.local_end_offset,
          };
        }),
      ...highlights.filter(highlight => !isPdfSelector(highlight.selector)).map((highlight) => ({
        id: highlight.anchor_id,
        blockId: highlight.block_id,
        exact: highlight.exact_quote,
        prefix: highlight.prefix_text,
        suffix: highlight.suffix_text,
        status: highlight.status,
        checked: Boolean(highlight.checked),
        kind: highlight.kind,
        color: highlight.color,
        note: highlight.note,
        localStartOffset: highlight.local_start_offset,
        localEndOffset: highlight.local_end_offset,
      })),
    ],
    [threads, artifacts, highlights],
  );
  const loadEditHistory = useCallback(
    (versionId: string) =>
      api<EditHistory>(`/api/versions/${versionId}/edit-history`).then(
        (history) => {
          editHistoryRef.current = history;
          setEditHistory(history);
          return history;
        },
      ),
    [],
  );
  useEffect(() => {
    setWriterWorkspace(null);
    setWriterInstruction("");
    setWriterModelOverride("");
    setReviewModelOverrides({});
    writerRetry.current = null;
    reviewRetries.current.clear();
  }, [documentId]);
  useEffect(() => {
    setRepresentationId(null);
    pdfProgress.current = null;
    api<DocumentInfo>(`/api/documents/${documentId}`)
      .then((info) => {
        setDoc(info);
        setRepresentationId(info.preferredRepresentationId ?? info.representations?.find(item => item.kind === 'html')?.id ?? info.representations?.[0]?.id ?? null);
        if (!info.representations || info.representations.some(item => item.kind === 'html')) void loadEditHistory(info.version_id);
        if (info.last_thread_id) {
          setDrawer(true);
        }
      })
      .catch((e) => setError(e.message));
    loadThreads().catch((e) => setError(e.message));
    loadHighlights().catch((e) => setError(e.message));
    loadArtifacts().catch((e) => setError(e.message));
    api<{ models: Model[]; taskRoutes: TaskRoute[] }>("/api/settings/models")
      .then((value) => {
        setModels(value.models);
        setTaskRoutes(value.taskRoutes);
      })
      .catch(() => {});
  }, [documentId, loadThreads, loadHighlights, loadArtifacts, loadEditHistory]);
  useEffect(() => {
    if (!routeInfo && models.length && taskRoutes.length)
      setRouteInfo(
        `Ready: ${models.map((model) => `${model.label}${model.ready ? " ✓" : " !"}`).join(" · ")} · ${taskRoutes.length} tasks routed`,
      );
  }, [models, taskRoutes, routeInfo]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.source !== iframe.current?.contentWindow ||
        !['profread', 'afterdraft'].includes(event.data?.source)
      )
        return;
      if (event.data.type === "open-external-link") {
        if (!openReaderExternalLink(event.data.href))
          setError("The article tried to open an unsupported link.");
        return;
      }
      if (event.data.type === "move-cancelled") {
        setMoveDraft(null);
        return;
      }
      if (event.data.type === "move-source-label") {
        const label =
          typeof event.data.text === "string" ? event.data.text.trim() : "";
        if (label)
          setMoveDraft((current) =>
            current ? { ...current, sourceLabel: label.slice(0, 80) } : current,
          );
        return;
      }
      if (event.data.type === "move-destination-invalid") {
        setError("Choose a destination outside the object being moved.");
        return;
      }
      if (event.data.type === "move-placement") {
        const destinationBlockId =
            typeof event.data.blockId === "string" ? event.data.blockId : "",
          position =
            event.data.position === "before" || event.data.position === "after"
              ? event.data.position
              : null,
          operation =
            moveDraft && position
              ? moveObjectOperation(
                  moveDraft.sourceBlockId,
                  destinationBlockId,
                  position,
                )
              : null;
        if (!operation) {
          setError("That paragraph gap cannot be used for this object.");
          return;
        }
        queueEdit(operation);
        cancelMove();
        return;
      }
      if (event.data.type === "edit-preview-error") {
        setError(
          typeof event.data.message === "string"
            ? event.data.message
            : "This edit cannot be previewed safely.",
        );
        return;
      }
      if (event.data.type === "move-destination") {
        const destinationBlockId =
          typeof event.data.blockId === "string" ? event.data.blockId : "";
        if (destinationBlockId && destinationBlockId === moveDraft?.sourceBlockId) {
          setError("Choose a different destination block for this object.");
          return;
        }
        setMoveDraft((current) => {
          if (!current || !destinationBlockId) return current;
          const destinationLabel =
            typeof event.data.text === "string" && event.data.text.trim()
              ? event.data.text.trim().slice(0, 80)
              : typeof event.data.tag === "string"
                ? event.data.tag.slice(0, 24)
                : "document block";
          iframe.current?.contentWindow?.postMessage(
            { type: "set-move-destination", blockId: destinationBlockId },
            "*",
          );
          return { ...current, destinationBlockId, destinationLabel };
        });
        return;
      }
      if (event.data.type === "selection") {
        const frame = iframe.current?.getBoundingClientRect();
        setSelection({
          ...event.data,
          blockType: "text",
          rect: frame
            ? translateIframeRect(event.data.rect, frame)
            : event.data.rect,
        });
        setSelectionPanel("actions");
        setPopoverPosition(null);
        setQuestion("");
        setHighlightKind("important");
        setHighlightNote("");
        setAskRetry(null);
      }
      if (event.data.type === "selection-geometry") {
        const frame = iframe.current?.getBoundingClientRect();
        const rect = frame
          ? translateIframeRect(event.data.rect, frame)
          : event.data.rect;
        setSelection((current) =>
          current && current.blockId === event.data.blockId
            ? { ...current, rect }
            : current,
        );
      }
      if (event.data.type === "background-click") {
        setSelection(null);
        setSelectionPanel("actions");
        setPopoverPosition(null);
        setQuestion("");
        setHighlightKind("important");
        setHighlightNote("");
        setAskRetry(null);
        setEditContext(null);
        closeSummaryMenus();
      }
      if (event.data.type === "block-selection") {
        const frame = iframe.current?.getBoundingClientRect();
        setSelection({
          blockId: event.data.blockId,
          blockType:
            event.data.blockType === "img" ? "image" : event.data.blockType,
          exact: "",
          prefix: "",
          suffix: "",
          startOffset: 0,
          endOffset: 0,
          rect: frame
            ? translateIframeRect(event.data.rect, frame)
            : event.data.rect,
        });
        setSelectionPanel("actions");
          setPopoverPosition(null);
          setQuestion("");
          setHighlightKind("important");
          setHighlightNote("");
          setAskRetry(null);
      }
      if (event.data.type === "visual-capture")
        setSelection((current) => {
          if (!current || current.blockId !== event.data.blockId)
            return current;
          return {
            ...current,
            visual: { mimeType: "image/png", data: event.data.data },
          };
        });
      if (event.data.type === "layout") {
        scrollRatio.current = event.data.ratio;
      }
      if (event.data.type === "edit-context") {
        const frame = iframe.current?.getBoundingClientRect();
        setEditContext({
          ...event.data,
          rect: {
            ...event.data.rect,
            top: (frame?.top ?? 0) + event.data.rect.top,
            left: (frame?.left ?? 0) + event.data.rect.left,
          },
        });
      }
      if (event.data.type === "edit-operation") {
        const next = [...pendingEditsRef.current, event.data.operation];
        pendingEditsRef.current = next;
        setPendingEdits(next);
      }
      if (event.data.type === "edit-finished") {
        editFinishResolvers.current.get(event.data.requestId)?.();
        editFinishResolvers.current.delete(event.data.requestId);
      }
      if (event.data.type === "ready") {
        if (editMode) {
          iframe.current?.contentWindow?.postMessage(
            { type: "enter-edit-mode" },
            "*",
          );
          if (moveDraft)
            iframe.current?.contentWindow?.postMessage(
              { type: "enter-move-mode", blockId: moveDraft.sourceBlockId },
              "*",
            );
          iframe.current?.contentWindow?.postMessage(
            { type: "restore-progress", ratio: scrollRatio.current },
            "*",
          );
          if (selection)
            iframe.current?.contentWindow?.postMessage(
              {
                type: "reveal-selection",
                blockId: selection.blockId,
                startOffset: selection.startOffset,
                endOffset: selection.endOffset,
              },
              "*",
            );
          return;
        }
        iframe.current?.contentWindow?.postMessage(
          {
            type: "apply-anchors",
            anchors: anchorPayloads,
          },
          "*",
        );
        iframe.current?.contentWindow?.postMessage(
          { type: "restore-progress", ratio: doc?.offset_ratio ?? 0 },
          "*",
        );
        const pending = pendingSourceNavigation.current;
        if (pending && !isPdfSelector(pending)) {
          const payload = sidebarSourceNavigationPayload(pending);
          if (payload) iframe.current?.contentWindow?.postMessage(payload, '*');
          pendingSourceNavigation.current = null;
        }
      }
      if (event.data.type === "anchor-click") {
        setDrawer(true);
        setSelection(null);
        setSelectionPanel("actions");
        setPopoverPosition(null);
        setQuestion("");
        setHighlightKind("important");
        setHighlightNote("");
        setAskRetry(null);
        const target = threads.find((t) => t.anchor_id === event.data.anchorId);
        if (target) {
          setActiveEntry({ type: "thread", id: target.id });
          return;
        }
        const highlight = highlights.find(
          (item) => item.anchor_id === event.data.anchorId,
        );
        if (highlight)
          setActiveEntry({ type: "highlight", id: highlight.id });
      }
    };
    addEventListener("message", receive);
    return () => removeEventListener("message", receive);
  }, [threads, highlights, anchorPayloads, doc?.offset_ratio, editMode, selection, moveDraft]);
  useEffect(() => {
    localStorage.setItem("profread-sidebar-width", String(sidebarWidth));
  }, [sidebarWidth]);
  useEffect(() => {
    const fit = () => setSidebarWidth((current) => clampSidebar(current));
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          ".selection-tools,.selection-composer,.edit-context-menu,.summary-menu,.edit-dialog,.pdf-toolbar,.pdf-marker-buttons",
        )
      )
        return;
      setSelection(null);
      setSelectionPanel("actions");
      setPopoverPosition(null);
      setQuestion("");
      setHighlightKind("important");
      setHighlightNote("");
      setAskRetry(null);
      setEditContext(null);
      closeSummaryMenus();
    };
    addEventListener("resize", fit);
    document.addEventListener("pointerdown", dismiss);
    return () => {
      removeEventListener("resize", fit);
      document.removeEventListener("pointerdown", dismiss);
    };
  }, []);
  useEffect(() => {
    if (editMode) return;
    iframe.current?.contentWindow?.postMessage(
      {
        type: "apply-anchors",
        anchors: anchorPayloads,
      },
      "*",
    );
  }, [anchorPayloads, editMode]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!pendingEditsRef.current.length) return;
      event.preventDefault();
    };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, []);
  useEffect(() => {
    if (!selection) return;
    const frame = requestAnimationFrame(() => {
      if (selectionPanel === "composing") questionInput.current?.focus();
      else if (selectionPanel === "highlighting" && highlightKind === "comment")
        highlightNoteInput.current?.focus();
      else if (selectionPanel === "highlighting")
        highlightKindSelect.current?.focus();
      else
        toolbar.current
          ?.querySelector<HTMLElement>("button,select,input")
          ?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [
    selection?.blockId,
    selection?.exact,
    selectionPanel,
    highlightKind,
  ]);
  const updatePopoverPosition = useCallback(
    (reason: PopoverRecalculationReason = "geometry") => {
      if (
        !selection ||
        selectionPanel !== "actions" ||
        window.matchMedia("(max-width: 900px)").matches
      ) {
        setPopoverPosition(null);
        return;
      }
      const element = toolbar.current;
      const paneElement = pdfView ? paper.current?.querySelector<HTMLElement>('.pdf-viewport') : iframe.current;
      const paperElement = paper.current;
      if (!element || !paneElement || !paperElement) return;
      const paneRect = paneElement.getBoundingClientRect();
      const paperRect = paperElement.getBoundingClientRect();
      const measured = element.getBoundingClientRect();
      const geometryKey = `${selection.blockId}:${selection.startOffset}:${selection.endOffset}:${relativeSelectionGeometryKey(
        selection.rect,
        paneRect,
      )}`;
      const placed = placeSelectionPopover(
        selection.rect,
        { width: measured.width, height: measured.height },
        {
          top: paneRect.top,
          left: paneRect.left,
          width: paneRect.width,
          height: paneRect.height,
        },
      );
      const next: PositionedPopover =
        placed.mode === "dock"
          ? { ...placed, geometryKey }
          : {
              ...placed,
              top: placed.top - paperRect.top,
              left: placed.left - paperRect.left,
              geometryKey,
            };
      setPopoverPosition((current) => {
        // Docking changes the iframe height. Ignore that immediate observer
        // feedback, but reconsider the dock after real selection movement,
        // window resizing, or sidebar resizing.
        if (
          current &&
          shouldKeepPopoverPlacement(
            current.mode,
            current.geometryKey,
            geometryKey,
            reason,
          )
        )
          return current;
        return current &&
          current.top === next.top &&
          current.left === next.left &&
          current.side === next.side &&
          current.mode === next.mode &&
          current.geometryKey === next.geometryKey
          ? current
          : next;
      });
    },
    [selection, selectionPanel, pdfView],
  );
  useLayoutEffect(() => {
    if (!selection || selectionPanel !== "actions") return;
    const sidebarChanged = popoverSidebarWidth.current !== sidebarWidth;
    popoverSidebarWidth.current = sidebarWidth;
    updatePopoverPosition(sidebarChanged ? "external" : "geometry");
    const refreshFromObserver = () => {
      iframe.current?.contentWindow?.postMessage(
        { type: "refresh-selection" },
        "*",
      );
      pdfReader.current?.refreshSelection();
      updatePopoverPosition("observer");
    };
    const refreshFromWindow = () => {
      iframe.current?.contentWindow?.postMessage(
        { type: "refresh-selection" },
        "*",
      );
      pdfReader.current?.refreshSelection();
      updatePopoverPosition("external");
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(refreshFromObserver);
    if (toolbar.current) observer?.observe(toolbar.current);
    if (paper.current) observer?.observe(paper.current);
    if (iframe.current) observer?.observe(iframe.current);
    addEventListener("resize", refreshFromWindow);
    return () => {
      observer?.disconnect();
      removeEventListener("resize", refreshFromWindow);
    };
  }, [selection, selectionPanel, sidebarWidth, updatePopoverPosition]);
  useEffect(() => {
    if (popoverPosition?.mode !== "dock" || !selection) return;
    const frame = requestAnimationFrame(() => revealStoredSelection());
    return () => cancelAnimationFrame(frame);
  }, [
    popoverPosition?.mode,
    popoverPosition?.side,
    selection?.blockId,
    selection?.startOffset,
    selection?.endOffset,
  ]);
  useEffect(() => {
    if (!selection) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeSelectionPanel();
    };
    addEventListener("keydown", escape);
    return () => removeEventListener("keydown", escape);
  }, [selection]);
  useEffect(() => {
    const save = () =>
      api(`/api/documents/${documentId}/progress`, {
        method: "PUT",
        body: JSON.stringify({
          ...(pdfView && representationId ? {representationId, ...(pdfProgress.current ?? {})} : {...(representationId ? {representationId} : {}), blockId: null, offsetRatio: Math.min(1, scrollRatio.current)}),
        }),
      }).catch(() => {});
    const id = setInterval(save, 10000);
    return () => {
      clearInterval(id);
      if (currentRepresentationId.current === representationId) save();
    };
  }, [documentId, pdfView, representationId]);
  function closeSelectionPanel() {
    pdfReader.current?.clearSelection();
    iframe.current?.contentWindow?.postMessage(
      { type: "clear-stored-selection" },
      "*",
    );
    setSelection(null);
    setSelectionPanel("actions");
    setPopoverPosition(null);
    setQuestion("");
    setHighlightKind("important");
    setHighlightNote("");
    setAskRetry(null);
  }
  function acquireSubmission(): boolean {
    if (running || submissionLock.current) return false;
    submissionLock.current = true;
    return true;
  }
  function releaseSubmission(): void {
    submissionLock.current = false;
  }
  function revealStoredSelection() {
    if (!selection) return;
    if (selection.pdfSelector) {pdfReader.current?.reveal(selection.pdfSelector); return;}
    iframe.current?.contentWindow?.postMessage(
      {
        type: "reveal-selection",
        blockId: selection.blockId,
        startOffset: selection.startOffset,
        endOffset: selection.endOffset,
      },
      "*",
    );
  }
  function openAskComposer() {
    setSelectionPanel("composing");
    setPopoverPosition(null);
    requestAnimationFrame(() =>
      requestAnimationFrame(revealStoredSelection),
    );
  }
  function openHighlightComposer() {
    setSelectionPanel("highlighting");
    setPopoverPosition(null);
    setHighlightKind("important");
    setHighlightNote("");
    requestAnimationFrame(() =>
      requestAnimationFrame(revealStoredSelection),
    );
  }
  const createAnchor = async () => {
    if (!selection || !doc) throw new Error("Select something first");
    return api<{ id: string }>("/api/anchors", {
      method: "POST",
      body: JSON.stringify({
        documentVersionId: sourceDocumentVersion(doc, selection.pdfSelector?.representationId ?? representationId),
        selector: selection.pdfSelector ?? {
          blockId: selection.blockId,
          exact: selection.exact,
          prefix: selection.prefix,
          suffix: selection.suffix,
          startOffset: selection.startOffset,
          endOffset: selection.endOffset,
          blockType: selection.blockType,
        },
      }),
    });
  };
  async function copySelectionText() {
    if (!selection?.exact) return;
    setError("");
    try {
      await copyTextToClipboard(selection.exact);
      setCopiedSelectionKey(
        `${selection.blockId}:${selection.startOffset}:${selection.endOffset}`,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function createHighlight() {
    if (!selection || (!selection.exact && !selection.pdfSelector) || !doc || running) return;
    const note = highlightNote.trim();
    if (highlightKind === "comment" && !note) {
      setError("Add a comment before saving this highlight");
      highlightNoteInput.current?.focus();
      return;
    }
    if (!acquireSubmission()) return;
    setError("");
    try {
      const anchor = await createAnchor();
      const highlight = await api<{ id: string }>("/api/highlights", {
        method: "POST",
        body: JSON.stringify({
          anchorId: anchor.id,
          kind: highlightKind,
          note: note || null,
        }),
      });
      await Promise.all([loadHighlights(), loadArtifacts()]);
      setDrawer(true);
      setActiveEntry({ type: "highlight", id: highlight.id });
      closeSelectionPanel();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      releaseSubmission();
    }
  }
  async function act(action: keyof typeof actionLabels) {
    if (!selection || !doc || !acquireSubmission()) return;
    setError("");
    try {
      if (action === "define") {
        const existing = threads.find(
          (thread) =>
            thread.action === "define" &&
            thread.block_id === selection.blockId &&
            thread.exact_quote === selection.exact,
        );
        if (existing) {
          setDrawer(true);
          setActiveEntry({ type: "thread", id: existing.id });
          closeSelectionPanel();
          return;
        }
      }
      if (action === "highlight") {
        openHighlightComposer();
        return;
      }
      if (!(await ensureSavedForAi())) return;
      const prompt =
        action === "ask"
          ? question.trim() || selection.exact
          : actionLabels[action];
      const selectionKey = `${selection.blockId}:${selection.startOffset}:${selection.endOffset}`;
      if (action === "ask" && askRetry?.key === selectionKey) {
        let requestId = askRetry.requestId;
        if (askRetry.prompt !== prompt) {
          await api(`/api/threads/${askRetry.threadId}/messages`, {
            method: "POST",
            body: JSON.stringify({ role: "user", content: prompt }),
          });
          requestId = crypto.randomUUID();
          setAskRetry({ ...askRetry, prompt, requestId });
        }
        setDrawer(true);
        setActiveEntry({ type: "thread", id: askRetry.threadId });
        const completed = await run(
          askRetry.threadId,
          askRetry.anchorId,
          action,
          prompt,
          selection.blockType !== "text",
          selection.visual,
          "section",
          askRetry.anchorId,
          requestId,
        );
        if (completed.completed) closeSelectionPanel();
        else
          setAskRetry({
            ...askRetry,
            prompt,
            requestId: completed.requestId,
          });
        return;
      }
      const anchor = await createAnchor();
      const thread = await api<{ id: string }>("/api/threads", {
        method: "POST",
        body: JSON.stringify({
          documentId,
          anchorId: anchor.id,
          title: selection.exact.slice(0, 80) || actionLabels[action],
        }),
      });
      await api(`/api/threads/${thread.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ role: "user", content: prompt }),
      });
      setDrawer(true);
      setActiveEntry({ type: "thread", id: thread.id });
      const requestId = crypto.randomUUID();
      if (action === "ask")
        setAskRetry({
          key: selectionKey,
          threadId: thread.id,
          anchorId: anchor.id,
          prompt,
          requestId,
        });
      else closeSelectionPanel();
      const completed = await run(
        thread.id,
        anchor.id,
        action,
        prompt,
        selection.blockType !== "text",
        selection.visual,
        "section",
        anchor.id,
        requestId,
      );
      if (action === "ask" && completed.completed) closeSelectionPanel();
      else if (action === "ask")
        setAskRetry({
          key: selectionKey,
          threadId: thread.id,
          anchorId: anchor.id,
          prompt,
          requestId: completed.requestId,
        });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      releaseSubmission();
    }
  }
  async function run(
    threadId: string,
    anchorId: string,
    action: string,
    input: string,
    hasVisual = false,
    visual?: { mimeType: "image/png"; data: string },
    artifactScopeType?: "document" | "section" | "answer" | "thread",
    artifactScopeId?: string,
    requestId: string = crypto.randomUUID(),
  ): Promise<RunResult> {
    const sourceThread = threads.find(thread => thread.id === threadId);
    const runRepresentationId = sourceThread?.representation_id ?? (isPdfSelector(sourceThread?.selector) ? sourceThread.selector.representationId : representationId);
    const runPdf = doc?.representations?.find(source => source.id === runRepresentationId)?.kind === 'pdf';
    const controller = new AbortController();
    aborter.current = controller;
    setActiveRunReady(false);
    setRunning(threadId);
    if (!["tldr", "half-page", "visual-recap", "summarize"].includes(action))
      setActiveEntry({ type: "thread", id: threadId });
    let completed = false;
    let streamFailure = "";
    let streamCancelled = false;
    try {
      await loadThreads();
      await stream(
        "/api/runs",
        {
          requestId,
          documentVersionId: sourceDocumentVersion(doc!, runRepresentationId),
          ...(runRepresentationId ? {representationId: runRepresentationId} : {}),
          threadId,
          anchorId,
          action,
          input,
          hasVisual,
          ...(visual ? { visual } : {}),
          ...(artifactScopeType ? { artifactScopeType } : {}),
          ...(artifactScopeId ? { artifactScopeId } : {}),
          webEnabled: action === "research",
          ...(modelOverride ? { modelOverride } : {}),
        },
        (event, data) => {
          if (event === "route") {
            activeRunId.current = data.runId ?? "";
            setActiveRunReady(Boolean(activeRunId.current));
            setRouteInfo(
              `${data.providerId} · ${data.modelId} · ${data.contextTier} · ${data.enabledTools?.length ? data.enabledTools.join(", ") : "no tools"}`,
            );
          }
          if (event === "fallback")
            setRouteInfo(`Fallback: ${data.providerId} · ${data.modelId}`);
          if (event === "image_generation")
            setRouteInfo(`${data.modelId} · generating visual recap image…`);
          if (event === "image_generated")
            setRouteInfo(`${data.modelId} · visual recap image ready`);
          if (event === "source_context")
            setRouteInfo(current => `${current} · PDF source${data.coverage?.includedPages ? ` ${data.coverage.includedPages.length}/${data.coverage.totalPages} context pages` : ''}${data.coverage?.partial ? ' · partial text index' : ''}${data.imagesOmitted?.length ? ` · ${data.imagesOmitted.length} page images omitted` : ''}`);
          if (event === "source_citations")
            setThreads(current => current.map(thread => thread.id === threadId ? {...thread, messages: thread.messages.map(message => message.id === 'draft' ? {...message, sourceCitations: data.citations} : message)} : thread));
          if (event === "done") completed = true;
          if (event === "error")
            streamFailure = data.message || "The model request failed";
          if (event === "cancelled") streamCancelled = true;
          if (event === "text_delta" && action !== "visual-recap")
            setThreads((current) =>
              current.map((t) =>
                t.id === threadId
                  ? { ...t, messages: updateDraft(t.messages, data.delta) }
                  : t,
              ),
            );
        },
        controller.signal,
      );
      if (streamCancelled)
        throw new DOMException("Cancelled", "AbortError");
      if (streamFailure) throw new Error(streamFailure);
      if (!completed) throw new Error("The response ended before completion");
      let loadedArtifacts: Artifact[];
      try {
        const loaded = await Promise.all([loadThreads(), loadArtifacts()]);
        loadedArtifacts = loaded[1];
      } catch (refreshError) {
        setError(
          `Response saved, but the entries could not refresh: ${(refreshError as Error).message}`,
        );
        return { completed: true, requestId };
      }
      const artifactKind =
        action === "summarize" || action === "tldr"
          ? "tldr"
          : action === "half-page" || action === "visual-recap"
            ? action
            : null;
      if (artifactKind && artifactScopeType && artifactScopeId) {
        const artifact = loadedArtifacts.find(
          (item) =>
            item.kind === artifactKind &&
            item.scope_type === artifactScopeType &&
            item.scope_id === artifactScopeId &&
            (artifactScopeType !== 'document' || matchesReadingSource(item.representation_id, runRepresentationId, runPdf)),
        );
        if (artifact) setActiveEntry({ type: "artifact", id: artifact.id });
      }
      return { completed: true, requestId };
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
      setThreads((current) =>
        current.map((thread) =>
          thread.id === threadId
            ? {
                ...thread,
                messages: thread.messages.filter(
                  (message) => message.id !== "draft",
                ),
              }
            : thread,
        ),
      );
      return {
        completed: false,
        requestId: retryRequestId(
          requestId,
          Boolean(streamFailure || streamCancelled || controller.signal.aborted),
        ),
      };
    } finally {
      setRunning(null);
      setActiveRunReady(false);
      aborter.current = null;
      activeRunId.current = "";
    }
  }
  async function nestedAction(
    parentMessageId: string,
    text: string,
    action: "ask" | "compact" | "tldr" | "half-page" | "visual-recap" = "ask",
  ) {
    if (!doc || !acquireSubmission()) return;
    try {
      if (action !== "ask") {
        const artifactKind = action === "tldr" ? "tldr" : action;
        const existing = artifacts.find(
          (artifact) =>
            artifact.kind === artifactKind &&
            artifact.scope_type === "answer" &&
            artifact.scope_id === parentMessageId,
        );
        if (existing) {
          setDrawer(true);
          setActiveEntry({ type: "artifact", id: existing.id });
          return;
        }
      }
      if (!(await ensureSavedForAi())) return;
      const parent = threads.find((t) =>
          t.messages.some((m) => m.id === parentMessageId),
        ),
        prompt =
          action === "ask"
            ? text
            : `Create a ${action} from this answer:\n${text}`;
      const thread = await api<{ id: string }>("/api/threads", {
        method: "POST",
        body: JSON.stringify({
          documentId,
          anchorId: parent?.anchor_id,
          parentMessageId,
          title: prompt.slice(0, 80),
        }),
      });
      setDrawer(true);
      setActiveEntry({ type: "thread", id: thread.id });
      await api(`/api/threads/${thread.id}/messages`, {
        method: "POST",
        body: JSON.stringify({
          role: "user",
          content: prompt,
          parentMessageId,
        }),
      });
      await run(
        thread.id,
        parent?.anchor_id ?? "",
        action,
        text,
        false,
        undefined,
        "answer",
        parentMessageId,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      releaseSubmission();
    }
  }
  async function threadAction(
    thread: Thread,
    action: "compact" | "tldr" | "half-page" | "visual-recap",
  ) {
    const artifactKind = action === "tldr" ? "tldr" : action;
    const existing = artifacts.find(
      (artifact) =>
        artifact.kind === artifactKind &&
        artifact.scope_type === "thread" &&
        artifact.scope_id === thread.id,
    );
    if (existing) {
      setActiveEntry({ type: "artifact", id: existing.id });
      return;
    }
    if (!acquireSubmission()) return;
    try {
      if (!(await ensureSavedForAi())) return;
      const prompt = `Create a ${action} from this thread subtree.`;
      await api(`/api/threads/${thread.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ role: "user", content: prompt }),
      });
      await run(
        thread.id,
        thread.anchor_id ?? "",
        action,
        "",
        false,
        undefined,
        "thread",
        thread.id,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      releaseSubmission();
    }
  }
  async function documentAction(
    action: "tldr" | "half-page" | "visual-recap",
    regenerate = false,
  ) {
    if (!doc || !acquireSubmission()) return;
    try {
      const existingArtifact = artifacts.find(
        (artifact) =>
          artifact.kind === action &&
          artifact.scope_type === "document" &&
          artifact.scope_id === documentId &&
          matchesReadingSource(artifact.representation_id, representationId, pdfView),
      );
      if (existingArtifact && !regenerate) {
        setDrawer(true);
        setActiveEntry({ type: "artifact", id: existingArtifact.id });
        return;
      }
      if (!(await ensureSavedForAi())) return;
      const existingThread = threads.find(
        (thread) =>
          thread.action === action &&
          !thread.anchor_id &&
          !thread.parent_message_id &&
          matchesReadingSource(thread.representation_id, representationId, pdfView),
      );
      const thread =
        existingThread ??
        (await api<{ id: string }>("/api/threads", {
          method: "POST",
          body: JSON.stringify({
            documentId,
            title: `${action} of ${doc.title}`,
            ...(representationId ? {representationId} : {}),
          }),
        }));
      await api(`/api/threads/${thread.id}/messages`, {
        method: "POST",
        body: JSON.stringify({
          role: "user",
          content: `Create a ${action} for this complete document.`,
        }),
      });
      setDrawer(true);
      await run(
        thread.id,
        "",
        action,
        "",
        false,
        undefined,
        "document",
        documentId,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      releaseSubmission();
    }
  }
  async function reviewArtifact(artifact: Artifact) {
    if (!doc || !acquireSubmission()) return;
    try {
      if (!(await ensureSavedForAi())) return;
      const reviewModel = reviewModelOverrides[artifact.id] ?? "";
      const reviewSource = artifact.representation_id ? doc.representations?.find(item => item.id === artifact.representation_id) : htmlRepresentation;
      const reviewPdf = reviewSource?.kind === 'pdf';
      const retryKey = summaryReviewRequestIdentity({
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        documentVersionId: sourceDocumentVersion(doc, reviewSource?.id),
        revision: reviewPdf ? 0 : editHistoryRef.current?.currentRevision ?? 0,
        ...(reviewPdf ? {representationId: reviewSource.id, extractionRevision: reviewSource.extractionRevision} : {}),
        modelOverride: reviewModel,
        signals: highlights.filter(highlight => reviewPdf ? isPdfSelector(highlight.selector) && highlight.selector.representationId === reviewSource.id : !isPdfSelector(highlight.selector)).map((highlight) => ({
          id: highlight.id,
          kind: highlight.kind,
          exactQuote: highlight.exact_quote,
          note: highlight.note,
        })),
      });
      const requestId =
        reviewRetries.current.get(retryKey) ?? crypto.randomUUID();
      reviewRetries.current.set(retryKey, requestId);
      const controller = new AbortController();
      aborter.current = controller;
      setActiveRunReady(false);
      setRunning(`review:${artifact.id}`);
      setError("");
      let completed = false;
      let outcome:
        | {
            decision: "KEEP" | "REPLACE";
            applied: boolean;
            supersededReason?: string;
          }
        | undefined;
      let terminalFailure = false;
      try {
        await stream(
          "/api/runs",
          {
            requestId,
            documentVersionId: sourceDocumentVersion(doc, reviewSource?.id),
            action: "review-summary",
            ...(reviewSource ? {representationId: reviewSource.id} : {}),
            input: "",
            artifactScopeType: "document",
            artifactScopeId: documentId,
            reviewArtifactId: artifact.id,
            expectedArtifactVersion: artifact.version,
            ...(reviewModel ? { modelOverride: reviewModel } : {}),
          },
          (event, data) => {
            if (event === "route") {
              activeRunId.current = data.runId ?? "";
              setActiveRunReady(Boolean(activeRunId.current));
              setRouteInfo(
                `${data.providerId} · ${data.modelId} · reviewing summary`,
              );
            }
            if (event === "fallback")
              setRouteInfo(`Fallback: ${data.providerId} · ${data.modelId}`);
            if (event === "image_generation")
              setRouteInfo(`${data.modelId} · updating visual recap image…`);
            if (event === "review_result") {
              outcome = data;
              setRouteInfo(
                data.applied
                  ? data.decision === "KEEP"
                    ? "Review complete · current summary kept"
                    : "Review complete · summary updated"
                  : `Review completed without applying · ${data.supersededReason ?? "inputs changed"}`,
              );
            }
            if (event === "done") completed = true;
            if (event === "error") {
              terminalFailure = true;
              throw new Error(data.message || "Summary review failed");
            }
            if (event === "cancelled") {
              terminalFailure = true;
              throw new DOMException("Cancelled", "AbortError");
            }
          },
          controller.signal,
        );
        if (!completed || !outcome)
          throw new Error("The summary review ended before completion");
        reviewRetries.current.delete(retryKey);
        try {
          await loadArtifacts();
        } catch (refreshError) {
          setError(
            `Review saved, but summaries could not refresh: ${(refreshError as Error).message}`,
          );
        }
      } catch (e) {
        if (terminalFailure || controller.signal.aborted) {
          reviewRetries.current.set(retryKey, crypto.randomUUID());
          await loadArtifacts().catch(() => {});
        }
        if ((e as Error).name !== "AbortError") setError((e as Error).message);
      } finally {
        setRunning(null);
        setActiveRunReady(false);
        aborter.current = null;
        activeRunId.current = "";
      }
    } finally {
      releaseSubmission();
    }
  }
  async function ensureWriterWorkspace() {
    const workspace = await api<WriterWorkspace>(
      `/api/documents/${documentId}/writer`,
      { method: "POST" },
    );
    setWriterWorkspace(workspace);
    return workspace;
  }
  async function openWriter() {
    setError("");
    try {
      const workspace = await ensureWriterWorkspace();
      setDrawer(true);
      setActiveEntry({ type: "writer", id: workspace.thread.id });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function addWriterSource(
    sourceType: WriterSource["sourceType"],
    sourceId: string,
  ) {
    if (!acquireSubmission()) return false;
    setError("");
    try {
      const workspace = await ensureWriterWorkspace();
      await api(`/api/writers/${workspace.thread.id}/sources`, {
        method: "POST",
        body: JSON.stringify({ sourceType, sourceId }),
      });
      await loadWriter();
      setDrawer(true);
      setActiveEntry({ type: "writer", id: workspace.thread.id });
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      releaseSubmission();
    }
  }
  async function removeWriterSource(sourceId: string) {
    if (!writerWorkspace || !acquireSubmission()) return false;
    setError("");
    try {
      await api(
        `/api/writers/${writerWorkspace.thread.id}/sources/${sourceId}`,
        { method: "DELETE" },
      );
      await loadWriter();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      releaseSubmission();
    }
  }
  async function runWriter(instructionValue = writerInstruction) {
    const instruction = instructionValue.trim();
    if (!doc || !instruction || !acquireSubmission()) return false;
    try {
      if (!(await ensureSavedForAi())) return false;
      const workspace = await ensureWriterWorkspace();
      const retryKey = writerRequestIdentity({
        instruction,
        modelOverride: writerModelOverride,
        documentVersionId: workspace.currentDocumentVersionId,
        revision: workspace.currentRevision,
        sources: workspace.sources,
      });
      const retry =
        writerRetry.current?.key === retryKey
          ? writerRetry.current
          : { key: retryKey, requestId: crypto.randomUUID() };
      writerRetry.current = retry;
      const controller = new AbortController();
      aborter.current = controller;
      setActiveRunReady(false);
      setRunning(`writer:${workspace.thread.id}`);
      setDrawer(true);
      setActiveEntry({ type: "writer", id: workspace.thread.id });
      setError("");
      let completed = false;
      let receivedProposal = false;
      let terminalFailure = false;
      try {
        await stream(
          "/api/runs",
          {
            requestId: retry.requestId,
            documentVersionId: workspace.currentDocumentVersionId,
            threadId: workspace.thread.id,
            action: "document-write",
            input: instruction,
            ...(writerModelOverride
              ? { modelOverride: writerModelOverride }
              : {}),
          },
          (event, data) => {
            if (event === "route") {
              activeRunId.current = data.runId ?? "";
              setActiveRunReady(Boolean(activeRunId.current));
              setRouteInfo(
                `${data.providerId} · ${data.modelId} · Document Writer`,
              );
            }
            if (event === "fallback")
              setRouteInfo(`Fallback: ${data.providerId} · ${data.modelId}`);
            if (event === "proposal") {
              receivedProposal = true;
              setRouteInfo(`Writer proposal ready · ${data.changes?.length ?? 0} changes`);
            }
            if (event === "done") completed = true;
            if (event === "error") {
              terminalFailure = true;
              throw new Error(data.message || "Document Writer failed");
            }
            if (event === "cancelled") {
              terminalFailure = true;
              throw new DOMException("Cancelled", "AbortError");
            }
          },
          controller.signal,
        );
        if (!completed || !receivedProposal)
          throw new Error("The Writer response ended before a proposal arrived");
        writerRetry.current = null;
        try {
          await Promise.all([loadWriter(), loadThreads()]);
        } catch (refreshError) {
          setError(
            `Proposal saved, but Writer could not refresh: ${(refreshError as Error).message}`,
          );
        }
        return true;
      } catch (e) {
        if (terminalFailure || controller.signal.aborted)
          writerRetry.current = {
            key: retryKey,
            requestId: crypto.randomUUID(),
          };
        if ((e as Error).name !== "AbortError") setError((e as Error).message);
        return false;
      } finally {
        setRunning(null);
        setActiveRunReady(false);
        aborter.current = null;
        activeRunId.current = "";
      }
    } finally {
      releaseSubmission();
    }
  }
  async function applyWriterProposal(
    proposalId: string,
    changeIds: string[],
    baseRevision: number,
  ) {
    if (!doc || !changeIds.length || !acquireSubmission()) return false;
    setError("");
    try {
      if (!(await ensureSavedForAi())) return false;
      await api(`/api/writer-proposals/${proposalId}/apply`, {
        method: "POST",
        body: JSON.stringify({ changeIds, baseRevision }),
      });
      const nextDoc = await api<DocumentInfo>(`/api/documents/${documentId}`);
      setDoc(nextDoc);
      await Promise.all([
        loadEditHistory(nextDoc.version_id),
        loadThreads(),
        loadHighlights(),
        loadArtifacts(),
        loadWriter(),
      ]);
      setContentEpoch((value) => value + 1);
      return true;
    } catch (e) {
      setError((e as Error).message);
      await loadWriter().catch(() => {});
      return false;
    } finally {
      releaseSubmission();
    }
  }
  async function dismissWriterProposal(proposalId: string) {
    if (!acquireSubmission()) return false;
    setError("");
    try {
      await api(`/api/writer-proposals/${proposalId}/dismiss`, {
        method: "POST",
      });
      await loadWriter();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      releaseSubmission();
    }
  }
  async function replyToThread(thread: Thread, text: string) {
    const prompt = text.trim();
    if (!prompt || !acquireSubmission()) return false;
    try {
      if (!(await ensureSavedForAi())) return false;
      let requestId = threadReplyRetryRequestId(
        replyRetries.current,
        thread.id,
        prompt,
      );
      if (!requestId) {
        await api(`/api/threads/${thread.id}/messages`, {
          method: "POST",
          body: JSON.stringify({ role: "user", content: prompt }),
        });
        requestId = crypto.randomUUID();
        replyRetries.current = rememberThreadReplyRetry(
          replyRetries.current,
          thread.id,
          prompt,
          requestId,
        );
      }
      const result = await run(
        thread.id,
        thread.anchor_id ?? "",
        "ask",
        prompt,
        false,
        undefined,
        undefined,
        undefined,
        requestId,
      );
      if (result.completed)
        replyRetries.current = clearThreadReplyRetry(
          replyRetries.current,
          thread.id,
          prompt,
        );
      else
        replyRetries.current = rememberThreadReplyRetry(
          replyRetries.current,
          thread.id,
          prompt,
          result.requestId,
        );
      return result.completed;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      releaseSubmission();
    }
  }
  async function copyAnswer(text: string) {
    setError("");
    try {
      await copyTextToClipboard(text);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  }
  async function saveThreadAnnotation(
    threadId: string,
    annotationText: string | null,
  ) {
    setError("");
    try {
      await api(`/api/threads/${threadId}/annotation`, {
        method: "PATCH",
        body: JSON.stringify({ text: annotationText }),
      });
      await loadThreads();
      setThreadAnnotationDrafts((current) => {
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }
  async function dismissAnnotationCandidate(threadId: string) {
    setError("");
    try {
      await api(`/api/threads/${threadId}/annotation-candidate/dismiss`, {
        method: "POST",
      });
      await loadThreads();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }
  async function polishThreadAnnotation(
    thread: Thread,
    draft: string,
    onDelta: (value: string) => void,
  ) {
    if (!doc || !draft.trim() || !acquireSubmission()) return false;
    if (!(await ensureSavedForAi())) {
      releaseSubmission();
      return false;
    }
    const controller = new AbortController();
    aborter.current = controller;
    setActiveRunReady(false);
    setRunning(thread.id);
    setError("");
    let polished = "";
    let completed = false;
    let streamFailure = "";
    let streamCancelled = false;
    try {
      await stream(
        "/api/runs",
        {
          requestId: crypto.randomUUID(),
          documentVersionId: sourceDocumentVersion(doc, thread.representation_id ?? (isPdfSelector(thread.selector) ? thread.selector.representationId : representationId)),
          ...(thread.representation_id ? {representationId: thread.representation_id} : {}),
          threadId: thread.id,
          anchorId: thread.anchor_id ?? "",
          action: "polish-note",
          input: draft.trim(),
          ...(modelOverride ? { modelOverride } : {}),
        },
        (event, data) => {
          if (event === "route") {
            activeRunId.current = data.runId ?? "";
            setActiveRunReady(Boolean(activeRunId.current));
            setRouteInfo(
              `${data.providerId} · ${data.modelId} · polishing annotation`,
            );
          }
          if (event === "fallback")
            setRouteInfo(`Fallback: ${data.providerId} · ${data.modelId}`);
          if (event === "text_delta") {
            polished += data.delta;
            onDelta(polished);
          }
          if (event === "done") completed = true;
          if (event === "error")
            streamFailure = data.message || "Annotation polishing failed";
          if (event === "cancelled") streamCancelled = true;
        },
        controller.signal,
      );
      if (streamCancelled)
        throw new DOMException("Cancelled", "AbortError");
      if (streamFailure) throw new Error(streamFailure);
      if (!completed) throw new Error("The response ended before completion");
      return Boolean(polished.trim());
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
      return false;
    } finally {
      setRunning(null);
      setActiveRunReady(false);
      aborter.current = null;
      activeRunId.current = "";
      releaseSubmission();
    }
  }
  async function cancelCurrentRun() {
    const runId = activeRunId.current;
    const cancellation = runId
      ? api(`/api/runs/${runId}/cancel`, { method: "POST" }).catch(() => {})
      : Promise.resolve();
    aborter.current?.abort();
    await cancellation;
  }
  async function repairAnchor() {
    if (!repairId || !selection) return;
    try {
      await api(`/api/anchors/${repairId}/repair`, {
        method: "POST",
        body: JSON.stringify({
          blockId: selection.blockId,
          startOffset: selection.startOffset,
          endOffset: selection.endOffset,
          exactQuote: selection.exact,
        }),
      });
      sessionStorage.removeItem("profread-repair-id");
      sessionStorage.removeItem("afterdraft-repair-id");
      setRepairId("");
      setSelection(null);
      await Promise.all([loadThreads(), loadHighlights(), loadArtifacts()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function preview(action: keyof typeof actionLabels) {
    if (!doc || action === "highlight") return;
    try {
      const value = await api<any>("/api/routing/preview", {
        method: "POST",
        body: JSON.stringify({
          documentVersionId: sourceDocumentVersion(doc, representationId),
          action,
          input:
            action === "ask"
              ? question || selection?.exact || ""
              : actionLabels[action],
          hasVisual: selection?.blockType !== "text",
          webEnabled: action === "research",
          ...(modelOverride ? { modelOverride } : {}),
        }),
      });
      setRouteInfo(
        `${value.providerId} · ${value.modelId} · ${value.profile} · ${value.enabledTools.length ? value.enabledTools.join(", ") : "no tools"}`,
      );
    } catch (e) {
      setRouteInfo((e as Error).message);
    }
  }
  useEffect(() => {
    if (selection && doc) void preview("ask");
  }, [
    selection?.blockId,
    selection?.exact,
    selection?.blockType,
    doc?.version_id,
    modelOverride,
  ]);
  function queueEdits(operations: DocumentEditOperation[]) {
    if (!operations.length) return;
    const next = [...pendingEditsRef.current, ...operations];
    pendingEditsRef.current = next;
    setPendingEdits(next);
    for (const operation of operations)
      iframe.current?.contentWindow?.postMessage(
        { type: "apply-edit-operation", operation },
        "*",
      );
    setEditContext(null);
  }
  function queueEdit(operation: DocumentEditOperation) {
    queueEdits([operation]);
  }
  function cancelMove() {
    iframe.current?.contentWindow?.postMessage({ type: "exit-move-mode" }, "*");
    setMoveDraft(null);
  }
  function beginMove(context: EditContext) {
    const label = context.moveLabel?.trim() || context.text.trim() || context.tag;
    setMoveDraft({
      sourceBlockId: context.blockId,
      sourceLabel: label.slice(0, 80),
      destinationBlockId: null,
      destinationLabel: "",
    });
    setEditContext(null);
    iframe.current?.contentWindow?.postMessage(
      { type: "enter-move-mode", blockId: context.blockId },
      "*",
    );
  }
  function finishMove(position: "before" | "after") {
    if (!moveDraft?.destinationBlockId) return;
    const operation = moveObjectOperation(
      moveDraft.sourceBlockId,
      moveDraft.destinationBlockId,
      position,
    );
    if (!operation) {
      setError("Choose a different destination block for this object.");
      return;
    }
    queueEdit(operation);
    cancelMove();
  }
  function finishInlineEditing(): Promise<void> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timeout = window.setTimeout(() => {
        editFinishResolvers.current.delete(requestId);
        resolve();
      }, 500);
      editFinishResolvers.current.set(requestId, () => {
        clearTimeout(timeout);
        resolve();
      });
      iframe.current?.contentWindow?.postMessage(
        { type: "finish-editing", requestId },
        "*",
      );
    });
  }
  async function enterEditMode() {
    if (!doc || running) return;
    try {
      await loadEditHistory(doc.version_id);
      pendingEditsRef.current = [];
      setPendingEdits([]);
      setSelection(null);
      setObjectDraft(null);
      cancelMove();
      if (window.matchMedia("(min-width: 901px)").matches) setDrawer(true);
      setEditMode(true);
      iframe.current?.contentWindow?.postMessage(
        { type: "enter-edit-mode" },
        "*",
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function leaveEditMode(force = false) {
    if (
      !force &&
      pendingEditsRef.current.length &&
      !confirm("Discard every unsaved edit in this session?")
    )
      return;
    pendingEditsRef.current = [];
    setPendingEdits([]);
    setEditContext(null);
    setCaptionDraft(null);
    setObjectDraft(null);
    cancelMove();
    setEditMode(false);
    setContentEpoch((value) => value + 1);
  }
  async function persistEditSession(
    stayInEditMode: boolean,
    finishEditing = true,
  ): Promise<boolean> {
    if (!doc || !tryAcquireLock(editSaveLock)) return false;
    setSavingEdits(true);
    try {
      if (finishEditing) await finishInlineEditing();
      const operations = pendingEditsRef.current;
      if (!operations.length) {
        if (!stayInEditMode) leaveEditMode(true);
        return true;
      }
      iframe.current?.contentWindow?.postMessage(
        { type: "exit-edit-mode" },
        "*",
      );
      setError("");
      const saved = await api<{ revision: number; title: string }>(
        `/api/versions/${doc.version_id}/edits`,
        {
          method: "POST",
          body: JSON.stringify({
            baseRevision: editHistory?.currentRevision ?? 0,
            operations,
          }),
        },
      );
      pendingEditsRef.current = [];
      setPendingEdits([]);
      setDoc((current) =>
        current ? { ...current, title: saved.title } : current,
      );
      await Promise.all([
        loadEditHistory(doc.version_id),
        loadThreads(),
        loadHighlights(),
        loadArtifacts(),
        ...(writerWorkspace ? [loadWriter()] : []),
      ]);
      setEditMode(stayInEditMode);
      setEditContext(null);
      setObjectDraft(null);
      cancelMove();
      setContentEpoch((value) => value + 1);
      return true;
    } catch (e) {
      setError((e as Error).message);
      iframe.current?.contentWindow?.postMessage(
        { type: "enter-edit-mode" },
        "*",
      );
      return false;
    } finally {
      releaseLock(editSaveLock);
      setSavingEdits(false);
    }
  }
  async function saveEditSession() {
    await persistEditSession(false);
  }
  async function ensureSavedForAi(): Promise<boolean> {
    if (!editMode) return true;
    await finishInlineEditing();
    if (!pendingEditsRef.current.length) return true;
    if (!confirm("Save current edits before sending this AI request?"))
      return false;
    return persistEditSession(true, false);
  }
  async function restoreRevision(revision: number) {
    if (!doc || !editHistory) return;
    if (
      pendingEditsRef.current.length &&
      !confirm("Restoring history will discard every unsaved edit. Continue?")
    )
      return;
    if (!confirm(`Restore revision ${revision === 0 ? "Original" : revision}?`))
      return;
    try {
      const restored = await api<{ revision: number; title: string }>(
        `/api/versions/${doc.version_id}/edit-revisions/${revision}/restore`,
        {
          method: "POST",
          body: JSON.stringify({ baseRevision: editHistory.currentRevision }),
        },
      );
      setDoc((current) =>
        current ? { ...current, title: restored.title } : current,
      );
      pendingEditsRef.current = [];
      setPendingEdits([]);
      setEditMode(false);
      await Promise.all([
        loadEditHistory(doc.version_id),
        loadThreads(),
        loadHighlights(),
        loadArtifacts(),
        ...(writerWorkspace ? [loadWriter()] : []),
      ]);
      setHistoryOpen(false);
      setContentEpoch((value) => value + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function backToLibrary() {
    if (
      pendingEditsRef.current.length &&
      !confirm("Discard every unsaved edit and return to the library?")
    )
      return;
    onBack();
  }
  const activeThread = useMemo(
    () =>
      activeEntry?.type === "thread"
        ? threads.find((thread) => thread.id === activeEntry.id)
        : undefined,
    [activeEntry, threads],
  );
  const activeArtifact = useMemo(
    () =>
      activeEntry?.type === "artifact"
        ? artifacts.find((artifact) => artifact.id === activeEntry.id)
        : undefined,
    [activeEntry, artifacts],
  );
  const activeHighlight = useMemo(
    () =>
      activeEntry?.type === "highlight"
        ? highlights.find((highlight) => highlight.id === activeEntry.id)
        : undefined,
    [activeEntry, highlights],
  );
  const activeWriter =
    !pdfView &&
    activeEntry?.type === "writer" &&
    writerWorkspace?.thread.id === activeEntry.id
      ? writerWorkspace
      : undefined;
  function navigateToSidebarSource(source: SidebarSource): void {
    if (source.status === "unmatched") {
      setError(UNMATCHED_SOURCE_ERROR);
      return;
    }
    setError((current) =>
      current === UNMATCHED_SOURCE_ERROR ? "" : current,
    );
    if (isPdfSelector(source.selector)) {
      revealPdfCitation(source.selector);
      return;
    }
    if (pdfView && htmlRepresentation) {
      pendingSourceNavigation.current = source;
      switchRepresentation(htmlRepresentation.id);
      return;
    }
    const payload = sidebarSourceNavigationPayload(source);
    if (payload)
      iframe.current?.contentWindow?.postMessage(payload, "*");
  }
  function activateHighlight(highlight: Highlight): void {
    setActiveEntry({ type: "highlight", id: highlight.id });
    navigateToSidebarSource(highlight);
  }
  function activateThread(thread: Thread): void {
    setActiveEntry({ type: "thread", id: thread.id });
    navigateToSidebarSource(thread);
  }
  function activateArtifact(artifact: Artifact): void {
    setActiveEntry({type: 'artifact', id: artifact.id});
    const source = artifact.representation_id ? doc?.representations?.find(item => item.id === artifact.representation_id) : htmlRepresentation;
    if (source) switchRepresentation(source.id);
  }
  function switchRepresentation(id: string) {
    if (id === representationId || editMode || running) return;
    closeSelectionPanel();
    setRepresentationId(id);
    pdfProgress.current = null;
    void api(`/api/documents/${documentId}/progress`, {method: 'PUT', body: JSON.stringify({representationId: id})}).catch(error => setError(error.message));
  }
  function revealPdfCitation(selector: PdfSelector) {
    if (selector.representationId === representationId) pdfReader.current?.reveal(selector);
    else {
      pendingSourceNavigation.current = selector;
      switchRepresentation(selector.representationId);
    }
  }
  async function preparePdf() {
    setPdfEnableOpen(false); setPdfPreparing(true); setError('');
    try {
      await api(`/api/documents/${documentId}/pdf`, {method: 'POST', body: JSON.stringify({ocrLanguage: pdfOcrLanguage})});
      const info = await api<DocumentInfo>(`/api/documents/${documentId}`);
      setDoc(info);
      const next = info.representations?.find(item => item.kind === 'pdf');
      if (next && ['indexing', 'ready', 'partial'].includes(next.status)) {setRepresentationId(next.id); setPdfPreparing(false);}
    } catch (error) {setPdfPreparing(false); setError((error as Error).message);}
  }
  function receivePdfSelection(value: PdfSelection | null) {
    setSelection(value ? pdfSelectionForReader(value) : null);
    setSelectionPanel('actions'); setPopoverPosition(null); setQuestion(''); setHighlightKind('important'); setHighlightNote(''); setAskRetry(null);
  }
  function receivePdfAnchor(anchorId: string) {
    closeSelectionPanel(); setDrawer(true);
    const thread = threads.find(item => item.anchor_id === anchorId);
    if (thread) setActiveEntry({type: 'thread', id: thread.id});
    else {
      const highlight = highlights.find(item => item.anchor_id === anchorId);
      if (highlight) setActiveEntry({type: 'highlight', id: highlight.id});
    }
  }
  if (!doc)
    return (
      <main className="center">
        {error ? <p className="error">{error}</p> : <p>Preparing article…</p>}
      </main>
    );
  async function download(
    format: "html" | "markdown" | "pdf",
    fullTranscript = false,
  ) {
    try {
      const csrf = decodeURIComponent(
        document.cookie
          .split("; ")
          .find((v) => v.startsWith("profread_csrf="))
          ?.split("=")
          .slice(1)
          .join("=") ?? document.cookie.split('; ').find(value => value.startsWith('afterdraft_csrf='))?.split('=').slice(1).join('=') ?? "",
      );
      const response = await fetch(`/api/documents/${documentId}/exports`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify({ format, fullTranscript, ...(representationId ? {representationId} : {}) }),
      });
      if (!response.ok) throw new Error((await response.json()).error);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(await response.blob());
      link.download = `${doc?.title ?? "ProfRead"}.${format === "markdown" ? "md" : format}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function promote(id: string, value: boolean) {
    await api(`/api/artifacts/${id}/promote`, {
      method: "PATCH",
      body: JSON.stringify({ promoted: value }),
    });
    await loadArtifacts();
  }
  async function deleteArtifact(artifact: Artifact) {
    if (
      !confirm(
        `Remove “${artifactLabel(artifact)}”? This removes only this artifact; the article, highlights, and discussions remain.`,
      )
    )
      return;
    if (!acquireSubmission()) return;
    setError("");
    try {
      await api(`/api/artifacts/${artifact.id}`, {
        method: "DELETE",
        body: JSON.stringify({ expectedVersion: artifact.version }),
      });
      setActiveEntry(null);
      await loadArtifacts();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      releaseSubmission();
    }
  }
  async function acceptArtifactBasis(artifact: Artifact) {
    if (!acquireSubmission()) return;
    setError("");
    try {
      await api(`/api/artifacts/${artifact.id}/accept-current-basis`, {
        method: "POST",
        body: JSON.stringify({
          expectedArtifactVersion: artifact.version,
        }),
      });
      await loadArtifacts();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      releaseSubmission();
    }
  }
  async function updateHighlight(
    id: string,
    kind: HighlightKind,
    note: string | null,
  ) {
    setError("");
    try {
      await api(`/api/highlights/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ kind, note }),
      });
      await Promise.all([loadHighlights(), loadArtifacts()]);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }
  async function deleteHighlight(id: string) {
    if (!confirm("Remove this highlight?")) return false;
    setError("");
    try {
      await api(`/api/highlights/${id}`, { method: "DELETE" });
      setActiveEntry(null);
      await Promise.all([loadHighlights(), loadArtifacts()]);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }
  function resizeSidebar(event: React.PointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
    if (bounds) setSidebarWidth(clampSidebar(bounds.right - event.clientX));
  }
  function finishSidebarResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    document.body.classList.remove("profread-resizing-sidebar");
  }
  return (
    <main
      className={`reader-shell ${drawer ? "drawer-open" : ""} ${editMode ? "editing" : ""} ${pdfView ? 'pdf-view' : ''}`}
    >
      <header className="reader-header">
        <button className="quiet" onClick={backToLibrary}>
          ← Library
        </button>
        <div>
          <strong>{doc.title}</strong>
          <span>
            Version {doc.version}
            {repairId ? " · Select the repaired passage" : ""}
          </span>
        </div>
        <div className="reader-actions">
          {(doc.representations?.length ?? 0) > 1 && <label className="reader-representation-select"><span className="sr-only">Reading view</span><select aria-label="Reading view" value={representationId ?? ''} disabled={editMode || Boolean(running)} onChange={event => {setActiveEntry(null); switchRepresentation(event.target.value);}}>{doc.representations?.filter(item => item.kind === 'html' || ['indexing', 'ready', 'partial', 'cancelled', 'failed'].includes(item.status)).map(item => <option key={item.id} value={item.id}>{item.kind === 'pdf' ? `Original PDF${doc.representations!.filter(source => source.kind === 'pdf').length > 1 || item.documentVersionId && item.documentVersionId !== doc.version_id ? ` · v${item.version ?? '?'}` : ''}` : 'HTML'}</option>)}</select></label>}
          {doc.pdfSourceAvailable && (!pdfRepresentation || pdfRepresentation.status === 'failed') && <button className="quiet" disabled={pdfPreparing || Boolean(running)} onClick={() => setPdfEnableOpen(true)}>{pdfPreparing ? 'Preparing PDF…' : 'Add PDF view'}</button>}
          {!editMode && !pdfView && (
            <button
              className="quiet mobile-edit-button"
              disabled={Boolean(running)}
              onClick={() => void enterEditMode()}
            >
              Edit
            </button>
          )}
          {!editMode && !pdfView && (
            <details className="summary-menu">
              <summary>Edit</summary>
              <button disabled={Boolean(running)} onClick={() => void enterEditMode()}>
                Edit document
              </button>
              <button
                onClick={() => {
                  void loadEditHistory(doc.version_id);
                  setHistoryOpen(true);
                }}
              >
                History
              </button>
            </details>
          )}
          {editMode && (
            <button className="quiet" onClick={() => setHistoryOpen(true)}>
              History
            </button>
          )}
          <details className="summary-menu">
            <summary>Summaries</summary>
            <button disabled={Boolean(running)} onClick={() => documentAction("tldr")}>TL;DR</button>
            <button disabled={Boolean(running)} onClick={() => documentAction("half-page")}>
              Half-page
            </button>
            <button disabled={Boolean(running)} onClick={() => documentAction("visual-recap")}>
              Visual recap
            </button>
          </details>
          <details className="summary-menu">
            <summary>Export</summary>
            {pdfRepresentation && <a href={`/api/representations/${pdfView ? activeRepresentation.id : pdfRepresentation.id}/pdf`} download={`${doc.title}.pdf`}>Original PDF</a>}
            {(!doc.representations || htmlRepresentation) && <button onClick={() => download("html")}>HTML</button>}
            <button onClick={() => download("pdf")}>PDF</button>
            <button onClick={() => download("markdown")}>Markdown</button>
            <button onClick={() => download("html", true)}>
              HTML + full discussion
            </button>
          </details>
          {!pdfView && <button
            className="quiet"
            disabled={Boolean(running)}
            onClick={() => void openWriter()}
          >
            Writer
          </button>}
          <button
            className="quiet"
            onClick={() => setDrawer(!drawer)}
            aria-expanded={drawer}
          >
            Entries{" "}
            <b>
              {threads.filter((thread) => thread.kind !== "writer").length +
                artifacts.length +
                highlights.length}
            </b>
          </button>
        </div>
      </header>
      {editMode && (
        <div className="edit-session-bar" role="status">
          {moveDraft ? (
            <>
              <span className="move-placement-copy">
                <b>Move {moveDraft.sourceLabel}</b> ·{" "}
                {moveDraft.destinationBlockId
                  ? `Place relative to ${moveDraft.destinationLabel}`
                  : "Click a blue “Place here” line between paragraphs"}
              </span>
              {moveDraft.destinationBlockId && (
                <>
                  <button className="primary" onClick={() => finishMove("before")}>
                    Place before
                  </button>
                  <button className="primary" onClick={() => finishMove("after")}>
                    Place after
                  </button>
                </>
              )}
              <button className="quiet" onClick={cancelMove}>
                Cancel move
              </button>
            </>
          ) : (
            <>
              <span>
                Edit mode · Click text to edit · Select an object for sizing, accessibility, captions, or moving ·{" "}
                <b>{pendingEdits.length}</b> pending change
                {pendingEdits.length === 1 ? "" : "s"}
              </span>
              <button className="quiet" onClick={() => leaveEditMode()}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={savingEdits}
                onClick={() => void saveEditSession()}
              >
                {savingEdits ? "Saving…" : "Save changes"}
              </button>
            </>
          )}
        </div>
      )}
      {error && (
        <div className="toast" role="alert">
          {error}
          <button onClick={() => setError("")}>×</button>
        </div>
      )}
      {pdfEnableOpen && <div className="modal-backdrop"><form className="edit-dialog pdf-enable-dialog" role="dialog" aria-modal="true" aria-labelledby="pdf-enable-title" onSubmit={event => {event.preventDefault(); void preparePdf();}}><header><h2 id="pdf-enable-title">Add original PDF view</h2><button type="button" className="quiet" onClick={() => setPdfEnableOpen(false)}>Close</button></header><p>Read and discuss the retained original PDF. Existing HTML annotations remain available in the HTML view.</p><label>Text recognition language<select value={pdfOcrLanguage} onChange={event => setPdfOcrLanguage(event.target.value as 'eng' | 'eng+kor')}><option value="eng">English</option><option value="eng+kor">English + Korean</option></select></label><small>Text recognition is used for pages without usable embedded text.</small><footer><button type="button" onClick={() => setPdfEnableOpen(false)}>Cancel</button><button className="primary">Prepare PDF view</button></footer></form></div>}
      <div
        className="reader-grid"
        style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}
      >
        <section
          ref={paper}
          className={`paper${
            selection ? ` selection-${selectionPanel}` : ""
          }${
            popoverPosition?.mode === "dock"
              ? ` selection-actions-${popoverPosition.side}`
              : ""
          }`}
        >
          {pdfView && representationId ? <PdfReader ref={pdfReader} representationId={representationId} title={doc.title} markers={pdfMarkers} onSelection={receivePdfSelection} onGeometry={rect => setSelection(current => current?.pdfSelector ? {...current, rect} : current)} onAnchorClick={receivePdfAnchor} onProgress={progress => {pdfProgress.current = progress;}} onError={setError} onIndexChange={source => {
            if (source.extractionRevision === activeRepresentation?.extractionRevision && source.status === activeRepresentation?.status) return;
            setDoc(current => current?.representations ? {...current, representations: current.representations.map(item => item.id === representationId ? {...item, ...source} : item)} : current);
            void loadArtifacts().catch(error => setError(error.message));
          }} onReady={() => {
            const pending = pendingSourceNavigation.current;
            if (pending && isPdfSelector(pending)) {pdfReader.current?.reveal(pending); pendingSourceNavigation.current = null;}
          }}/> : <iframe
            key={contentEpoch}
            ref={iframe}
            title={doc.title}
            src={`/api/versions/${doc.version_id}/content`}
            sandbox="allow-scripts allow-same-origin allow-presentation"
          />}
          {selection && selectionPanel === "actions" && (
            <div
              ref={toolbar}
              className="selection-tools"
              data-positioned={popoverPosition ? "true" : "false"}
              data-mode={popoverPosition?.mode}
              data-side={popoverPosition?.side}
              style={
                popoverPosition?.mode === "overlay"
                  ? { top: popoverPosition.top, left: popoverPosition.left }
                  : undefined
              }
              role="toolbar"
              aria-label="Selection actions"
            >
              {selection.exact && (
                <button
                  onClick={() => void copySelectionText()}
                  aria-label="Copy selected text"
                  aria-live="polite"
                >
                  {copiedSelectionKey ===
                  `${selection.blockId}:${selection.startOffset}:${selection.endOffset}`
                    ? "Copied"
                    : "Copy"}
                </button>
              )}
              {repairId && !pdfView && (
                <button className="repair-action" onClick={repairAnchor}>
                  Attach annotation here
                </button>
              )}
              {(!repairId || pdfView) && (
                <select
                  aria-label="Model override"
                  value={modelOverride}
                  onChange={(event) => {
                    setModelOverride(event.target.value);
                    void preview("ask");
                  }}
                >
                  <option value="">Automatic model</option>
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </select>
              )}
              {(!repairId || pdfView) &&
                availableSelectionActions(
                  editMode,
                  Boolean(selection.exact || selection.pdfSelector),
                ).map((action) => (
                  <button
                    key={action}
                    onPointerEnter={() => void preview(action)}
                    onFocus={() => void preview(action)}
                    onClick={() => {
                      if (action === "ask") openAskComposer();
                      else if (action === "highlight")
                        openHighlightComposer();
                      else void act(action);
                    }}
                  >
                    {actionLabels[action]}
                  </button>
                  ))}
              <button
                className="close"
                onClick={closeSelectionPanel}
                aria-label="Close selection actions"
              >
                ×
              </button>
            </div>
          )}
          {selection && selectionPanel === "composing" && (
            <div
              className="selection-composer"
              role="group"
              aria-label="Ask about selected passage"
            >
              <span
                className="selection-composer-context"
                title={selection.exact || "Selected visual"}
              >
                {selection.exact || "Selected visual"}
              </span>
              <input
                ref={questionInput}
                aria-label="Question"
                placeholder="Ask about this passage…"
                value={question}
                disabled={Boolean(running)}
                onChange={(event) => setQuestion(event.target.value)}
                onFocus={() => void preview("ask")}
                onKeyDown={(event) => {
                  if (shouldSubmitComposerKey(event.nativeEvent)) {
                    event.preventDefault();
                    void act("ask");
                  }
                }}
              />
              <select
                aria-label="Model override"
                value={modelOverride}
                disabled={Boolean(running)}
                onChange={(event) => {
                  setModelOverride(event.target.value);
                  void preview("ask");
                }}
              >
                <option value="">Automatic model</option>
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
              <button
                className="primary"
                disabled={Boolean(running)}
                onClick={() => void act("ask")}
              >
                Send
              </button>
              <button className="quiet" onClick={closeSelectionPanel}>
                Close
              </button>
            </div>
          )}
          {selection && selectionPanel === "highlighting" && (
            <div
              className="selection-composer highlight-composer"
              role="group"
              aria-label="Highlight selected passage"
            >
              <span
                className="selection-composer-context"
                title={selection.exact || 'Selected PDF region'}
              >
                {selection.exact || 'Selected PDF region'}
              </span>
              <select
                ref={highlightKindSelect}
                aria-label="Highlight kind"
                value={highlightKind}
                onChange={(event) =>
                  setHighlightKind(event.target.value as HighlightKind)
                }
              >
                <option value="important">Important</option>
                <option value="question">Question</option>
                <option value="comment">Comment</option>
              </select>
              {highlightKind === "comment" ? (
                <textarea
                  ref={highlightNoteInput}
                  aria-label="Highlight comment"
                  placeholder="Add your comment…"
                  maxLength={2000}
                  value={highlightNote}
                  onChange={(event) => setHighlightNote(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      shouldSubmitComposerKey(event.nativeEvent, true)
                    ) {
                      event.preventDefault();
                      void createHighlight();
                    }
                  }}
                />
              ) : (
                <span className="highlight-kind-help">
                  {highlightKind === "important"
                    ? "Prioritize this when summaries are reviewed."
                    : "Keep this as an open question, not summary evidence."}
                </span>
              )}
              <button
                className="primary"
                disabled={
                  Boolean(running) ||
                  (highlightKind === "comment" && !highlightNote.trim())
                }
                onClick={() => void createHighlight()}
              >
                Add highlight
              </button>
              <button className="quiet" onClick={closeSelectionPanel}>
                Close
              </button>
            </div>
          )}
        </section>
        <div
          className="reader-divider"
          role="separator"
          aria-label="Resize article and sidebar"
          aria-orientation="vertical"
          aria-valuemin={SIDEBAR_MIN}
          aria-valuemax={sidebarLimit()}
          aria-valuenow={sidebarWidth}
          tabIndex={drawer ? 0 : -1}
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            document.body.classList.add("profread-resizing-sidebar");
          }}
          onPointerMove={resizeSidebar}
          onPointerUp={finishSidebarResize}
          onPointerCancel={finishSidebarResize}
          onKeyDown={(event) => {
            if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              event.preventDefault();
            if (event.key === "ArrowLeft")
              setSidebarWidth((current) => clampSidebar(current + 20));
            if (event.key === "ArrowRight")
              setSidebarWidth((current) => clampSidebar(current - 20));
            if (event.key === "Home") setSidebarWidth(SIDEBAR_MIN);
            if (event.key === "End") setSidebarWidth(sidebarLimit());
          }}
        />
        <aside
          className={`margin${activeWriter ? " writer-active" : ""}`}
          aria-label={
            activeWriter ? "Document Writer workspace" : "Discussion margin"
          }
        >
          <nav className="entry-pane" aria-label="Reader entries">
            <h2>Entries</h2>
            {!pdfView && <button
              className={
                activeEntry?.type === "writer" ? "active writer-entry" : "writer-entry"
              }
              disabled={Boolean(running)}
              onClick={() => void openWriter()}
            >
              <span>Document Writer</span>
              <i>
                {writerWorkspace
                  ? `${writerWorkspace.sources.length} sources · ${writerWorkspace.proposals.length} proposals`
                  : "Compose the article"}
              </i>
            </button>}
            <section>
              <h3>Artifacts</h3>
              {artifacts.length === 0 && <small>None yet</small>}
              {artifacts.map((artifact) => (
                <button
                  key={artifact.id}
                  className={
                    activeEntry?.type === "artifact" &&
                    activeEntry.id === artifact.id
                      ? "active"
                      : ""
                  }
                  onClick={() => activateArtifact(artifact)}
                >
                  <span>{artifactLabel(artifact)}{doc.representations && <small className="pdf-source-note">{artifact.representation_id && !artifact.representation_id.startsWith('html-') ? 'PDF' : 'HTML'}</small>}</span>
                  {artifact.promoted && <i>Pinned</i>}
                </button>
              ))}
            </section>
            <section>
              <h3>Highlights</h3>
              {highlights.length === 0 && <small>None yet</small>}
              {highlights.map((highlight) => (
                <button
                  key={highlight.id}
                  className={
                    activeEntry?.type === "highlight" &&
                    activeEntry.id === highlight.id
                      ? "active"
                      : ""
                  }
                  onClick={() => activateHighlight(highlight)}
                >
                  <span>{highlight.note || highlight.exact_quote || 'Selected PDF region'}{doc.representations && <small className="pdf-source-note">{sourceRepresentationLabel(highlight)}</small>}</span>
                  <i>{highlight.kind}</i>
                </button>
              ))}
            </section>
            <section>
              <h3>Discussions</h3>
              {threads.filter(
                (thread) =>
                  thread.kind !== "writer" &&
                  !["tldr", "half-page", "visual-recap", "summarize"].includes(
                    thread.action ?? "",
                  ),
              ).length === 0 && <small>None yet</small>}
              {threads
                .filter(
                  (thread) =>
                    thread.kind !== "writer" &&
                    ![
                      "tldr",
                      "half-page",
                      "visual-recap",
                      "summarize",
                    ].includes(thread.action ?? ""),
                )
                .map((thread) => (
                  <button
                    key={thread.id}
                    className={
                      activeEntry?.type === "thread" &&
                      activeEntry.id === thread.id
                        ? "active"
                        : ""
                    }
                    onClick={() => activateThread(thread)}
                  >
                    <span>{threadEntryLabel(thread)}{doc.representations && thread.anchor_id && <small className="pdf-source-note">{sourceRepresentationLabel(thread)}</small>}</span>
                    {thread.action && <i>{thread.action}</i>}
                  </button>
                ))}
            </section>
          </nav>
          <section className="live-pane" aria-live="polite">
            {routeInfo && <div className="route-chip">{routeInfo}</div>}
            {activeArtifact && (
              <ArtifactCard
                artifact={activeArtifact}
                busy={Boolean(running)}
                models={models}
                reviewModel={reviewModelOverrides[activeArtifact.id] ?? ""}
                onReviewModelChange={(value) =>
                  setReviewModelOverrides((current) => ({
                    ...current,
                    [activeArtifact.id]: value,
                  }))
                }
                onAddToWriter={pdfView ? undefined : () =>
                  void addWriterSource("artifact", activeArtifact.id)
                }
                onPromote={() =>
                  promote(activeArtifact.id, !activeArtifact.promoted)
                }
                onDelete={() => void deleteArtifact(activeArtifact)}
                onRegenerate={
                  activeArtifact.scope_type === "document" &&
                  ["tldr", "half-page", "visual-recap"].includes(
                    activeArtifact.kind,
                  )
                    ? () =>
                        documentAction(
                          activeArtifact.kind as
                            | "tldr"
                            | "half-page"
                            | "visual-recap",
                          true,
                        )
                    : undefined
                }
                onAcceptCurrent={
                  activeArtifact.scope_type === "document" &&
                  activeArtifact.freshness &&
                  activeArtifact.freshness.status !== "current"
                    ? () => acceptArtifactBasis(activeArtifact)
                    : undefined
                }
                onReview={
                  activeArtifact.scope_type === "document" &&
                  ["tldr", "half-page", "visual-recap"].includes(
                    activeArtifact.kind,
                  ) &&
                  activeArtifact.freshness?.status !== "current"
                    ? () => void reviewArtifact(activeArtifact)
                    : undefined
                }
              />
            )}
            {activeHighlight && (
              <HighlightCard
                highlight={activeHighlight}
                onAnchor={() => activateHighlight(activeHighlight)}
                onSave={updateHighlight}
                onDelete={deleteHighlight}
                onAddToWriter={pdfView ? undefined : () =>
                  void addWriterSource("highlight", activeHighlight.id)
                }
              />
            )}
            {activeThread && (
              <ThreadCard
                key={activeThread.id}
                thread={activeThread}
                running={running === activeThread.id}
                busy={Boolean(running)}
                writerAvailable={!pdfView}
                onSourceCitation={citation => revealPdfCitation(citation.selector)}
                onAnchor={() => activateThread(activeThread)}
                onNestedAction={nestedAction}
                onThreadAction={threadAction}
                onReply={replyToThread}
                replyDraft={threadReplyDrafts[activeThread.id] ?? ""}
                onReplyDraftChange={(value) =>
                  setThreadReplyDrafts((current) => ({
                    ...current,
                    [activeThread.id]: value,
                  }))
                }
                annotationDraft={
                  threadAnnotationDrafts[activeThread.id] ??
                  activeThread.annotation_text ??
                  threadAnnotationCandidate(activeThread) ??
                  ""
                }
                onAnnotationDraftChange={(value) =>
                  setThreadAnnotationDrafts((current) => ({
                    ...current,
                    [activeThread.id]: value,
                  }))
                }
                onSaveAnnotation={saveThreadAnnotation}
                onDismissAnnotationCandidate={dismissAnnotationCandidate}
                onPolishAnnotation={polishThreadAnnotation}
                onAddAnnotationToWriter={() =>
                  void addWriterSource("thread-annotation", activeThread.id)
                }
                onAddMessageToWriter={(messageId) =>
                  void addWriterSource("message", messageId)
                }
                onCopy={copyAnswer}
              />
            )}
            {activeWriter && !pdfView && (
              <WriterPanel
                workspace={activeWriter}
                models={models}
                instruction={writerInstruction}
                modelOverride={writerModelOverride}
                busy={Boolean(running)}
                onInstructionChange={setWriterInstruction}
                onModelOverrideChange={setWriterModelOverride}
                onRemoveSource={removeWriterSource}
                onGenerate={runWriter}
                onApply={applyWriterProposal}
                onDismiss={dismissWriterProposal}
                onCopy={copyAnswer}
                onBackToEntries={() => setActiveEntry(null)}
              />
            )}
            {!activeArtifact &&
              !activeThread &&
              !activeHighlight &&
              !activeWriter && (
              <p className="margin-empty">
                Choose an entry or select a passage in the article.
              </p>
              )}
          </section>
          {running && (
            <button
              className="cancel"
              disabled={!activeRunReady}
              title={
                activeRunReady
                  ? "Cancel the active model request"
                  : "Starting the model request…"
              }
              onClick={() => void cancelCurrentRun()}
            >
              {activeRunReady ? "Stop response" : "Starting…"}
            </button>
          )}
        </aside>
      </div>
      {editMode && editContext && (
        <div
          className="edit-context-menu"
          role="menu"
          aria-label="HTML edit actions"
          onClick={(event) => event.stopPropagation()}
          style={{
            top: Math.min(innerHeight - 420, Math.max(72, editContext.rect.top)),
            left: Math.min(
              innerWidth - 220,
              Math.max(8, editContext.rect.left),
            ),
          }}
        >
          <small>
            {editContext.selectedText || editContext.text.slice(0, 48)}
          </small>
          {editContext.kind !== "visual" && (
            <>
              {(["bold", "italic", "underline"] as const).map((style) => (
                <button
                  role="menuitem"
                  key={style}
                  onClick={() =>
                    queueEdit({
                      type: "format-text",
                      blockId: editContext.blockId,
                      startOffset: editContext.startOffset,
                      endOffset: editContext.endOffset,
                      style,
                      enabled: !editContext.formats[style],
                    })
                  }
                >
                  {editContext.formats[style] ? "Remove " : ""}
                  {style.charAt(0).toUpperCase() + style.slice(1)}
                  {!editContext.selectedText ? " element" : ""}
                </button>
              ))}
            </>
          )}
          {editContext.kind === "heading" && (
            <>
              <label className="edit-menu-field">
                Heading level
                <select
                  value={Number(editContext.tag.slice(1)) || 2}
                  onChange={(event) =>
                    queueEdit({
                      type: "set-heading-level",
                      blockId: editContext.blockId,
                      level: Number(event.target.value),
                    })
                  }
                >
                  {[1, 2, 3, 4, 5, 6].map((level) => (
                    <option key={level} value={level}>H{level}</option>
                  ))}
                </select>
              </label>
              <button
                role="menuitem"
                onClick={() =>
                  queueEdit({
                    type: "fold-section",
                    blockId: editContext.blockId,
                    folded: editContext.folded !== true,
                  })
                }
              >
                {editContext.folded ? "Unfold section" : "Fold section"}
              </button>
            </>
          )}
          {editContext.kind === "visual" && (
            <>
              <button
                role="menuitem"
                onClick={() => {
                  setObjectDraft(editContext);
                  setEditContext(null);
                }}
              >
                Size, alignment, and alt text…
              </button>
              {editContext.tag !== "math" && (
                <button
                  role="menuitem"
                  onClick={() => {
                    setCaptionDraft(editContext);
                    setEditContext(null);
                  }}
                >
                  Edit caption and number…
                </button>
              )}
              <button role="menuitem" onClick={() => beginMove(editContext)}>
                Move object…
              </button>
            </>
          )}
          <button role="menuitem" onClick={() => setEditContext(null)}>
            Close
          </button>
        </div>
      )}
      {objectDraft && objectDraft.objectLayout && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) =>
            event.target === event.currentTarget && setObjectDraft(null)
          }
        >
          <form
            className="edit-dialog object-edit-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="object-edit-dialog-title"
            onSubmit={(event) => {
              event.preventDefault();
              const values = new FormData(event.currentTarget),
                current: AcademicObjectEditState = {
                  blockId: objectDraft.blockId,
                  altBlockId: objectDraft.altBlockId,
                  altText: objectDraft.altText,
                  ...objectDraft.objectLayout!,
                },
                operations = academicObjectEditOperations(current, {
                  altText: String(values.get("altText") ?? ""),
                  width: String(values.get("width")) as AcademicObjectEditState["width"],
                  alignment: String(values.get("alignment")) as AcademicObjectEditState["alignment"],
                  enlargeable: values.has("enlargeable"),
                  folded: values.has("folded"),
                });
              queueEdits(operations);
              setObjectDraft(null);
            }}
          >
            <header>
              <div>
                <span className="eyebrow">Academic object</span>
                <h2 id="object-edit-dialog-title">Object properties</h2>
              </div>
              <button type="button" className="quiet" onClick={() => setObjectDraft(null)}>×</button>
            </header>
            <label>
              Alternative text
              <textarea
                name="altText"
                maxLength={2000}
                defaultValue={objectDraft.altText}
                placeholder="Describe the object’s informative content for readers who cannot see it."
                autoFocus
              />
            </label>
            <div className="object-layout-fields">
              <label>
                Width
                <select name="width" defaultValue={objectDraft.objectLayout.width}>
                  <option value="auto">Natural</option>
                  <option value="content">Content width</option>
                  <option value="full">Full width</option>
                </select>
              </label>
              <label>
                Alignment
                <select name="alignment" defaultValue={objectDraft.objectLayout.alignment}>
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                  <option value="right">Right</option>
                </select>
              </label>
            </div>
            <label className="edit-check-row">
              <input type="checkbox" name="enlargeable" defaultChecked={objectDraft.objectLayout.enlargeable}/>
              Allow click-to-enlarge
            </label>
            <label className="edit-check-row">
              <input type="checkbox" name="folded" defaultChecked={objectDraft.objectLayout.folded}/>
              Start folded behind a disclosure
            </label>
            <footer>
              <button type="button" onClick={() => setObjectDraft(null)}>Cancel</button>
              <button className="primary">Apply to draft</button>
            </footer>
          </form>
        </div>
      )}
      {captionDraft && (
        <div className="modal-backdrop" role="presentation">
          <form
            className="edit-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="caption-dialog-title"
            onSubmit={(event) => {
              event.preventDefault();
              const values = new FormData(event.currentTarget),
                current = captionDraft.caption ?? {
                  label: "",
                  number: "",
                  caption: "",
                  structured: false,
                };
              queueEdit(
                captionEditOperation(
                  { blockId: captionDraft.blockId, ...current },
                  {
                    label: String(values.get("label") ?? ""),
                    number: String(values.get("number") ?? ""),
                    caption: String(values.get("caption") ?? ""),
                  },
                ),
              );
              setCaptionDraft(null);
            }}
          >
            <header>
              <div>
                <span className="eyebrow">Manual visual label</span>
                <h2 id="caption-dialog-title">Caption and number</h2>
              </div>
              <button
                type="button"
                className="quiet"
                onClick={() => setCaptionDraft(null)}
              >
                ×
              </button>
            </header>
            <div className="caption-fields">
              <label>
                Label
                <input
                  name="label"
                  maxLength={40}
                  defaultValue={captionDraft.caption?.label ?? ""}
                  placeholder="Diagram"
                  autoFocus
                />
              </label>
              <label>
                Number
                <input
                  name="number"
                  maxLength={20}
                  defaultValue={captionDraft.caption?.number ?? ""}
                  placeholder="3a"
                />
              </label>
            </div>
            <label>
              Caption
              <textarea
                name="caption"
                maxLength={2000}
                defaultValue={captionDraft.caption?.caption ?? ""}
                placeholder="Memory topology"
                readOnly={captionDraft.caption?.structured === true}
                aria-describedby={
                  captionDraft.caption?.structured
                    ? "structured-caption-help"
                    : undefined
                }
              />
            </label>
            {captionDraft.caption?.structured ? (
              <p id="structured-caption-help">
                This caption body contains equations, links, or formatting. Its
                rich content is preserved here; only the label and number can be
                changed.
              </p>
            ) : (
              <p>Clear all three fields to remove a caption added by ProfRead.</p>
            )}
            <footer>
              <button type="button" onClick={() => setCaptionDraft(null)}>
                Cancel
              </button>
              <button className="primary">Apply to draft</button>
            </footer>
          </form>
        </div>
      )}
      {historyOpen && editHistory && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="edit-dialog edit-history-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-history-title"
          >
            <header>
              <div>
                <span className="eyebrow">Current revision {editHistory.currentRevision}</span>
                <h2 id="edit-history-title">Edit history</h2>
              </div>
              <button className="quiet" onClick={() => setHistoryOpen(false)}>
                ×
              </button>
            </header>
            <div className="edit-revisions">
              {editHistory.revisions.map((revision) => (
                <article key={revision.revision}>
                  <div>
                    <b>
                      {revision.revision === 0
                        ? "Original import"
                        : `Revision ${revision.revision}`}
                    </b>
                    <small>{new Date(revision.created_at).toLocaleString()}</small>
                    <span>{editSummary(revision)}</span>
                  </div>
                  {revision.revision !== editHistory.currentRevision && (
                    <button onClick={() => void restoreRevision(revision.revision)}>
                      Restore
                    </button>
                  )}
                </article>
              ))}
            </div>
            <footer>
              <button onClick={() => setHistoryOpen(false)}>Close</button>
            </footer>
          </section>
        </div>
      )}
    </main>
  );
}

function updateDraft(messages: Message[], delta: string): Message[] {
  const last = messages.at(-1);
  if (last?.id === "draft")
    return [
      ...messages.slice(0, -1),
      { ...last, content: last.content + delta },
    ];
  return [
    ...messages,
    {
      id: "draft",
      role: "assistant",
      content: delta,
      createdAt: new Date().toISOString(),
    },
  ];
}
function artifactLabel(artifact: Artifact): string {
  const names: Record<string, string> = {
    tldr: "TL;DR",
    "half-page": "Half-page",
    "visual-recap": "Visual recap",
    compact: "Compact note",
    diagram: "Diagram",
  };
  return `${names[artifact.kind] ?? artifact.kind} · ${artifact.scope_type}`;
}
function threadEntryLabel(thread: Thread): string {
  const text =
    thread.annotation_text ||
    threadAnnotationCandidate(thread) ||
    thread.exact_quote ||
    thread.title ||
    "Follow-up";
  return `${thread.action === "define" ? "Define · " : ""}${text}`;
}
function editSummary(revision: EditRevision): string {
  if (revision.revision === 0) return "Unedited source";
  if (revision.restored_from_revision !== null)
    return `Restored from ${revision.restored_from_revision === 0 ? "original" : `revision ${revision.restored_from_revision}`}`;
  const labels: Record<string, string> = {
    "replace-text": "text",
    "format-text": "formatting",
    "fold-section": "folding",
    "set-caption": "caption",
    "resize-image": "image sizing",
  };
  return Object.entries(revision.summary)
    .map(([kind, count]) => `${count} ${labels[kind] ?? kind}`)
    .join(" · ");
}
export function ArtifactCard({
  artifact,
  busy,
  models = [],
  reviewModel = "",
  onPromote,
  onRegenerate,
  onAcceptCurrent,
  onReview,
  onReviewModelChange,
  onAddToWriter,
  onDelete,
}: {
  artifact: Artifact;
  busy: boolean;
  models?: Model[];
  reviewModel?: string;
  onPromote: () => void;
  onRegenerate?: (() => void) | undefined;
  onAcceptCurrent?: (() => void) | undefined;
  onReview?: (() => void) | undefined;
  onReviewModelChange?: ((value: string) => void) | undefined;
  onAddToWriter?: (() => void) | undefined;
  onDelete: () => void;
}) {
  const freshness = artifact.freshness;
  return (
    <article className="artifact-card">
      <header>
        <b>{artifact.kind}</b>
        <span>
          {onAddToWriter && (
            <button disabled={busy} onClick={onAddToWriter}>
              Add to Writer
            </button>
          )}
          {onAcceptCurrent && (
            <button disabled={busy} onClick={onAcceptCurrent}>Keep current</button>
          )}
          {onRegenerate && <button disabled={busy} onClick={onRegenerate}>Regenerate</button>}
          <button onClick={onPromote}>
            {artifact.promoted ? "Unpin" : "Pin"}
          </button>
          <button className="danger-link" disabled={busy} onClick={onDelete}>
            Remove
          </button>
        </span>
      </header>
      {freshness && (
        <div
          className={`artifact-freshness freshness-${freshness.status}`}
          role="status"
        >
          <b>
            {freshness.status === "current"
              ? "Up to date"
              : freshness.status === "needs-review"
                ? "Review recommended"
                : "Update status unknown"}
          </b>
          {freshness.reasons.length > 0 && (
            <span>{freshness.reasons.map(freshnessReason).join(" · ")}</span>
          )}
        </div>
      )}
      {onReview && (
        <div className="artifact-review-controls">
          <label>
            Review model
            <select
              value={reviewModel}
              disabled={busy}
              onChange={(event) => onReviewModelChange?.(event.target.value)}
            >
              <option value="">Automatic model</option>
              {models.map((model) => (
                <option
                  key={model.id}
                  value={model.id}
                  disabled={model.ready === false}
                >
                  {model.label}
                  {model.ready === false ? " (unavailable)" : ""}
                </option>
              ))}
            </select>
          </label>
          <button className="primary" disabled={busy} onClick={onReview}>
            Review changes
          </button>
        </div>
      )}
      {artifact.latestReview && (
        <details className="artifact-review-history">
          <summary>
            Latest semantic review ·{" "}
            {artifact.latestReview.decision ?? artifact.latestReview.status}
            {artifact.latestReview.decision &&
            artifact.latestReview.status !== "applied"
              ? ` · ${artifact.latestReview.status}`
              : ""}
          </summary>
          {artifact.latestReview.rationale && (
            <p>{artifact.latestReview.rationale}</p>
          )}
          <small>
            {artifact.latestReview.status !== "applied"
              ? "This review did not change the artifact. · "
              : ""}
            {artifact.latestReview.sourceStatus
              ? `Source status: ${artifact.latestReview.sourceStatus}`
              : artifact.latestReview.status}
          </small>
          <small>
            {artifact.latestReview.modelId
              ? `Model: ${artifact.latestReview.modelId} · `
              : ""}
            Basis revision {artifact.latestReview.basis.revision} ·{" "}
            {new Date(artifact.latestReview.createdAt).toLocaleString()}
          </small>
        </details>
      )}
      {artifact.kind === "diagram" ? (
        <DiagramView spec={artifact.content} />
      ) : artifact.kind === "visual-recap" ? (
        <VisualRecap recap={artifact.content} />
      ) : (
        <MarkdownContent
          content={
            typeof artifact.content === "string"
              ? artifact.content
              : JSON.stringify(artifact.content, null, 2)
          }
        />
      )}
      <small>Sources: {artifact.sourceRefs.join(", ")}</small>
    </article>
  );
}
function freshnessReason(reason: string): string {
  const labels: Record<string, string> = {
    "document-version-changed": "new document version",
    "document-edits-changed": "document edited",
    "pdf-extraction-changed": "PDF text index updated",
    "source-representation-changed": "source view changed",
    "reader-signals-changed": "important highlights or comments changed",
    "missing-basis": "created before update tracking",
  };
  return labels[reason] ?? reason;
}

export function HighlightCard({
  highlight,
  onAnchor,
  onSave,
  onDelete,
  onAddToWriter,
}: {
  highlight: Highlight;
  onAnchor: () => void;
  onSave: (
    id: string,
    kind: HighlightKind,
    note: string | null,
  ) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onAddToWriter?: (() => void) | undefined;
}) {
  const [kind, setKind] = useState<HighlightKind>(highlight.kind);
  const [note, setNote] = useState(highlight.note ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setKind(highlight.kind);
    setNote(highlight.note ?? "");
  }, [highlight.id, highlight.kind, highlight.note]);
  const invalid = kind === "comment" && !note.trim();
  const dirty = kind !== highlight.kind || note.trim() !== (highlight.note ?? "");
  return (
    <article className={`highlight-card highlight-${kind}`}>
      <header>
        <span className="highlight-kind-dot" aria-hidden="true" />
        <b>{kind}</b>
      </header>
      <button className="quote" onClick={onAnchor}>
        {highlight.exact_quote}
      </button>
      <label>
        Kind
        <select
          value={kind}
          onChange={(event) => setKind(event.target.value as HighlightKind)}
        >
          <option value="important">Important</option>
          <option value="question">Question</option>
          <option value="comment">Comment</option>
        </select>
      </label>
      <label>
        {kind === "comment" ? "Comment" : "Optional note"}
        <textarea
          maxLength={2000}
          value={note}
          placeholder={
            kind === "comment"
              ? "Write the reader comment attached to this passage…"
              : "Add context for yourself…"
          }
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      <small>
        {kind === "important"
          ? "Summary review treats this as reader-prioritized evidence."
          : kind === "question"
            ? "Open questions are kept separate from summary evidence."
            : "Comments influence summaries as reader opinion, not source fact."}
      </small>
      <footer>
        {onAddToWriter && (
          <button disabled={saving || dirty} onClick={onAddToWriter}>
            {dirty ? "Save before adding" : "Add to Writer"}
          </button>
        )}
        <button
          className="danger-link"
          disabled={saving}
          onClick={() => void onDelete(highlight.id)}
        >
          Remove
        </button>
        <button
          className="primary"
          disabled={saving || invalid || !dirty}
          onClick={async () => {
            setSaving(true);
            await onSave(highlight.id, kind, note.trim() || null);
            setSaving(false);
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </footer>
    </article>
  );
}
function DiagramView({ spec }: { spec: any }) {
  const nodes = Array.isArray(spec?.nodes) ? spec.nodes : [],
    positions = Object.fromEntries(
      nodes.map((node: any, index: number) => [
        node.id,
        { x: 80 + (index % 2) * 170, y: 45 + Math.floor(index / 2) * 85 },
      ]),
    );
  return (
    <figure
      className="diagram"
      aria-labelledby={`diagram-${String(spec?.title).replace(/\W/g, "")}`}
    >
      <svg
        viewBox={`0 0 340 ${Math.max(130, Math.ceil(nodes.length / 2) * 85 + 30)}`}
        role="img"
      >
        <title id={`diagram-${String(spec?.title).replace(/\W/g, "")}`}>
          {spec?.title}
        </title>
        <desc>
          {spec?.layout} diagram with {nodes.length} concepts
        </desc>
        {(spec?.edges ?? []).map((edge: any, index: number) => {
          const a = positions[edge.from],
            b = positions[edge.to];
          return a && b ? (
            <g key={index}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="currentColor" />
              <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 4}>
                {edge.label}
              </text>
            </g>
          ) : null;
        })}
        {nodes.map((node: any) => (
          <g
            key={node.id}
            transform={`translate(${positions[node.id].x - 62} ${positions[node.id].y - 22})`}
          >
            <rect width="124" height="44" rx="5" />
            <text x="62" y="25" textAnchor="middle">
              {node.label}
            </text>
          </g>
        ))}
      </svg>
      <figcaption>
        {spec?.title}.{" "}
        <span className="sr-only">
          {nodes.map((n: any) => n.label).join("; ")}
        </span>
      </figcaption>
    </figure>
  );
}
function VisualRecap({ recap }: { recap: any }) {
  return (
    <section className="visual-recap">
      {recap?.image?.url && (
        <figure className="recap-image">
          <img src={recap.image.url} alt={recap.image.alt} />
          <figcaption>Generated with {recap.image.modelId}</figcaption>
        </figure>
      )}
      <details className="recap-details">
        <summary>Show textual recap</summary>
        <h3>{recap?.title}</h3>
        <MarkdownContent content={String(recap?.thesis ?? "")} />
        {(recap?.sections ?? []).map((section: any, index: number) => (
          <section key={index}>
            <h4>{section.title}</h4>
            <MarkdownContent content={String(section.summary ?? "")} />
          </section>
        ))}
        <h4>Takeaways</h4>
        <ul>
          {(recap?.takeaways ?? []).map((item: string, index: number) => (
            <li key={index}>
              <MarkdownContent content={item} />
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
export function ThreadCard({
  thread,
  running,
  busy,
  onAnchor,
  onNestedAction,
  onThreadAction,
  onReply,
  replyDraft,
  onReplyDraftChange,
  annotationDraft,
  onAnnotationDraftChange,
  onSaveAnnotation,
  onDismissAnnotationCandidate,
  onPolishAnnotation,
  onAddAnnotationToWriter,
  onAddMessageToWriter,
  onCopy,
  writerAvailable = true,
  onSourceCitation,
}: {
  thread: Thread;
  running: boolean;
  busy: boolean;
  onAnchor: () => void;
  onNestedAction: (
    id: string,
    text: string,
    action?: "ask" | "compact" | "tldr" | "half-page" | "visual-recap",
  ) => void;
  onThreadAction: (
    thread: Thread,
    action: "compact" | "tldr" | "half-page" | "visual-recap",
  ) => void;
  onReply: (thread: Thread, text: string) => Promise<boolean>;
  replyDraft: string;
  onReplyDraftChange: (value: string) => void;
  annotationDraft: string;
  onAnnotationDraftChange: (value: string) => void;
  onSaveAnnotation: (
    threadId: string,
    annotationText: string | null,
  ) => Promise<boolean>;
  onDismissAnnotationCandidate: (threadId: string) => Promise<boolean>;
  onPolishAnnotation: (
    thread: Thread,
    draft: string,
    onDelta: (value: string) => void,
  ) => Promise<boolean>;
  onAddAnnotationToWriter: () => void;
  onAddMessageToWriter: (messageId: string) => void;
  writerAvailable?: boolean;
  onSourceCitation?: (citation: SourceCitation) => void;
  onCopy: (text: string) => Promise<void>;
}) {
  const [annotationBusy, setAnnotationBusy] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState("");
  const [replySending, setReplySending] = useState(false);
  const savedAnnotation = thread.annotation_text ?? "";
  const candidateAnnotation = threadAnnotationCandidate(thread);
  const annotationDirty = annotationDraft.trim() !== savedAnnotation;
  return (
    <article id={`thread-${thread.id}`} tabIndex={-1} className="thread-card">
      <button className="quote" onClick={onAnchor}>
        {thread.exact_quote || thread.title || "Follow-up"}
      </button>
      {thread.anchor_id && !thread.parent_message_id && (
        <section className="thread-annotation" aria-label="Article annotation">
          <header>
            <b>Article annotation</b>
            <small>1–2 sentences shown with this passage</small>
          </header>
          {candidateAnnotation && (
            <div className="annotation-candidate" role="status">
              <span>
                Suggested from the latest answer. Edit and save it, or dismiss
                the suggestion.
              </span>
              <button
                className="danger-link"
                disabled={annotationBusy || busy}
                onClick={async () => {
                  setAnnotationBusy(true);
                  await onDismissAnnotationCandidate(thread.id);
                  setAnnotationBusy(false);
                }}
              >
                Dismiss suggestion
              </button>
            </div>
          )}
          <textarea
            aria-label="Annotation draft"
            maxLength={1000}
            placeholder="Jot keywords or a rough note, then polish it…"
            value={annotationDraft}
            disabled={annotationBusy}
            onChange={(event) =>
              onAnnotationDraftChange(
                limitUnicodeCodePoints(event.target.value, 500),
              )
            }
          />
          <footer>
            {savedAnnotation && writerAvailable && (
              <button
                disabled={annotationBusy || busy || annotationDirty}
                onClick={onAddAnnotationToWriter}
              >
                {annotationDirty ? "Save before adding" : "Add to Writer"}
              </button>
            )}
            {savedAnnotation && (
              <button
                className="danger-link"
                disabled={annotationBusy || busy}
                onClick={async () => {
                  setAnnotationBusy(true);
                  await onSaveAnnotation(thread.id, null);
                  setAnnotationBusy(false);
                }}
              >
                Remove
              </button>
            )}
            <button
              disabled={annotationBusy || busy || !annotationDraft.trim()}
              onClick={async () => {
                const original = annotationDraft;
                setAnnotationBusy(true);
                const polished = await onPolishAnnotation(
                  thread,
                  original,
                  onAnnotationDraftChange,
                );
                if (!polished) onAnnotationDraftChange(original);
                setAnnotationBusy(false);
              }}
            >
              {annotationBusy ? "Polishing…" : "Polish with AI"}
            </button>
            <button
              className="primary"
              disabled={
                annotationBusy ||
                busy ||
                !annotationDraft.trim() ||
                !annotationDirty
              }
              onClick={async () => {
                setAnnotationBusy(true);
                await onSaveAnnotation(thread.id, annotationDraft.trim());
                setAnnotationBusy(false);
              }}
            >
              Save annotation
            </button>
          </footer>
        </section>
      )}
      {thread.messages.map((message) => (
        <div key={message.id} className={`message ${message.role}`}>
          <span>{message.role === "assistant" ? "ProfRead" : "You"}</span>
          <MarkdownContent content={message.content} />
          {message.sourceCitations?.length && onSourceCitation ? <div className="source-citation-list" aria-label="PDF sources">{message.sourceCitations.map(citation => <button key={citation.id} onClick={() => onSourceCitation(citation)}>{citation.label}</button>)}</div> : null}
          {message.role === "assistant" && message.id !== "draft" && (
            <div className="message-actions">
              {writerAvailable && <button
                disabled={busy}
                onClick={() => onAddMessageToWriter(message.id)}
              >
                Add to Writer
              </button>}
              <button
                onClick={async () => {
                  try {
                    await onCopy(message.content);
                    setCopiedMessageId(message.id);
                  } catch {
                    setCopiedMessageId("");
                  }
                }}
              >
                {copiedMessageId === message.id ? "Copied" : "Copy answer"}
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  onNestedAction(message.id, message.content, "compact")
                }
              >
                Compact
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  onNestedAction(message.id, message.content, "tldr")
                }
              >
                TL;DR
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  onNestedAction(message.id, message.content, "visual-recap")
                }
              >
                Visual recap
              </button>
            </div>
          )}
        </div>
      ))}
      <div className="thread-actions">
        <span>Thread subtree</span>
        <button
          disabled={busy}
          onClick={() => onThreadAction(thread, "compact")}
        >
          Compact
        </button>
        <button
          disabled={busy}
          onClick={() => onThreadAction(thread, "half-page")}
        >
          Half-page
        </button>
        <button
          disabled={busy}
          onClick={() => onThreadAction(thread, "visual-recap")}
        >
          Visual recap
        </button>
      </div>
      {running && <span className="thinking">Thinking…</span>}
      <form
        className="chat-composer"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!replyDraft.trim()) return;
          const submitted = replyDraft;
          setReplySending(true);
          const completed = await onReply(thread, submitted);
          if (completed) onReplyDraftChange("");
          setReplySending(false);
        }}
      >
        <input
          aria-label="Continue discussion"
          placeholder="Continue this discussion…"
          value={replyDraft}
          onChange={(event) => onReplyDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.nativeEvent.isComposing)
              event.preventDefault();
          }}
          disabled={busy || replySending}
        />
        <button disabled={busy || replySending || !replyDraft.trim()}>
          {replySending ? "Sending…" : "Send"}
        </button>
      </form>
    </article>
  );
}

function convertTexMathDelimiters(value: string): string {
  return value
    .replace(
      /(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]/g,
      (_match, latex: string) => `$$${latex}$$`,
    )
    .replace(
      /(?<!\\)\\\(([^\n]*?)(?<!\\)\\\)/g,
      (_match, latex: string) => `$${latex}$`,
    );
}

function isEscapedCharacter(value: string, index: number): boolean {
  let backslashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && value[cursor] === "\\";
    cursor -= 1
  ) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function convertOutsideCodeSpans(value: string): string {
  let output = "";
  let plainStart = 0;
  let cursor = 0;
  while (cursor < value.length) {
    if (value[cursor] !== "`" || isEscapedCharacter(value, cursor)) {
      cursor += 1;
      continue;
    }
    let runLength = 1;
    while (value[cursor + runLength] === "`") runLength += 1;
    let closing = cursor + runLength;
    while (closing < value.length) {
      if (value[closing] !== "`") {
        closing += 1;
        continue;
      }
      let closingLength = 1;
      while (value[closing + closingLength] === "`") closingLength += 1;
      if (closingLength === runLength) break;
      closing += closingLength;
    }
    if (closing >= value.length) {
      cursor += runLength;
      continue;
    }
    output += convertTexMathDelimiters(value.slice(plainStart, cursor));
    output += value.slice(cursor, closing + runLength);
    cursor = closing + runLength;
    plainStart = cursor;
  }
  return output + convertTexMathDelimiters(value.slice(plainStart));
}

function stripMarkdownContainerPrefixes(value: string): string {
  let content = value;
  while (true) {
    const previous = content;
    content = content.replace(/^ {0,3}>[ \t]?/, "");
    content = content.replace(
      /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/,
      "",
    );
    if (content === previous) return content;
  }
}

function openingMarkdownFence(value: string): string {
  return (
    stripMarkdownContainerPrefixes(value).match(
      /^ {0,3}(`{3,}|~{3,})/,
    )?.[1] ?? ""
  );
}

function closingMarkdownFence(value: string): string {
  return (
    stripMarkdownContainerPrefixes(value).match(
      /^[ \t]*(`+|~+)[ \t]*$/,
    )?.[1] ?? ""
  );
}

function isIndentedMarkdownCode(value: string): boolean {
  return /^(?: {4}|\t)/.test(stripMarkdownContainerPrefixes(value));
}

export function normalizeMarkdownMath(value: string): string {
  const lines = value.split(/(?<=\n)/);
  let output = "";
  let plain = "";
  let fenceCharacter = "";
  let fenceLength = 0;
  const flush = () => {
    output += convertOutsideCodeSpans(plain);
    plain = "";
  };
  for (const line of lines) {
    const withoutNewline = line.replace(/\r?\n$/, "");
    if (fenceCharacter) {
      output += line;
      const closing = closingMarkdownFence(withoutNewline);
      if (
        closing &&
        closing[0] === fenceCharacter &&
        closing.length >= fenceLength
      ) {
        fenceCharacter = "";
        fenceLength = 0;
      }
      continue;
    }
    const opening = openingMarkdownFence(withoutNewline);
    if (opening) {
      flush();
      output += line;
      fenceCharacter = opening[0]!;
      fenceLength = opening.length;
    } else if (isIndentedMarkdownCode(withoutNewline)) {
      flush();
      output += line;
    } else {
      plain += line;
    }
  }
  flush();
  return output;
}

export function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="markdown-output">
      <Markdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          [
            rehypeKatex,
            {
              throwOnError: false,
              strict: "ignore",
              trust: false,
              maxSize: 20,
              maxExpand: 1000,
            },
          ],
        ]}
        skipHtml
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          img: ({ alt }) => (
            <span className="markdown-image-label">
              {alt ? `[Image: ${alt}]` : "[Image]"}
            </span>
          ),
        }}
      >
        {normalizeMarkdownMath(content)}
      </Markdown>
    </div>
  );
}
