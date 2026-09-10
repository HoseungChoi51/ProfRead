import { useEffect, useMemo, useState } from "react";
import type {
  WriterProposalChange,
  WriterProposalResult,
  WriterSourceType,
} from "@profread/shared";

export type WriterMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export type WriterSource = {
  id: string;
  threadId: string;
  sourceType: WriterSourceType;
  sourceId: string;
  label: string;
  anchorId: string | null;
  snapshot: unknown;
  snapshotHash?: string;
  createdAt: string;
};

export type WriterProposal = WriterProposalResult & {
  freshness: { status: "current" | "stale"; reasons: string[] };
};

export type WriterWorkspace = {
  thread: {
    id: string;
    kind: "writer";
    title?: string | null;
    messages: WriterMessage[];
  };
  sources: WriterSource[];
  proposals: WriterProposal[];
  currentDocumentVersionId: string;
  currentRevision: number;
};

export type WriterModelOption = {
  id: string;
  label: string;
  ready?: boolean;
};

export function writerChangeLabel(change: WriterProposalChange): string {
  if (change.operation.type === "replace-text") return "Replace text";
  if (change.operation.type === "delete-text-block") return "Delete block";
  return `Insert ${change.operation.tag.toUpperCase()} ${change.operation.position}`;
}

export function writerChangeAfterText(change: WriterProposalChange): string {
  return change.operation.type === "delete-text-block"
    ? "(block removed)"
    : change.operation.text;
}

export function initialWriterChangeIds(proposal: WriterProposal): string[] {
  return proposal.status === "draft" &&
    proposal.freshness.status === "current"
    ? proposal.changes.map((change) => change.id)
    : [];
}

export function formatWriterProposalForClipboard(
  proposal: WriterProposal,
): string {
  const changes = proposal.changes
    .map(
      (change, index) =>
        `${index + 1}. ${writerChangeLabel(change)}\nBefore: ${change.beforeText ?? "(new block)"}\nAfter: ${writerChangeAfterText(change)}\nWhy: ${change.rationale}`,
    )
    .join("\n\n");
  return `${proposal.title}\n\n${proposal.summary}\n\n${changes}`;
}

export function writerSourceIsAdded(
  sources: WriterSource[],
  sourceType: WriterSourceType,
  sourceId: string,
): boolean {
  return sources.some(
    (source) =>
      source.sourceType === sourceType && source.sourceId === sourceId,
  );
}

