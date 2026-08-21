import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  academicObjectEditOperations,
  ArtifactCard,
  availableSelectionActions,
  captionEditOperation,
  clearThreadReplyRetry,
  copyTextToClipboard,
  deriveThreadPreview,
  HighlightCard,
  limitUnicodeCodePoints,
  MarkdownContent,
  normalizeMarkdownMath,
  moveObjectOperation,
  normalizeThreadPreview,
  openReaderExternalLink,
  placeSelectionPopover,
  releaseLock,
  relativeSelectionGeometryKey,
  rememberThreadReplyRetry,
  retryRequestId,
  shouldSubmitComposerKey,
  shouldKeepPopoverPlacement,
  safeReaderExternalUrl,
  sidebarSourceNavigationPayload,
  summaryReviewRequestIdentity,
  threadAnnotationCandidate,
  threadReplyRetryRequestId,
  ThreadCard,
  translateIframeRect,
  tryAcquireLock,
  writerRequestIdentity,
} from "./Reader.js";

describe("sidebar source navigation", () => {
  it("targets the selected repeated-word occurrence with local offsets", () => {
    expect(
      sidebarSourceNavigationPayload({
        anchor_id: "anchor-2",
        block_id: "block-1",
        block_type: "text",
        exact_quote: "same",
        status: "attached",
        local_start_offset: 25,
        local_end_offset: 29,
      }),
    ).toEqual({
      type: "reveal-selection",
      blockId: "block-1",
      startOffset: 25,
      endOffset: 29,
    });
  });

  it("does not navigate unmatched, anchorless, incomplete, or invalid sources", () => {
    const valid = {
      anchor_id: "anchor-1",
      block_id: "block-1",
      block_type: "text",
      exact_quote: "word",
      status: "attached" as const,
      local_start_offset: 5,
      local_end_offset: 9,
    };
    expect(
      sidebarSourceNavigationPayload({ ...valid, status: "unmatched" }),
    ).toBeNull();
    expect(
      sidebarSourceNavigationPayload({ ...valid, anchor_id: null }),
    ).toBeNull();
    expect(
      sidebarSourceNavigationPayload({ ...valid, block_id: null }),
    ).toBeNull();
    expect(
      sidebarSourceNavigationPayload({
        ...valid,
        local_start_offset: null,
      }),
    ).toBeNull();
    expect(
      sidebarSourceNavigationPayload({ ...valid, local_start_offset: -1 }),
    ).toBeNull();
    expect(
      sidebarSourceNavigationPayload({ ...valid, local_start_offset: 5.5 }),
    ).toBeNull();
    expect(
      sidebarSourceNavigationPayload({ ...valid, local_end_offset: 4 }),
    ).toBeNull();
    expect(
      sidebarSourceNavigationPayload({ ...valid, local_end_offset: 8 }),
    ).toBeNull();
  });

  it("allows a visual source at the block's zero-width anchor", () => {
    expect(
      sidebarSourceNavigationPayload({
        anchor_id: "visual-anchor",
        block_id: "figure-1",
        block_type: "image",
        exact_quote: "",
        status: "attached",
        local_start_offset: 0,
        local_end_offset: 0,
      }),
    ).toEqual({
      type: "reveal-selection",
      blockId: "figure-1",
      startOffset: 0,
      endOffset: 0,
    });
  });
});

