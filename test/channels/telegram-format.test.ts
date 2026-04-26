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

  it("snapshot: title + url + description + fields (rich embed)", () => {
    expect(renderEmbedAsHtml({
      title: "Release v2.0",
      url: "https://github.com/org/repo/releases/v2.0",
      description: "Breaking changes & new features",
      fields: [
        { name: "Author", value: "Alice <alice@example.com>", inline: true },
        { name: "Tag", value: "v2.0" },
      ],
    })).toMatchInlineSnapshot(`
      "<b><a href="https://github.com/org/repo/releases/v2.0">Release v2.0</a></b>
      Breaking changes &amp; new features

      <b>Author</b>
      Alice &lt;alice@example.com&gt;

      <b>Tag</b>
      v2.0"
    `);
  });

  it("snapshot: url-only embed (no title)", () => {
    expect(renderEmbedAsHtml({
      url: 'https://example.com/path?q=1&r=2',
    })).toMatchInlineSnapshot(`"<a href="https://example.com/path?q=1&amp;r=2">https://example.com/path?q=1&amp;r=2</a>"`);
  });

  it("snapshot: description-only embed (no title, no url)", () => {
    expect(renderEmbedAsHtml({
      description: 'Plain text <b>not bold</b> & safe',
    })).toMatchInlineSnapshot(`"Plain text &lt;b&gt;not bold&lt;/b&gt; &amp; safe"`);
  });
});
