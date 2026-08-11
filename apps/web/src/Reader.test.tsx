import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ArtifactCard,
  availableSelectionActions,
  clearThreadReplyRetry,
  copyTextToClipboard,
  deriveThreadPreview,
  HighlightCard,
  MarkdownContent,
  normalizeThreadPreview,
  placeSelectionPopover,
  releaseLock,
  relativeSelectionGeometryKey,
  rememberThreadReplyRetry,
  retryRequestId,
  shouldSubmitComposerKey,
  shouldKeepPopoverPlacement,
  threadReplyRetryRequestId,
  ThreadCard,
  translateIframeRect,
  tryAcquireLock,
} from "./Reader.js";

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

  it("renders deterministic summary freshness controls", () => {
    const html = renderToStaticMarkup(
      <ArtifactCard
        artifact={{
          id: "artifact-1",
          kind: "tldr",
          content: "Existing summary",
          sourceRefs: ["version-1"],
          promoted: false,
          scope_type: "document",
          scope_id: "document-1",
          freshness: {
            status: "needs-review",
            reasons: ["reader-signals-changed"],
          },
        }}
        busy={false}
        onPromote={() => {}}
        onRegenerate={() => {}}
        onAcceptCurrent={() => {}}
      />,
    );

    expect(html).toContain("Review recommended");
    expect(html).toContain("important highlights or comments changed");
    expect(html).toContain("Keep current");
    expect(html).toContain("Regenerate");
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
              content: "A detailed answer",
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
        onPolishAnnotation={async () => true}
        onCopy={async () => {}}
      />,
    );

    expect(highlight).toContain("Reader perspective");
    expect(highlight).toContain("Comments influence summaries");
    expect(thread).toContain("Article annotation");
    expect(thread).toContain("Polish with AI");
    expect(thread).toContain("Copy answer");
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