describe("selection popover geometry", () => {
  const pane = { top: 64, left: 24, width: 800, height: 620 };
  const popover = { width: 300, height: 64 };

  it("translates iframe viewport coordinates into window coordinates", () => {
    expect(
      translateIframeRect(
        { top: 40, left: 70, width: 160, height: 42 },
        { top: 84, left: 32 },
      ),
    ).toEqual({ top: 124, left: 102, width: 160, height: 42 });
  });

  it("distinguishes real selection movement from dock-induced iframe movement", () => {
    const beforeDock = relativeSelectionGeometryKey(
      { top: 180, left: 120, width: 160, height: 42 },
      { top: 80, left: 20 },
    );
    const afterTopDock = relativeSelectionGeometryKey(
      { top: 230, left: 120, width: 160, height: 42 },
      { top: 130, left: 20 },
    );
    const afterScroll = relativeSelectionGeometryKey(
      { top: 250, left: 120, width: 160, height: 42 },
      { top: 130, left: 20 },
    );

    expect(afterTopDock).toBe(beforeDock);
    expect(afterScroll).not.toBe(beforeDock);
  });

  it("keeps dock feedback stable but reevaluates external geometry changes", () => {
    expect(
      shouldKeepPopoverPlacement("dock", "same", "same", "observer"),
    ).toBe(true);
    expect(
      shouldKeepPopoverPlacement("dock", "same", "same", "geometry"),
    ).toBe(true);
    expect(
      shouldKeepPopoverPlacement("dock", "old", "new", "geometry"),
    ).toBe(false);
    expect(
      shouldKeepPopoverPlacement("dock", "same", "same", "external"),
    ).toBe(false);
  });

  it("places the popover above a complete multiline selection", () => {
    const selection = { top: 310, left: 260, width: 180, height: 96 };
    const result = placeSelectionPopover(selection, popover, pane);

    expect(result.side).toBe("above");
    expect(result.mode).toBe("overlay");
    expect(result.top + popover.height).toBeLessThanOrEqual(
      selection.top - 12,
    );
  });

  it("places the popover below a selection near the top edge", () => {
    const selection = { top: 76, left: 120, width: 120, height: 32 };
    const result = placeSelectionPopover(selection, popover, pane);

    expect(result).toMatchObject({ side: "below", top: 120 });
  });

  it("clamps the popover horizontally inside the article pane", () => {
    const result = placeSelectionPopover(
      { top: 300, left: 790, width: 30, height: 24 },
      popover,
      pane,
    );

    expect(result.left).toBe(516);
    expect(result.left + popover.width).toBeLessThanOrEqual(816);
  });

  it("reserves a dock at the farthest article edge when overlay would intersect", () => {
    const result = placeSelectionPopover(
      { top: 84, left: 220, width: 180, height: 510 },
      { width: 280, height: 120 },
      pane,
    );

    expect(result).toMatchObject({ side: "bottom-dock", mode: "dock" });
    expect(result.mode === "overlay").toBe(false);
  });

  it("never intersects a multiline selection when above or below fits", () => {
    const selection = { top: 240, left: 90, width: 520, height: 170 };
    const result = placeSelectionPopover(
      selection,
      { width: 420, height: 72 },
      pane,
    );
    const popoverBottom = result.top + 72;
    const selectionBottom = selection.top + selection.height;

    expect(
      popoverBottom <= selection.top - 12 ||
        result.top >= selectionBottom + 12,
    ).toBe(true);
  });
});

describe("MarkdownContent", () => {
  it("renders dollar and TeX-delimited inline and display math", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent
        content={String.raw`Inline \(E=mc^2\) and $\alpha+\beta$.

\[
\int_0^1 x^2\,dx = \frac{1}{3}
\]

$$
a^2+b^2=c^2
$$`}
      />,
    );

    expect((html.match(/class="katex-display"/g) ?? [])).toHaveLength(2);
    expect(html).toContain('class="katex"');
    expect(html).toContain("<math");
    expect(html).toContain("<mfrac>");
    expect(html).not.toContain("\\(");
    expect(html).not.toContain("\\[");
  });

  it("leaves TeX delimiters inside inline and fenced code unchanged", () => {
    const fencedExample = [
      String.raw`Render \(x^2\).`,
      "",
      "Inline code: `\\(not math\\)`.",
      "",
      "~~~tex",
      "\\[",
      "\\notMath",
      "\\]",
      "~~~",
    ].join("\n");

    const normalized = normalizeMarkdownMath(fencedExample);
    expect(normalized).toContain("Render $x^2$.");
    expect(normalized).toContain("`\\(not math\\)`");
    expect(normalized).toContain(
      ["~~~tex", "\\[", "\\notMath", "\\]", "~~~"].join("\n"),
    );

    const html = renderToStaticMarkup(
      <MarkdownContent content={fencedExample} />,
    );
    expect((html.match(/class="katex"/g) ?? [])).toHaveLength(1);
    expect(html).toContain('class="language-tex"');
  });

  it("preserves indented and container-nested CommonMark code", () => {
    const codeExamples = [
      "    \\[",
      "    \\notMath",
      "    \\]",
      "",
      "> ~~~tex",
      "> \\(not math\\)",
      "> ~~~",
      "",
      "- ~~~tex",
      "  \\[",
      "  \\notMath",
      "  \\]",
      "  ~~~",
      "",
      String.raw`Render \(y\).`,
    ].join("\n");

    const normalized = normalizeMarkdownMath(codeExamples);
    expect(normalized).toContain(
      ["    \\[", "    \\notMath", "    \\]"].join("\n"),
    );
    expect(normalized).toContain(
      ["> ~~~tex", "> \\(not math\\)", "> ~~~"].join("\n"),
    );
    expect(normalized).toContain(
      [
        "- ~~~tex",
        "  \\[",
        "  \\notMath",
        "  \\]",
        "  ~~~",
      ].join("\n"),
    );
    expect(normalized).toContain("Render $y$.");

    const html = renderToStaticMarkup(
      <MarkdownContent content={codeExamples} />,
    );
    expect((html.match(/class="katex"/g) ?? [])).toHaveLength(1);
  });

  it("shows malformed or untrusted TeX without creating unsafe links", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent
        content={String.raw`Malformed $\frac{1$ and untrusted $\href{https://example.invalid}{bad}$.`}
      />,
    );

    expect(html).toContain("katex-error");
    expect(html).not.toMatch(/<a(?:\s|>)/);
  });

  it("renders model Markdown while ignoring raw HTML and remote images", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent
        content={`**Bold answer** with *emphasis* and [a source](https://example.com).

| Item | Value |
| --- | --- |
| One | Two |

<script>alert("unsafe")</script>

![remote diagram](https://example.com/image.png)`}
      />,
    );

    expect(html).toContain("<strong>Bold answer</strong>");
    expect(html).toContain("<em>emphasis</em>");
    expect(html).toContain("<table>");
    expect(html).toContain('target="_blank"');
    expect(html).toContain("[Image: remote diagram]");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
  });
});

