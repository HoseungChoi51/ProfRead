import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  copyTextToClipboard,
  MarkdownContent,
  placeSelectionPopover,
  translateIframeRect,
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

  it("places the popover above a complete multiline selection", () => {
    const selection = { top: 310, left: 260, width: 180, height: 96 };
    const result = placeSelectionPopover(selection, popover, pane);

    expect(result.side).toBe("above");
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

  it("uses the article edge farthest from the selection as a fallback", () => {
    const result = placeSelectionPopover(
      { top: 84, left: 220, width: 180, height: 510 },
      { width: 280, height: 120 },
      pane,
    );

    expect(result.side).toBe("bottom-edge");
    expect(result.top).toBe(556);
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
