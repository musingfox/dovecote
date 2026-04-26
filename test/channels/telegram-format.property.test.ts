import { describe, it, expect } from "bun:test";
import * as fc from "fast-check";
import { escapeTelegramHtml, renderEmbedAsHtml } from "../../src/channels/telegram-format";
import type { DiscordEmbed } from "../../src/channels/types";

// Arbitrary for a valid DiscordEmbed with at least one renderable field
const embedArbitrary = fc.record(
  {
    title: fc.option(fc.string(), { nil: undefined }),
    description: fc.option(fc.string(), { nil: undefined }),
    url: fc.option(fc.webUrl(), { nil: undefined }),
    fields: fc.option(
      fc.array(
        fc.record({
          name: fc.string({ minLength: 1 }),
          value: fc.string({ minLength: 1 }),
          inline: fc.option(fc.boolean(), { nil: undefined }),
        }),
        { maxLength: 5 }
      ),
      { nil: undefined }
    ),
  },
  { requiredKeys: [] }
) as fc.Arbitrary<DiscordEmbed>;

describe("C1: escapeTelegramHtml property", () => {
  it("output never contains bare < or > or & (only encoded entities)", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const result = escapeTelegramHtml(s);
        // After escaping, no bare & that is not part of a valid entity
        // Specifically: no &[^amp;lt;gt;quot;] sequences that would indicate unescaped &
        // Simpler invariant: no bare < or >
        expect(result).not.toMatch(/(?<!&(amp|lt|gt|quot);)<(?!\w)/);
        // Check directly: result should not contain raw < or > or unescaped &
        const hasBareAngle = result.includes("<") || result.includes(">");
        expect(hasBareAngle).toBe(false);
        // & only appears as start of a known entity
        const bareAmpersand = /&(?!(amp|lt|gt|quot);)/.test(result);
        expect(bareAmpersand).toBe(false);
      }),
      { numRuns: 1000 }
    );
  });

  it('specific example: "<script>alert(\'x\')&y" is properly escaped', () => {
    const result = escapeTelegramHtml("<script>alert('x')&y");
    expect(result).toContain("&lt;script&gt;");
    expect(result).toContain("&amp;y");
    expect(result).not.toContain("<script>");
  });

  it("escape is stable: encoded characters map to known entities only", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const result = escapeTelegramHtml(s);
        // All & in output must be followed by amp; lt; gt; or quot;
        const allAmpersandsValid = !(/&(?!(amp|lt|gt|quot);)/.test(result));
        expect(allAmpersandsValid).toBe(true);
      }),
      { numRuns: 500 }
    );
  });
});

describe("C2: renderEmbedAsHtml property", () => {
  it("never throws for any valid embed shape", () => {
    fc.assert(
      fc.property(embedArbitrary, (embed) => {
        expect(() => renderEmbedAsHtml(embed)).not.toThrow();
      }),
      { numRuns: 500 }
    );
  });

  it("output passes C1 invariant: no bare < > & in final HTML text nodes", () => {
    fc.assert(
      fc.property(embedArbitrary, (embed) => {
        const result = renderEmbedAsHtml(embed);
        // Extract text content (strip known HTML tags produced by renderEmbedAsHtml)
        // Known safe tags: <b>, </b>, <a href="...">, </a>
        // We check that no bare & remains outside entities (unescaped user content)
        // Strip the structural tags first
        const stripped = result
          .replace(/<b>/g, "")
          .replace(/<\/b>/g, "")
          .replace(/<a href="[^"]*">/g, "")
          .replace(/<\/a>/g, "");
        // Now stripped should have no bare < > and & only as entities
        expect(stripped).not.toContain("<");
        expect(stripped).not.toContain(">");
        const bareAmp = /&(?!(amp|lt|gt|quot);)/.test(stripped);
        expect(bareAmp).toBe(false);
      }),
      { numRuns: 500 }
    );
  });

  it("returns a string (never undefined or null)", () => {
    fc.assert(
      fc.property(embedArbitrary, (embed) => {
        const result = renderEmbedAsHtml(embed);
        expect(typeof result).toBe("string");
      }),
      { numRuns: 200 }
    );
  });
});
