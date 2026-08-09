import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnchorSelector } from "@co-reader/shared";
import { api, stream } from "./api.js";
type DocumentInfo = {
  id: string;
  title: string;
  version_id: string;
  version: number;
  block_id: string | null;
  offset_ratio: number | null;
  last_thread_id: string | null;
};
type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  parentMessageId?: string;
  createdAt: string;
};
type Thread = {
  id: string;
  document_id: string;
  anchor_id?: string;
  parent_message_id?: string;
  title?: string;
  block_id?: string;
  exact_quote?: string;
  block_type?: string;
  action?: string;
  messages: Message[];
};
type Highlight = {
  id: string;
  anchor_id: string;
  block_id: string;
  exact_quote: string;
  checked: number;
};
type Model = { id: string; label: string; providerId: string; ready?: boolean };
type TaskRoute = { action: string; modelId: string };
type Artifact = {
  id: string;
  kind: string;
  content: any;
  sourceRefs: string[];
  promoted: boolean;
  scope_type: "document" | "section" | "answer" | "thread";
  scope_id: string;
};
type ActiveEntry = { type: "thread" | "artifact"; id: string };
type Selection = AnchorSelector & {
  rect: { top: number; left: number; width: number; height: number };
  visual?: { mimeType: "image/png"; data: string };
};
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