describe("copyTextToClipboard", () => {
  it("writes the exact selected text with the Clipboard API", async () => {
    const writes: string[] = [];
    await copyTextToClipboard(
      "Exact selected passage",
      { writeText: async (text) => { writes.push(text); } },
      () => false,
    );
    expect(writes).toEqual(["Exact selected passage"]);
  });

  it("falls back when Clipboard API permission is denied", async () => {
    let fallbackText = "";
    await copyTextToClipboard(
      "Fallback passage",
      { writeText: async () => { throw new Error("denied"); } },
      (text) => { fallbackText = text; return true; },
    );
    expect(fallbackText).toBe("Fallback passage");
  });
});

describe("academic object edit controls", () => {
  const current = {
    blockId: "figure-1",
    altBlockId: "image-1",
    altText: "Old description",
    width: "auto" as const,
    alignment: "center" as const,
    enlargeable: false,
    folded: false,
  };

  it("queues only changed alt-text and layout fields", () => {
    expect(
      academicObjectEditOperations(current, {
        altText: "  New accessible description  ",
        width: "full",
        alignment: "right",
        enlargeable: true,
        folded: true,
      }),
    ).toEqual([
      {
        type: "set-alt-text",
        blockId: "image-1",
        text: "New accessible description",
      },
      {
        type: "set-object-layout",
        blockId: "figure-1",
        width: "full",
        alignment: "right",
        enlargeable: true,
        folded: true,
      },
    ]);
    expect(
      academicObjectEditOperations(current, {
        altText: " Old description ",
        width: "auto",
        alignment: "center",
        enlargeable: false,
        folded: false,
      }),
    ).toEqual([]);
  });

  it("requires distinct source and destination blocks for moves", () => {
    expect(moveObjectOperation("figure-1", "figure-1", "after")).toBeNull();
    expect(moveObjectOperation("figure-1", "paragraph-2", "before")).toEqual({
      type: "move-object",
      blockId: "figure-1",
      destinationBlockId: "paragraph-2",
      position: "before",
    });
  });

  it("keeps a structured caption body read-only while relabeling it", () => {
    expect(
      captionEditOperation(
        {
          blockId: "figure-1",
          label: "Figure",
          number: "1",
          caption: "x response source",
          structured: true,
        },
        {
          label: " Diagram ",
          number: " 7 ",
          caption: "flattened replacement",
        },
      ),
    ).toEqual({
      type: "set-caption",
      blockId: "figure-1",
      label: "Diagram",
      number: "7",
      caption: "x response source",
    });
  });

  it("allows plain caption body edits", () => {
    expect(
      captionEditOperation(
        {
          blockId: "figure-1",
          label: "Figure",
          number: "1",
          caption: "Old body",
          structured: false,
        },
        { label: "Figure", number: "2", caption: " Revised body " },
      ),
    ).toMatchObject({ number: "2", caption: "Revised body" });
  });
});

