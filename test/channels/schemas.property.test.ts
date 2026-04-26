import { describe, it, expect } from "bun:test";
import * as fc from "fast-check";
import { discordEmbedSchema, messageContentSchema } from "../../src/channels/schemas";

// Arbitraries for valid schema payloads

// Generate valid ISO-8601 datetime strings directly without fc.date (avoids Invalid Date edge cases)
const validTimestamp = fc
  .tuple(
    fc.integer({ min: 2000, max: 2099 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
    fc.integer({ min: 0, max: 23 }),
    fc.integer({ min: 0, max: 59 }),
    fc.integer({ min: 0, max: 59 })
  )
  .map(([y, mo, d, h, mi, s]) => {
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}.000Z`;
  });

const validColor = fc.integer({ min: 0, max: 0xffffff });

const validFooter = fc.record(
  {
    text: fc.string({ minLength: 1 }),
    icon_url: fc.option(fc.webUrl(), { nil: undefined }),
  },
  { requiredKeys: ["text"] }
);

const validImageOrThumbnail = fc.record({ url: fc.webUrl() });

const validAuthor = fc.record(
  {
    name: fc.string({ minLength: 1 }),
    url: fc.option(fc.webUrl(), { nil: undefined }),
    icon_url: fc.option(fc.webUrl(), { nil: undefined }),
  },
  { requiredKeys: ["name"] }
);

const validField = fc.record(
  {
    name: fc.string({ minLength: 1 }),
    value: fc.string({ minLength: 1 }),
    inline: fc.option(fc.boolean(), { nil: undefined }),
  },
  { requiredKeys: ["name", "value"] }
);

const validDiscordEmbed = fc.record(
  {
    title: fc.option(fc.string(), { nil: undefined }),
    description: fc.option(fc.string(), { nil: undefined }),
    url: fc.option(fc.webUrl(), { nil: undefined }),
    timestamp: fc.option(validTimestamp, { nil: undefined }),
    color: fc.option(validColor, { nil: undefined }),
    footer: fc.option(validFooter, { nil: undefined }),
    image: fc.option(validImageOrThumbnail, { nil: undefined }),
    thumbnail: fc.option(validImageOrThumbnail, { nil: undefined }),
    author: fc.option(validAuthor, { nil: undefined }),
    fields: fc.option(fc.array(validField, { maxLength: 5 }), { nil: undefined }),
  },
  { requiredKeys: [] }
);

// messageContentSchema requires at least text or embed
const validMessageWithText = fc.record(
  {
    text: fc.string({ minLength: 1 }),
    embed: fc.option(validDiscordEmbed, { nil: undefined }),
  },
  { requiredKeys: ["text"] }
);

const validMessageWithEmbed = fc.record(
  {
    text: fc.option(fc.string(), { nil: undefined }),
    embed: validDiscordEmbed,
  },
  { requiredKeys: ["embed"] }
);

describe("C3: discordEmbedSchema round-trip property", () => {
  it("valid embed payload always parses successfully", () => {
    fc.assert(
      fc.property(validDiscordEmbed, (payload) => {
        const result = discordEmbedSchema.safeParse(payload);
        expect(result.success).toBe(true);
        if (result.success) {
          // Shape check: present keys match
          if (payload.title !== undefined) expect(result.data.title).toBe(payload.title);
          if (payload.description !== undefined) expect(result.data.description).toBe(payload.description);
          if (payload.color !== undefined) expect(result.data.color).toBe(payload.color);
          if (payload.fields !== undefined) expect(result.data.fields?.length).toBe(payload.fields.length);
        }
      }),
      { numRuns: 500 }
    );
  });

  it("color out of range [0, 0xffffff] must fail", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ max: -1 }),
          fc.integer({ min: 0x1000000 })
        ),
        (badColor) => {
          const result = discordEmbedSchema.safeParse({ color: badColor });
          expect(result.success).toBe(false);
        }
      ),
      { numRuns: 200 }
    );
  });

  it("non-ISO-8601 timestamp must fail", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)),
        (badTimestamp) => {
          const result = discordEmbedSchema.safeParse({ timestamp: badTimestamp });
          expect(result.success).toBe(false);
        }
      ),
      { numRuns: 200 }
    );
  });

  it("non-object input must fail", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
        (badInput) => {
          const result = discordEmbedSchema.safeParse(badInput);
          expect(result.success).toBe(false);
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe("C3: messageContentSchema round-trip property", () => {
  it("payload with text always parses successfully", () => {
    fc.assert(
      fc.property(validMessageWithText, (payload) => {
        const result = messageContentSchema.safeParse(payload);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.text).toBe(payload.text);
        }
      }),
      { numRuns: 300 }
    );
  });

  it("payload with embed (no text) always parses successfully", () => {
    fc.assert(
      fc.property(validMessageWithEmbed, (payload) => {
        const result = messageContentSchema.safeParse(payload);
        expect(result.success).toBe(true);
      }),
      { numRuns: 300 }
    );
  });

  it("payload with neither text nor embed must fail", () => {
    const result = messageContentSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("payload with only undefined text and undefined embed must fail", () => {
    fc.assert(
      fc.property(fc.constant({ text: undefined, embed: undefined }), (payload) => {
        const result = messageContentSchema.safeParse(payload);
        expect(result.success).toBe(false);
      }),
      { numRuns: 10 }
    );
  });

  it("non-object input must fail", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
        (badInput) => {
          const result = messageContentSchema.safeParse(badInput);
          expect(result.success).toBe(false);
        }
      ),
      { numRuns: 200 }
    );
  });
});
