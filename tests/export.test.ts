import { describe, expect, it } from "vitest";
import { toCsv } from "../src/server/export";

function dataRow(csv: string): string {
  return csv.split("\n")[1];
}

describe("export formatting", () => {
  it("quotes csv cells with commas and quotes", () => {
    const csv = toCsv([{ id: "1", note: 'a "quoted", value' }]);
    expect(csv).toContain('"a ""quoted"", value"');
  });

  it("keeps a cell that opens like a formula from being one", () => {
    const csv = toCsv([
      { battle_id: "=cmd|' /C calc'!A1", session_id: "+1234567890123", note: "-2+3", handle: "@someone" },
    ]);
    expect(dataRow(csv)).toBe(`'=cmd|' /C calc'!A1,'+1234567890123,'-2+3,'@someone`);
  });

  it("leaves numbers and booleans alone", () => {
    const csv = toCsv([{ elapsed_ms: -5, elo: 1207.5, accepted_for_scoring: false }]);
    expect(dataRow(csv)).toBe("-5,1207.5,false");
  });

  it("wraps a cell holding a line break", () => {
    const csv = toCsv([{ note: "first\r\nsecond" }]);
    expect(csv).toBe('note\n"first\r\nsecond"\n');
  });

  it("writes null and undefined as empty cells", () => {
    const csv = toCsv([{ winner_item_id: null, loser_item_id: undefined, vote_result: "draw" }]);
    expect(dataRow(csv)).toBe(",,draw");
  });

  it("serializes object and array cells as json", () => {
    const csv = toCsv([{ quality_flags: ["too_fast", "weak_session"], storage: { mode: "local" } }]);
    expect(dataRow(csv)).toBe('"[""too_fast"",""weak_session""]","{""mode"":""local""}"');
  });

  it("unions the columns across rows", () => {
    const csv = toCsv([{ a: 1 }, { b: 2 }]);
    expect(csv).toBe("a,b\n1,\n,2\n");
  });
});