export function Reader({
  documentId,
  onBack,
}: {
  documentId: string;
  onBack: () => void;
}) {
  const [doc, setDoc] = useState<DocumentInfo | null>(null),
    [threads, setThreads] = useState<Thread[]>([]),
    [highlights, setHighlights] = useState<Highlight[]>([]),
    [artifacts, setArtifacts] = useState<Artifact[]>([]),
    [models, setModels] = useState<Model[]>([]),
    [taskRoutes, setTaskRoutes] = useState<TaskRoute[]>([]),
    [modelOverride, setModelOverride] = useState(""),
    [repairId, setRepairId] = useState(
      () => sessionStorage.getItem("co-reader-repair-id") ?? "",
    ),
    [selection, setSelection] = useState<Selection | null>(null),
    [error, setError] = useState(""),
    [question, setQuestion] = useState(""),
    [running, setRunning] = useState<string | null>(null),
    [routeInfo, setRouteInfo] = useState(""),
    [drawer, setDrawer] = useState(false),
    [activeEntry, setActiveEntry] = useState<ActiveEntry | null>(null);
  const iframe = useRef<HTMLIFrameElement>(null),
    toolbar = useRef<HTMLDivElement>(null),
    aborter = useRef<AbortController | null>(null),
    scrollRatio = useRef(0);
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
  useEffect(() => {
    api<DocumentInfo>(`/api/documents/${documentId}`)
      .then((info) => {
        setDoc(info);
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
  }, [documentId, loadThreads, loadHighlights, loadArtifacts]);
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
        event.data?.source !== "co-reader"
      )
        return;
      if (event.data.type === "selection")
        setSelection({ ...event.data, blockType: "text" });
      if (event.data.type === "block-selection")
        setSelection({
          blockId: event.data.blockId,
          blockType:
            event.data.blockType === "img" ? "image" : event.data.blockType,
          exact: "",
          prefix: "",
          suffix: "",
          startOffset: 0,
          endOffset: 0,
          rect: event.data.rect,
        });
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
      if (event.data.type === "ready") {
        iframe.current?.contentWindow?.postMessage(
          {
            type: "apply-anchors",
            anchors: [
              ...threads
                .filter((t) => t.anchor_id)
                .map((t) => ({
                  id: t.anchor_id,
                  blockId: t.block_id,
                  exact: t.exact_quote,
                  checked: false,
                  action: t.action,
                })),
              ...highlights.map((h) => ({
                id: h.anchor_id,
                blockId: h.block_id,
                exact: h.exact_quote,
                checked: Boolean(h.checked),
              })),
            ],
          },
          "*",
        );
        iframe.current?.contentWindow?.postMessage(
          { type: "restore-progress", ratio: doc?.offset_ratio ?? 0 },
          "*",
        );
      }
      if (event.data.type === "anchor-click") {
        setDrawer(true);
        setSelection(null);
        const target = threads.find((t) => t.anchor_id === event.data.anchorId);
        if (target) setActiveEntry({ type: "thread", id: target.id });
      }
    };
    addEventListener("message", receive);
    return () => removeEventListener("message", receive);
  }, [threads, highlights, doc?.offset_ratio]);
  useEffect(() => {
    iframe.current?.contentWindow?.postMessage(
      {
        type: "apply-anchors",
        anchors: [
          ...threads
            .filter((t) => t.anchor_id)
            .map((t) => ({
              id: t.anchor_id,
              blockId: t.block_id,
              exact: t.exact_quote,
              checked: false,
              action: t.action,
            })),
          ...highlights.map((h) => ({
            id: h.anchor_id,
            blockId: h.block_id,
            exact: h.exact_quote,
            checked: Boolean(h.checked),
          })),
        ],
      },
      "*",
    );
  }, [threads, highlights]);
  useEffect(() => {
    if (selection)
      requestAnimationFrame(() =>
        toolbar.current
          ?.querySelector<HTMLElement>("button,select,input")
          ?.focus(),
      );
  }, [selection?.blockId, selection?.exact]);
  useEffect(() => {
    const save = () =>
      api(`/api/documents/${documentId}/progress`, {
        method: "PUT",
        body: JSON.stringify({
          blockId: null,
          offsetRatio: Math.min(1, scrollRatio.current),
        }),
      }).catch(() => {});
    const id = setInterval(save, 10000);
    return () => {
      clearInterval(id);
      save();
    };
  }, [documentId]);
  const createAnchor = async () => {
    if (!selection || !doc) throw new Error("Select something first");
    return api<{ id: string }>("/api/anchors", {
      method: "POST",
      body: JSON.stringify({
        documentVersionId: doc.version_id,
        selector: {
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
  async function act(action: keyof typeof actionLabels) {
    if (!selection || !doc) return;
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
          setSelection(null);
          return;
        }
      }
      const anchor = await createAnchor();
      if (action === "highlight") {
        await api("/api/highlights", {
          method: "POST",
          body: JSON.stringify({ anchorId: anchor.id, checked: true }),
        });
        await loadHighlights();
        setSelection(null);
        return;
      }
      const prompt =
        action === "ask"
          ? question.trim() || selection.exact
          : actionLabels[action];
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
      setSelection(null);
      await run(
        thread.id,
        anchor.id,
        action,
        prompt,
        selection.blockType !== "text",
        selection.visual,
        "section",
        anchor.id,
      );
    } catch (e) {
      setError((e as Error).message);
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
  ) {
    const controller = new AbortController();
    aborter.current = controller;
    setRunning(threadId);
    if (!["tldr", "half-page", "visual-recap", "summarize"].includes(action))
      setActiveEntry({ type: "thread", id: threadId });
    await loadThreads();
    try {
      await stream(
        "/api/runs",
        {
          requestId: crypto.randomUUID(),
          documentVersionId: doc!.version_id,
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
          if (event === "route")
            setRouteInfo(
              `${data.providerId} · ${data.modelId} · ${data.contextTier} · ${data.enabledTools.length ? data.enabledTools.join(", ") : "no tools"}`,
            );
          if (event === "fallback")
            setRouteInfo(`Fallback: ${data.providerId} · ${data.modelId}`);
          if (event === "image_generation")
            setRouteInfo(`${data.modelId} · generating visual recap image…`);
          if (event === "image_generated")
            setRouteInfo(`${data.modelId} · visual recap image ready`);
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
      const [, loadedArtifacts] = await Promise.all([
        loadThreads(),
        loadArtifacts(),
      ]);
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
            item.scope_id === artifactScopeId,
        );
        if (artifact) setActiveEntry({ type: "artifact", id: artifact.id });
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setRunning(null);
      aborter.current = null;
    }
  }
  async function nestedAction(
    parentMessageId: string,
    text: string,
    action: "ask" | "compact" | "tldr" | "half-page" | "visual-recap" = "ask",
  ) {
    if (!doc) return;
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
        prompt,
        false,
        undefined,
        "answer",
        parentMessageId,
      );
    } catch (e) {
      setError((e as Error).message);
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
    const prompt = `Create a ${action} from this thread subtree.`;
    try {
      await api(`/api/threads/${thread.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ role: "user", content: prompt }),
      });
      await run(
        thread.id,
        thread.anchor_id ?? "",
        action,
        prompt,
        false,
        undefined,
        "thread",
        thread.id,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function documentAction(
    action: "tldr" | "half-page" | "visual-recap",
    regenerate = false,
  ) {
    if (!doc) return;
    try {
      const existingArtifact = artifacts.find(
        (artifact) =>
          artifact.kind === action &&
          artifact.scope_type === "document" &&
          artifact.scope_id === documentId,
      );
      if (existingArtifact && !regenerate) {
        setDrawer(true);
        setActiveEntry({ type: "artifact", id: existingArtifact.id });
        return;
      }
      const existingThread = threads.find(
        (thread) =>
          thread.action === action &&
          !thread.anchor_id &&
          !thread.parent_message_id,
      );
      const thread =
        existingThread ??
        (await api<{ id: string }>("/api/threads", {
          method: "POST",
          body: JSON.stringify({
            documentId,
            title: `${action} of ${doc.title}`,
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
        `Create a ${action} for this complete document.`,
        false,
        undefined,
        "document",
        documentId,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function replyToThread(thread: Thread, text: string) {
    const prompt = text.trim();
    if (!prompt || running) return;
    try {
      await api(`/api/threads/${thread.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ role: "user", content: prompt }),
      });
      await run(thread.id, thread.anchor_id ?? "", "ask", prompt);
    } catch (e) {
      setError((e as Error).message);
    }
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
      sessionStorage.removeItem("co-reader-repair-id");
      setRepairId("");
      setSelection(null);
      await Promise.all([loadThreads(), loadHighlights()]);
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
          documentVersionId: doc.version_id,
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
  }, [selection, doc?.version_id, modelOverride]);
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
          .find((v) => v.startsWith("co_reader_csrf="))
          ?.split("=")
          .slice(1)
          .join("=") ?? "",
      );
      const response = await fetch(`/api/documents/${documentId}/exports`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify({ format, fullTranscript }),
      });
      if (!response.ok) throw new Error((await response.json()).error);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(await response.blob());
      link.download = `${doc?.title ?? "co-reader"}.${format === "markdown" ? "md" : format}`;
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
  return (
    <main className={`reader-shell ${drawer ? "drawer-open" : ""}`}>
      <header className="reader-header">
        <button className="quiet" onClick={onBack}>
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
          <details className="summary-menu">
            <summary>Summaries</summary>
            <button onClick={() => documentAction("tldr")}>TL;DR</button>
            <button onClick={() => documentAction("half-page")}>
              Half-page
            </button>
            <button onClick={() => documentAction("visual-recap")}>
              Visual recap
            </button>
          </details>
          <details className="summary-menu">
            <summary>Export</summary>
            <button onClick={() => download("html")}>HTML</button>
            <button onClick={() => download("pdf")}>PDF</button>
            <button onClick={() => download("markdown")}>Markdown</button>
            <button onClick={() => download("html", true)}>
              HTML + full discussion
            </button>
          </details>
          <button
            className="quiet"
            onClick={() => setDrawer(!drawer)}
            aria-expanded={drawer}
          >
            Entries <b>{threads.length + artifacts.length}</b>
          </button>
        </div>
      </header>
      {error && (
        <div className="toast" role="alert">
          {error}
          <button onClick={() => setError("")}>×</button>
        </div>
      )}
      <div className="reader-grid">
        <section className="paper">
          <iframe
            ref={iframe}
            title={doc.title}
            src={`/api/versions/${doc.version_id}/content`}
            sandbox="allow-scripts"
          />
        </section>
        <aside className="margin" aria-label="Discussion margin">
          <nav className="entry-pane" aria-label="Reader entries">
            <h2>Entries</h2>
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
                  onClick={() =>
                    setActiveEntry({ type: "artifact", id: artifact.id })
                  }
                >
                  <span>{artifactLabel(artifact)}</span>
                  {artifact.promoted && <i>Pinned</i>}
                </button>
              ))}
            </section>
            <section>
              <h3>Discussions</h3>
              {threads.filter(
                (thread) =>
                  !["tldr", "half-page", "visual-recap", "summarize"].includes(
                    thread.action ?? "",
                  ),
              ).length === 0 && <small>None yet</small>}
              {threads
                .filter(
                  (thread) =>
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
                    onClick={() =>
                      setActiveEntry({ type: "thread", id: thread.id })
                    }
                  >
                    <span>{threadEntryLabel(thread)}</span>
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
                onPromote={() =>
                  promote(activeArtifact.id, !activeArtifact.promoted)
                }
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
              />
            )}
            {activeThread && (
              <ThreadCard
                thread={activeThread}
                running={running === activeThread.id}
                onAnchor={() =>
                  iframe.current?.contentWindow?.postMessage(
                    { type: "scroll-to-block", blockId: activeThread.block_id },
                    "*",
                  )
                }
                onNestedAction={nestedAction}
                onThreadAction={threadAction}
                onReply={replyToThread}
              />
            )}
            {!activeArtifact && !activeThread && (
              <p className="margin-empty">
                Choose an entry or select a passage in the article.
              </p>
            )}
          </section>
          {running && (
            <button className="cancel" onClick={() => aborter.current?.abort()}>
              Stop response
            </button>
          )}
        </aside>
      </div>
      {selection && (
        <div
          ref={toolbar}
          className="selection-tools"
          style={{
            top: Math.max(72, selection.rect.top + 92),
            left: Math.min(innerWidth - 620, Math.max(12, selection.rect.left)),
          }}
          role="toolbar"
          aria-label="Selection actions"
        >
          {repairId && (
            <button className="repair-action" onClick={repairAnchor}>
              Attach annotation here
            </button>
          )}
          <select
            aria-label="Model override"
            value={modelOverride}
            onChange={(e) => {
              setModelOverride(e.target.value);
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
          {!repairId &&
            (Object.keys(actionLabels) as Array<keyof typeof actionLabels>).map(
              (action) => (
                <button
                  key={action}
                  onPointerEnter={() => preview(action)}
                  onFocus={() => preview(action)}
                  onClick={() => act(action)}
                >
                  {actionLabels[action]}
                </button>
              ),
            )}
          <input
            aria-label="Question"
            placeholder="Ask about this…"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onFocus={() => preview("ask")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !repairId) act("ask");
            }}
          />
          <button
            className="close"
            onClick={() => setSelection(null)}
            aria-label="Close"
          >
            ×
          </button>
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
  const text = thread.exact_quote || thread.title || "Follow-up";
  return `${thread.action === "define" ? "Define · " : ""}${text}`;
}
function ArtifactCard({
  artifact,
  onPromote,
  onRegenerate,
}: {
  artifact: Artifact;
  onPromote: () => void;
  onRegenerate?: (() => void) | undefined;
}) {
  return (
    <article className="artifact-card">
      <header>
        <b>{artifact.kind}</b>
        <span>
          {onRegenerate && <button onClick={onRegenerate}>Regenerate</button>}
          <button onClick={onPromote}>
            {artifact.promoted ? "Unpin" : "Pin"}
          </button>
        </span>
      </header>
      {artifact.kind === "diagram" ? (
        <DiagramView spec={artifact.content} />
      ) : artifact.kind === "visual-recap" ? (
        <VisualRecap recap={artifact.content} />
      ) : (
        <p>{String(artifact.content)}</p>
      )}
      <small>Sources: {artifact.sourceRefs.join(", ")}</small>
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
        <p>{recap?.thesis}</p>
        {(recap?.sections ?? []).map((section: any, index: number) => (
          <section key={index}>
            <h4>{section.title}</h4>
            <p>{section.summary}</p>
          </section>
        ))}
        <h4>Takeaways</h4>
        <ul>
          {(recap?.takeaways ?? []).map((item: string, index: number) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}
function ThreadCard({
  thread,
  running,
  onAnchor,
  onNestedAction,
  onThreadAction,
  onReply,
}: {
  thread: Thread;
  running: boolean;
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
  onReply: (thread: Thread, text: string) => void;
}) {
  const [reply, setReply] = useState("");
  return (
    <article id={`thread-${thread.id}`} tabIndex={-1} className="thread-card">
      <button className="quote" onClick={onAnchor}>
        {thread.exact_quote || thread.title || "Follow-up"}
      </button>
      {thread.messages.map((message) => (
        <div key={message.id} className={`message ${message.role}`}>
          <span>{message.role === "assistant" ? "Co-reader" : "You"}</span>
          <div
            onMouseUp={() => {
              if (message.role !== "assistant" || message.id === "draft")
                return;
              const text = getSelection()?.toString().trim();
              if (
                text &&
                confirm(`Ask a nested follow-up about “${text.slice(0, 80)}”?`)
              )
                onNestedAction(message.id, text, "ask");
            }}
          >
            {message.content}
          </div>
          {message.role === "assistant" && message.id !== "draft" && (
            <div className="message-actions">
              <button
                onClick={() =>
                  onNestedAction(message.id, message.content, "compact")
                }
              >
                Compact
              </button>
              <button
                onClick={() =>
                  onNestedAction(message.id, message.content, "tldr")
                }
              >
                TL;DR
              </button>
              <button
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
        <button onClick={() => onThreadAction(thread, "compact")}>
          Compact
        </button>
        <button onClick={() => onThreadAction(thread, "half-page")}>
          Half-page
        </button>
        <button onClick={() => onThreadAction(thread, "visual-recap")}>
          Visual recap
        </button>
      </div>
      {running && <span className="thinking">Thinking…</span>}
      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (!reply.trim()) return;
          onReply(thread, reply);
          setReply("");
        }}
      >
        <input
          aria-label="Continue discussion"
          placeholder="Continue this discussion…"
          value={reply}
          onChange={(event) => setReply(event.target.value)}
          disabled={running}
        />
        <button disabled={running || !reply.trim()}>Send</button>
      </form>
    </article>
  );
}
