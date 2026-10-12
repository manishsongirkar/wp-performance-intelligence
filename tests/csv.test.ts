import { describe, expect, it } from "vitest";
import { parseUrlCsv } from "../packages/url-import/src/csv.js";

describe("parseUrlCsv", () => {
  it("parses URL lists", () => {
    const result = parseUrlCsv("url,group\nhttps://example.com/,home\nhttps://example.com/about/,pages");
    expect(result.mode).toBe("urls");
    expect(result.urls).toHaveLength(2);
  });
  it("parses old/new mappings", () => {
    const result = parseUrlCsv("old_url,new_url,group\nhttps://old.example.com/,https://new.example.com/,home");
    expect(result.mode).toBe("pairs");
    expect(result.pairs[0]?.group).toBe("home");
  });
  it("rejects javascript URLs", () => {
    const result = parseUrlCsv("url\njavascript:alert(1)");
    expect(result.errors).toHaveLength(1);
  });
});

describe("parseUrlCsv edge cases", () => {
  it("handles quoted commas, escaped quotes, embedded newlines, CRLF and BOM", () => {
    const r = parseUrlCsv('﻿url,group\r\n"https://a.com/?x=1,2","he said ""hi"""\r\n"https://b.com/","line1\nline2"\r\n');
    expect(r.urls).toEqual(["https://a.com/?x=1,2", "https://b.com/"]);
    expect(r.errors).toEqual([]);
  });
  it("reports row-level errors with row numbers and keeps good rows", () => {
    const r = parseUrlCsv("url\nhttps://a.com/\n\nftp://x.com/\njavascript:alert(1)\nnot a url");
    expect(r.urls).toEqual(["https://a.com/"]);
    expect(r.errors).toHaveLength(3); expect(r.errors[0]).toContain("Row 4");   // physical line numbers: the blank line 3 is counted
  });
  it("dedupes URLs and validates both sides of a pair", () => {
    expect(parseUrlCsv("url\nhttps://a.com/\nhttps://a.com/").urls).toHaveLength(1);
    const r = parseUrlCsv("old_url,new_url\nhttps://a.com/,\nhttps://a.com/,ftp://b.com/\nhttps://a.com/,https://b.com/");
    expect(r.pairs).toHaveLength(1); expect(r.errors).toHaveLength(2);
  });
  it("matches headers case-insensitively and rejects bad input", () => {
    expect(parseUrlCsv(" URL \nhttps://a.com/").urls).toHaveLength(1);
    expect(() => parseUrlCsv("url")).toThrow(/header/);
    expect(() => parseUrlCsv("url\n\"https://a.com/")).toThrow(/unclosed/);
    expect(() => parseUrlCsv("name\nx")).toThrow(/header must include/);
  });
});
