import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isBinaryStl, parseAsciiStl, parseBinaryStl, parseStl } from "../src/client/stlParse";

const modelPath = path.resolve(
  import.meta.dirname,
  "..",
  "public/dataset/v1/snowman/snowman-snowman-07-dimensions-r2-0a976d9f4c/model.stl",
);

// readFileSync hands back a Buffer over a shared pool, so slice out this file's own bytes.
function committedModel(): ArrayBuffer {
  const file = readFileSync(modelPath);
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
}

function declaredFaces(buffer: ArrayBuffer): number {
  return new DataView(buffer).getUint32(80, true);
}

function asciiStl(body: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(body);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

const TWO_FACET_ASCII = `solid wedge
 facet normal 0 0 1
  outer loop
   vertex 0 0 0
   vertex 10 0 0
   vertex 0 10 0
  endloop
 endfacet
 facet normal 0 1 0
  outer loop
   vertex 0 0 0
   vertex 0 0 10
   vertex 10 0 0
  endloop
 endfacet
endsolid wedge
`;

describe("stl parsing", () => {
  it("reads every triangle out of the committed snowman model", () => {
    const buffer = committedModel();
    const faces = declaredFaces(buffer);
    expect(isBinaryStl(buffer)).toBe(true);
    expect(faces).toBe(55836);

    const { positions, normals } = parseStl(buffer);
    expect(positions).toHaveLength(faces * 9);
    expect(normals).toHaveLength(positions.length);

    let minX = Infinity;
    let maxX = -Infinity;
    for (let index = 0; index < positions.length; index += 3) {
      minX = Math.min(minX, positions[index]);
      maxX = Math.max(maxX, positions[index]);
    }
    expect(maxX - minX).toBeGreaterThan(0);
  });

  it("throws on a transfer that stopped partway", () => {
    const truncated = committedModel().slice(0, Math.floor(2791884 * 0.6));
    // The header still claims 55,836 faces, so the size check calls it ASCII and the
    // text parser finds nothing to match. That used to come back as an empty mesh.
    expect(isBinaryStl(truncated)).toBe(false);
    expect(() => parseStl(truncated)).toThrow(/no triangles/i);
  });

  it("throws when the binary header declares zero faces", () => {
    const buffer = committedModel();
    new DataView(buffer).setUint32(80, 0, true);
    expect(isBinaryStl(buffer)).toBe(true);
    expect(() => parseBinaryStl(buffer)).toThrow(/zero triangles/i);
    expect(() => parseStl(buffer)).toThrow(/zero triangles/i);
  });

  it("parses ASCII facets with their own normals", () => {
    const { positions, normals } = parseStl(asciiStl(TWO_FACET_ASCII));
    expect(positions).toHaveLength(18);
    expect(normals).toHaveLength(18);
    expect(Array.from(positions.slice(0, 9))).toEqual([0, 0, 0, 10, 0, 0, 0, 10, 0]);
    expect(Array.from(normals.slice(0, 9))).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    expect(Array.from(normals.slice(9))).toEqual([0, 1, 0, 0, 1, 0, 0, 1, 0]);
  });

  it("does not read past the end of a buffer too short to hold a header", () => {
    const stub = committedModel().slice(0, 40);
    expect(isBinaryStl(stub)).toBe(false);
    expect(parseAsciiStl(stub).positions).toHaveLength(0);
    expect(() => parseStl(stub)).toThrow(/no triangles/i);
    expect(() => parseStl(new ArrayBuffer(0))).toThrow(/no triangles/i);
  });
});