describe("sandboxed Reader external links", () => {
  it("allows only normalized HTTPS and mail links", () => {
    expect(safeReaderExternalUrl("https://example.com/paper?q=1")).toBe(
      "https://example.com/paper?q=1",
    );
    expect(safeReaderExternalUrl("mailto:reader@example.com?subject=Paper")).toBe(
      "mailto:reader@example.com?subject=Paper",
    );
    expect(safeReaderExternalUrl("http://example.com")).toBeNull();
    expect(safeReaderExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeReaderExternalUrl("#references")).toBeNull();
    expect(safeReaderExternalUrl("mailto:a@example.com?subject=x%0ABcc:y@example.com")).toBeNull();
  });

  it("opens validated links without an opener and ignores unsafe input", () => {
    const calls: string[][] = [];
    const opener = (url: string, target: string, features: string) => {
      calls.push([url, target, features]);
    };
    expect(openReaderExternalLink("https://example.com/source", opener)).toBe(true);
    expect(openReaderExternalLink("data:text/html,unsafe", opener)).toBe(false);
    expect(calls).toEqual([
      ["https://example.com/source", "_blank", "noopener,noreferrer"],
    ]);
  });
});

describe("v0.2 Reader policies and cards", () => {
  it("offers semantic highlights only for selected read-mode text", () => {
    expect(availableSelectionActions(false, true)).toContain("highlight");
    expect(availableSelectionActions(true, true)).not.toContain("highlight");
    expect(availableSelectionActions(false, false)).not.toContain("highlight");
    expect(availableSelectionActions(true, true)).toContain("ask");
  });

  it("reuses request IDs after ambiguous disconnects and rotates terminal failures", () => {
    expect(retryRequestId("request-1", false, () => "request-2")).toBe(
      "request-1",
    );
    expect(retryRequestId("request-1", true, () => "request-2")).toBe(
      "request-2",
    );
  });

  it("keeps ambiguous reply retries isolated by thread and prompt", () => {
    let retries = rememberThreadReplyRetry(
      new Map(),
      "thread-a",
      "same prompt",
      "request-a",
    );
    retries = rememberThreadReplyRetry(
      retries,
      "thread-b",
      "same prompt",
      "request-b",
    );
    retries = rememberThreadReplyRetry(
      retries,
      "thread-a",
      "different prompt",
      "request-a-2",
    );
    retries = clearThreadReplyRetry(retries, "thread-b", "same prompt");

    expect(
      threadReplyRetryRequestId(retries, "thread-a", "same prompt"),
    ).toBe("request-a");
    expect(
      threadReplyRetryRequestId(retries, "thread-a", "different prompt"),
    ).toBe("request-a-2");
    expect(
      threadReplyRetryRequestId(retries, "thread-b", "same prompt"),
    ).toBeUndefined();
  });

  it("does not submit Ask or highlight shortcuts during IME composition", () => {
    const composingEnter = {
      key: "Enter",
      isComposing: true,
      metaKey: false,
      ctrlKey: false,
    };
    const plainEnter = { ...composingEnter, isComposing: false };
    const controlEnter = { ...plainEnter, ctrlKey: true };

    expect(shouldSubmitComposerKey(composingEnter)).toBe(false);
    expect(shouldSubmitComposerKey(plainEnter)).toBe(true);
    expect(shouldSubmitComposerKey(plainEnter, true)).toBe(false);
    expect(shouldSubmitComposerKey(controlEnter, true)).toBe(true);
  });

  it("acquires edit-save locks synchronously and releases them for retry", () => {
    const lock = { current: false };

    expect(tryAcquireLock(lock)).toBe(true);
    expect(tryAcquireLock(lock)).toBe(false);
    releaseLock(lock);
    expect(tryAcquireLock(lock)).toBe(true);
  });

  it("reuses retries only for the same model and exact Writer/review basis", () => {
    const writer = {
      instruction: "Revise the opening.",
      modelOverride: "",
      documentVersionId: "version-1",
      revision: 2,
      sources: [{ id: "source-1", snapshotHash: "hash-1" }],
    };
    expect(
      writerRequestIdentity({
        ...writer,
        sources: [...writer.sources].reverse(),
      }),
    ).toBe(writerRequestIdentity(writer));
    expect(
      writerRequestIdentity({ ...writer, modelOverride: "another-model" }),
    ).not.toBe(writerRequestIdentity(writer));
    expect(
      writerRequestIdentity({
        ...writer,
        sources: [{ id: "source-1", snapshotHash: "changed" }],
      }),
    ).not.toBe(writerRequestIdentity(writer));

    const review = {
      artifactId: "artifact-1",
      artifactVersion: 3,
      documentVersionId: "version-1",
      revision: 2,
      modelOverride: "",
      signals: [
        {
          id: "important-1",
          kind: "important" as const,
          exactQuote: "Priority",
          note: null,
        },
        {
          id: "question-1",
          kind: "question" as const,
          exactQuote: "Open?",
          note: null,
        },
      ],
    };
    expect(
      summaryReviewRequestIdentity({
        ...review,
        signals: review.signals.map((signal) =>
          signal.id === "question-1"
            ? { ...signal, exactQuote: "Changed open question?" }
            : signal,
        ),
      }),
    ).toBe(summaryReviewRequestIdentity(review));
    expect(
      summaryReviewRequestIdentity({
        ...review,
        revision: 3,
      }),
    ).not.toBe(summaryReviewRequestIdentity(review));
    expect(
      summaryReviewRequestIdentity({
        ...review,
        signals: review.signals.map((signal) =>
          signal.id === "important-1"
            ? { ...signal, note: "New reader priority" }
            : signal,
        ),
      }),
    ).not.toBe(summaryReviewRequestIdentity(review));
  });

  it("renders deterministic summary freshness controls", () => {
    const html = renderToStaticMarkup(
      <ArtifactCard
        artifact={{
          id: "artifact-1",
          kind: "tldr",
          version: 3,
          content: "Existing summary",
          sourceRefs: ["version-1"],
          promoted: false,
          scope_type: "document",
          scope_id: "document-1",
          freshness: {
            status: "needs-review",
            reasons: ["reader-signals-changed"],
          },
          latestReview: {
            id: "review-1",
            status: "applied",
            decision: "KEEP",
            rationale: "The existing summary already covers the new signal.",
            sourceStatus: "adequate",
            modelId: "gpt-test",
            artifactVersion: 2,
            basis: {
              documentVersionId: "version-1",
              revision: 4,
              signalHash: "signal-hash",
            },
            createdAt: "2026-08-11T00:00:00.000Z",
            appliedAt: "2026-08-11T00:01:00.000Z",
          },
        }}
        busy={false}
        models={[
          {
            id: "gpt-test",
            label: "Test model",
            providerId: "openai",
            ready: true,
          },
        ]}
        onPromote={() => {}}
        onRegenerate={() => {}}
        onAcceptCurrent={() => {}}
        onReview={() => {}}
        onReviewModelChange={() => {}}
        onDelete={() => {}}
      />,
    );

    expect(html).toContain("Review recommended");
    expect(html).toContain("important highlights or comments changed");
    expect(html).toContain("Keep current");
    expect(html).toContain("Regenerate");
    expect(html).toContain("Review changes");
    expect(html).toContain("Remove");
    expect(html).toContain("Automatic model");
    expect(html).toContain("The existing summary already covers");
  });

  it("renders semantic highlight editing and curated thread annotations", () => {
    const highlight = renderToStaticMarkup(
      <HighlightCard
        highlight={{
          id: "highlight-1",
          anchor_id: "anchor-1",
          block_id: "block-1",
          exact_quote: "A disputed passage",
          checked: 0,
          local_start_offset: 3,
          local_end_offset: 22,
          kind: "comment",
          color: "pink",
          note: "Reader perspective",
        }}
        onAnchor={() => {}}
        onSave={async () => true}
        onDelete={async () => true}
      />,
    );
    const thread = renderToStaticMarkup(
      <ThreadCard
        thread={{
          id: "thread-1",
          document_id: "document-1",
          anchor_id: "anchor-1",
          exact_quote: "Defined term",
          annotation_text: "A concise saved annotation.",
          messages: [
            {
              id: "answer-1",
              role: "assistant",
              content: "A detailed answer with \\(E=mc^2\\).",
              createdAt: "2026-08-11T00:00:00.000Z",
            },
          ],
        }}
        running={false}
        busy={false}
        onAnchor={() => {}}
        onNestedAction={() => {}}
        onThreadAction={() => {}}
        onReply={async () => true}
        replyDraft=""
        onReplyDraftChange={() => {}}
        annotationDraft="A concise saved annotation."
        onAnnotationDraftChange={() => {}}
        onSaveAnnotation={async () => true}
        onDismissAnnotationCandidate={async () => true}
        onPolishAnnotation={async () => true}
        onAddAnnotationToWriter={() => {}}
        onAddMessageToWriter={() => {}}
        onCopy={async () => {}}
      />,
    );

    expect(highlight).toContain("Reader perspective");
    expect(highlight).toContain("Comments influence summaries");
    expect(thread).toContain("Article annotation");
    expect(thread).toContain("Polish with AI");
    expect(thread).toContain("Copy answer");
    expect(thread).toContain('class="katex"');
  });
});

