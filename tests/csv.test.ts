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