export function WriterPanel({
  workspace,
  models,
  instruction,
  modelOverride,
  busy,
  onInstructionChange,
  onModelOverrideChange,
  onRemoveSource,
  onGenerate,
  onApply,
  onDismiss,
  onCopy,
  onBackToEntries,
}: {
  workspace: WriterWorkspace;
  models: WriterModelOption[];
  instruction: string;
  modelOverride: string;
  busy: boolean;
  onInstructionChange: (value: string) => void;
  onModelOverrideChange: (value: string) => void;
  onRemoveSource: (sourceId: string) => Promise<boolean>;
  onGenerate: (instruction: string) => Promise<boolean>;
  onApply: (
    proposalId: string,
    changeIds: string[],
    baseRevision: number,
  ) => Promise<boolean>;
  onDismiss: (proposalId: string) => Promise<boolean>;
  onCopy: (text: string) => Promise<void>;
  onBackToEntries?: (() => void) | undefined;
}) {
  const proposals = useMemo(
    () =>
      [...workspace.proposals].sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      ),
    [workspace.proposals],
  );
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [workingId, setWorkingId] = useState("");
  const [copiedId, setCopiedId] = useState("");
  useEffect(() => {
    setSelected((current) => {
      const next = { ...current };
      for (const proposal of proposals)
        if (!(proposal.id in next))
          next[proposal.id] = initialWriterChangeIds(proposal);
      return next;
    });
  }, [proposals]);

  return (
    <article className="writer-panel">
      <header className="writer-panel-header">
        <div>
          {onBackToEntries && (
            <button
              className="quiet writer-back-button"
              onClick={onBackToEntries}
            >
              ← Entries
            </button>
          )}
          <h2>Document Writer</h2>
          <small>
            Proposes reviewable edits to the complete article. Nothing changes
            until you apply selected items.
          </small>
        </div>
        <span>Revision {workspace.currentRevision}</span>
      </header>

      <section className="writer-sources" aria-label="Writer sources">
        <header>
          <h3>Reference basket</h3>
          <small>{workspace.sources.length} immutable snapshot(s)</small>
        </header>
        {workspace.sources.length === 0 ? (
          <p>
            Add an answer, saved annotation, highlight, or artifact from its
            entry card.
          </p>
        ) : (
          <ul>
            {workspace.sources.map((source) => (
              <li key={source.id}>
                <div>
                  <span>{source.label}</span>
                  <small>{source.sourceType}</small>
                </div>
                <button
                  className="danger-link"
                  disabled={busy || workingId === source.id}
                  onClick={async () => {
                    setWorkingId(source.id);
                    await onRemoveSource(source.id);
                    setWorkingId("");
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form
        className="writer-composer"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!instruction.trim() || busy) return;
          setWorkingId("generate");
          await onGenerate(instruction);
          setWorkingId("");
        }}
      >
        <label>
          Writing instruction
          <textarea
            maxLength={20_000}
            value={instruction}
            placeholder="For example: weave the selected definition into the introduction and tighten the transition."
            disabled={busy}
            onChange={(event) => onInstructionChange(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.nativeEvent.isComposing &&
                (event.metaKey || event.ctrlKey)
              ) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
        </label>
        <div>
          <select
            aria-label="Document Writer model"
            value={modelOverride}
            disabled={busy}
            onChange={(event) => onModelOverrideChange(event.target.value)}
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
          <button
            className="primary"
            disabled={busy || !instruction.trim()}
          >
            {workingId === "generate" ? "Generating…" : "Generate proposal"}
          </button>
        </div>
        <small>Ctrl/Cmd + Enter generates. The instruction stays for retry.</small>
      </form>

      <section className="writer-proposals" aria-label="Writer proposals">
        <header>
          <h3>Proposals</h3>
          <small>{proposals.length || "No"} saved</small>
        </header>
        {proposals.length === 0 && (
          <p className="writer-empty">
            Give the Writer an instruction to create a structured proposal.
          </p>
        )}
        {proposals.map((proposal) => {
          const canApply =
            proposal.status === "draft" &&
            proposal.freshness.status === "current";
          const selectedIds = selected[proposal.id] ?? [];
          return (
            <article
              key={proposal.id}
              className={`writer-proposal proposal-${proposal.status}`}
            >
              <header>
                <div>
                  <h3>{proposal.title}</h3>
                  <small>
                    {proposal.status} · {proposal.changes.length} change
                    {proposal.changes.length === 1 ? "" : "s"}
                  </small>
                </div>
                <span
                  className={
                    proposal.freshness.status === "current"
                      ? "writer-current"
                      : "writer-stale"
                  }
                >
                  {proposal.freshness.status === "current"
                    ? "Current"
                    : "Stale"}
                </span>
              </header>
              <p>{proposal.summary}</p>
              {proposal.freshness.reasons.length > 0 && (
                <div className="writer-stale-note" role="status">
                  Regenerate before applying:{" "}
                  {proposal.freshness.reasons.join(" · ")}
                </div>
              )}
              <div className="writer-change-list">
                {proposal.changes.map((change) => {
                  const checked = selectedIds.includes(change.id);
                  return (
                    <label key={change.id} className="writer-change">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!canApply || busy}
                        onChange={(event) =>
                          setSelected((current) => {
                            const prior = current[proposal.id] ?? [];
                            return {
                              ...current,
                              [proposal.id]: event.target.checked
                                ? [...new Set([...prior, change.id])]
                                : prior.filter((id) => id !== change.id),
                            };
                          })
                        }
                      />
                      <div>
                        <b>{writerChangeLabel(change)}</b>
                        <small>{change.rationale}</small>
                        {change.sourceKeys.length > 0 && (
                          <small>
                            Sources:{" "}
                            {change.sourceKeys
                              .map(
                                (key) =>
                                  workspace.sources.find(
                                    (source) => source.id === key,
                                  )?.label ?? key,
                              )
                              .join(" · ")}
                          </small>
                        )}
                        <details>
                          <summary>Before / after</summary>
                          <div className="writer-diff">
                            <pre>{change.beforeText ?? "(new block)"}</pre>
                            <pre>{writerChangeAfterText(change)}</pre>
                          </div>
                        </details>
                      </div>
                    </label>
                  );
                })}
              </div>
              <footer>
                <button
                  disabled={busy}
                  onClick={async () => {
                    try {
                      await onCopy(formatWriterProposalForClipboard(proposal));
                      setCopiedId(proposal.id);
                    } catch {
                      setCopiedId("");
                    }
                  }}
                >
                  {copiedId === proposal.id ? "Copied" : "Copy"}
                </button>
                {proposal.status === "draft" && (
                  <button
                    className="danger-link"
                    disabled={busy || workingId === proposal.id}
                    onClick={async () => {
                      setWorkingId(proposal.id);
                      await onDismiss(proposal.id);
                      setWorkingId("");
                    }}
                  >
                    Dismiss
                  </button>
                )}
                <button
                  disabled={busy}
                  onClick={() => {
                    onInstructionChange(proposal.instruction);
                    void onGenerate(proposal.instruction);
                  }}
                >
                  Regenerate
                </button>
                {canApply && (
                  <button
                    className="primary"
                    disabled={busy || selectedIds.length === 0}
                    onClick={async () => {
                      setWorkingId(proposal.id);
                      await onApply(
                        proposal.id,
                        selectedIds,
                        proposal.baseRevision,
                      );
                      setWorkingId("");
                    }}
                  >
                    {workingId === proposal.id
                      ? "Applying…"
                      : `Apply selected (${selectedIds.length})`}
                  </button>
                )}
              </footer>
            </article>
          );
        })}
      </section>

      {workspace.thread.messages.length > 0 && (
        <details className="writer-history">
          <summary>Writer history ({workspace.thread.messages.length})</summary>
          {workspace.thread.messages.map((message) => (
            <div key={message.id}>
              <b>{message.role === "assistant" ? "Writer" : "You"}</b>
              <p>{message.content}</p>
            </div>
          ))}
        </details>
      )}
    </article>
  );
}
