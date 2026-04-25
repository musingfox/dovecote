import { describe, it, expect } from "bun:test";
import { escapeTelegramHtml, renderEmbedAsHtml } from "../../src/channels/telegram-format";

describe("escapeTelegramHtml", () => {
  it('empty string → empty string', () => {
    expect(escapeTelegramHtml("")).toBe("");
  });

  it('"hello" → "hello"', () => {
    expect(escapeTelegramHtml("hello")).toBe("hello");
  });

  it('"a & b" → "a &amp; b"', () => {
    expect(escapeTelegramHtml("a & b")).toBe("a &amp; b");
  });

  it('"<script>alert(\\"x\\")</script>" → escaped (incl. quotes)', () => {
    expect(escapeTelegramHtml('<script>alert("x")</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });

  it('"& < > \\"" → all four escaped', () => {
    expect(escapeTelegramHtml('& < > "')).toBe("&amp; &lt; &gt; &quot;");
  });

  it('"&lt;" → "&amp;lt;" (non-idempotent — & always escaped)', () => {
    expect(escapeTelegramHtml("&lt;")).toBe("&amp;lt;");
  });
});

describe("renderEmbedAsHtml", () => {
  it('title only → "<b>Hello</b>"', () => {
    expect(renderEmbedAsHtml({ title: "Hello" })).toBe("<b>Hello</b>");
  });

  it('title + description → "<b>Hi</b>\\nBody"', () => {
    expect(renderEmbedAsHtml({ title: "Hi", description: "Body" })).toBe("<b>Hi</b>\nBody");
  });

  it('title + url → linked title', () => {
    expect(renderEmbedAsHtml({ title: "T", url: "https://example.com" }))
      .toBe('<b><a href="https://example.com">T</a></b>');
  });

  it('url only (no title) → self-linked url', () => {
    expect(renderEmbedAsHtml({ url: "https://x.io" }))
      .toBe('<a href="https://x.io">https://x.io</a>');
  });

  it('fields only → joined by \\n\\n, inline ignored', () => {
    expect(renderEmbedAsHtml({
      fields: [
        { name: "A", value: "1" },
        { name: "B", value: "2", inline: true },
      ],
    })).toBe("<b>A</b>\n1\n\n<b>B</b>\n2");
  });

  it('title + description + fields → all parts joined', () => {
    expect(renderEmbedAsHtml({
      title: "T",
      description: "D",
      fields: [{ name: "F", value: "V" }],
    })).toBe("<b>T</b>\nD\n\n<b>F</b>\nV");
  });

  it('title and description are escaped', () => {
    expect(renderEmbedAsHtml({ title: "<x>", description: "a & b" }))
      .toBe("<b>&lt;x&gt;</b>\na &amp; b");
  });

  it('url containing " is escaped — no attribute breakout', () => {
    expect(renderEmbedAsHtml({
      title: "T",
      url: 'https://example.com/"onmouseover="bad()',
    })).toBe('<b><a href="https://example.com/&quot;onmouseover=&quot;bad()">T</a></b>');
  });

  it('only dropped fields (color, timestamp, footer) → ""', () => {
    expect(renderEmbedAsHtml({
      color: 0xff0000,
      timestamp: "2026-01-01",
      footer: { text: "f" },
    })).toBe("");
  });
});