describe("anchored thread previews", () => {
  const thread = (): Parameters<typeof deriveThreadPreview>[0] => ({
    id: "thread-1",
    document_id: "document-1",
    annotation_text: null,
    messages: [
      {
        id: "answer-1",
        role: "assistant",
        content: "Older completed answer",
        createdAt: "2026-08-11T00:00:00.000Z",
      },
      {
        id: "answer-2",
        role: "assistant",
        content: "Newest completed answer",
        createdAt: "2026-08-11T01:00:00.000Z",
      },
      {
        id: "draft",
        role: "assistant",
        content: "Unfinished streaming answer",
        createdAt: "2026-08-11T04:00:00.000Z",
      },
    ],
  });
  const compact = (
    overrides: Partial<Parameters<typeof deriveThreadPreview>[1][number]>,
  ): Parameters<typeof deriveThreadPreview>[1][number] => ({
    id: "compact-1",
    kind: "compact",
    version: 1,
    content: "Compact note",
    sourceRefs: ["answer-1"],
    promoted: false,
    scope_type: "thread",
    scope_id: "thread-1",
    created_at: "2026-08-11T02:00:00.000Z",
    ...overrides,
  });

  it("uses the saved annotation before every generated source", () => {
    const result = deriveThreadPreview(
      { ...thread(), annotation_text: "  **Curated**   reader note.  " },
      [compact({ content: "Newer generated note" })],
    );

    expect(result).toEqual({ text: "Curated reader note.", source: "annotation" });
  });

  it("uses only pending unsaved annotation candidates ahead of generated notes", () => {
    const pending = {
      ...thread(),
      annotation_candidate_text: "Suggested from the completed answer.",
      annotation_candidate_status: "pending" as const,
    };

    expect(threadAnnotationCandidate(pending)).toBe(
      "Suggested from the completed answer.",
    );
    expect(deriveThreadPreview(pending, [compact({})])).toEqual({
      text: "Suggested from the completed answer.",
      source: "candidate",
    });
    expect(
      deriveThreadPreview(
        { ...pending, annotation_candidate_status: "dismissed" },
        [compact({})],
      ),
    ).toEqual({ text: "Compact note", source: "thread-compact" });
  });

  it("limits annotation drafts by Unicode code point rather than UTF-16 unit", () => {
    expect(limitUnicodeCodePoints("🙂".repeat(500), 500)).toHaveLength(1000);
    expect(Array.from(limitUnicodeCodePoints("🙂".repeat(501), 500))).toHaveLength(
      500,
    );
  });

  it("chooses the newest compact note applicable to the thread or its answers", () => {
    expect(deriveThreadPreview(thread(), [compact({})])).toEqual({
      text: "Compact note",
      source: "thread-compact",
    });
    const result = deriveThreadPreview(thread(), [
      compact({ id: "thread-note", content: "Thread compact" }),
      compact({
        id: "foreign-note",
        scope_type: "answer",
        scope_id: "some-other-answer",
        content: "Must not leak from another thread",
        created_at: "2026-08-11T04:00:00.000Z",
      }),
      compact({
        id: "answer-note",
        scope_type: "answer",
        scope_id: "answer-2",
        content: "**Newest** answer compact",
        created_at: "2026-08-11T03:00:00.000Z",
      }),
    ]);

    expect(result).toEqual({
      text: "Newest answer compact",
      source: "answer-compact",
    });
  });

  it("falls back to the latest completed answer and safely shortens display text", () => {
    const value = `${"🙂".repeat(10)} <img src=x onerror=alert(1)>`;

    expect(deriveThreadPreview(thread(), [])).toEqual({
      text: "Newest completed answer",
      source: "answer",
    });
    expect(normalizeThreadPreview(value, 8)).toBe("🙂🙂🙂🙂🙂🙂🙂…");
    expect(normalizeThreadPreview("[Readable](https://example.test) **note**"))
      .toBe("Readable note");
  });
});
