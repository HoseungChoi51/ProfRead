import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  WriterPanel,
  formatWriterProposalForClipboard,
  initialWriterChangeIds,
  writerChangeAfterText,
  writerChangeLabel,
  writerSourceIsAdded,
  type WriterProposal,
  type WriterWorkspace,
} from "./WriterPanel.js";

const proposal = (): WriterProposal => ({
  id: "proposal-1",
  threadId: "writer-1",
  modelRunId: "run-1",
  documentVersionId: "version-1",
  baseRevision: 4,
  baseHtmlHash: "a".repeat(64),
  sourceHash: "b".repeat(64),
  instruction: "Improve the introduction.",
  title: "A clearer opening",
  summary: "Tightens the opening paragraph using the selected answer.",
  changes: [
    {
      id: "change-1",
      operation: {
        type: "replace-text",
        blockId: "block-1",
        text: "A revised opening.",
      },
      rationale: "Makes the thesis explicit.",
      sourceKeys: ["source-1"],
      beforeText: "The old opening.",
      beforeTag: "p",
    },
    {
      id: "change-2",
      operation: {
        type: "insert-text-block",
        blockId: "block-1",
        position: "after",
        tag: "blockquote",
        text: "A supporting quotation.",
      },
      rationale: "Preserves the useful answer as context.",
      sourceKeys: ["source-1"],
      beforeText: "The old opening.",
      beforeTag: "p",
    },
  ],
  status: "draft",
  appliedRevision: null,
  appliedChangeIds: null,
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
  appliedAt: null,
  freshness: { status: "current", reasons: [] },
});

const workspace = (): WriterWorkspace => ({
  thread: {
    id: "writer-1",
    kind: "writer",
    title: "Document Writer",
    messages: [],
  },
  sources: [
    {
      id: "source-1",
      threadId: "writer-1",
      sourceType: "message",
      sourceId: "answer-1",
      label: "Answer · selected definition",
      anchorId: "anchor-1",
      snapshot: { text: "Definition" },
      snapshotHash: "c".repeat(64),
      createdAt: "2026-08-11T00:00:00.000Z",
    },
  ],
  proposals: [proposal()],
  currentDocumentVersionId: "version-1",
  currentRevision: 4,
});

describe("Document Writer panel", () => {
  it("describes proposal operations and selects every current draft by default", () => {
    const value = proposal();

    expect(writerChangeLabel(value.changes[0]!)).toBe("Replace text");
    expect(writerChangeLabel(value.changes[1]!)).toBe(
      "Insert BLOCKQUOTE after",
    );
    expect(writerChangeAfterText(value.changes[1]!)).toBe(
      "A supporting quotation.",
    );
    expect(initialWriterChangeIds(value)).toEqual(["change-1", "change-2"]);
    expect(
      initialWriterChangeIds({
        ...value,
        freshness: { status: "stale", reasons: ["document-edits-changed"] },
      }),
    ).toEqual([]);
  });

  it("formats a complete proposal for manual copy and recognizes basket items", () => {
    const value = proposal();
    const copied = formatWriterProposalForClipboard(value);

    expect(copied).toContain("A clearer opening");
    expect(copied).toContain("Before: The old opening.");
    expect(copied).toContain("After: A revised opening.");
    expect(
      writerSourceIsAdded(workspace().sources, "message", "answer-1"),
    ).toBe(true);
    expect(
      writerSourceIsAdded(workspace().sources, "highlight", "answer-1"),
    ).toBe(false);
  });

  it("renders the immutable source basket, instruction, model, and reviewable changes", () => {
    const html = renderToStaticMarkup(
      <WriterPanel
        workspace={workspace()}
        models={[
          { id: "writer-model", label: "Writer model", ready: true },
        ]}
        instruction="Improve the introduction."
        modelOverride=""
        busy={false}
        onInstructionChange={() => {}}
        onModelOverrideChange={() => {}}
        onRemoveSource={async () => true}
        onGenerate={async () => true}
        onApply={async () => true}
        onDismiss={async () => true}
        onCopy={async () => {}}
      />,
    );

    expect(html).toContain("Document Writer");
    expect(html).toContain("Answer · selected definition");
    expect(html).toContain("Generate proposal");
    expect(html).toContain("A clearer opening");
    expect(html).toContain("Before / after");
    expect(html).toContain("Apply selected");
  });
});
