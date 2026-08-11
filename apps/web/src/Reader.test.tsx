import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { copyTextToClipboard, MarkdownContent } from "./Reader.js";

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
