import { describe, expect, it } from "vitest";
import { toCsv } from "../src/server/export";

describe("export formatting", () => {
  it("quotes csv cells with commas and quotes", () => {
    const csv = toCsv([{ id: "1", note: 'a "quoted", value' }]);
    expect(csv).toContain('"a ""quoted"", value"');
  });
});
