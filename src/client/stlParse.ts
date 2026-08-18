export type ParsedStl = {
  positions: Float32Array;
  normals: Float32Array;
};

export const EMPTY_STL_ERROR = "STL contained no triangles";

// True only when the declared face count exactly fits the buffer, so a transfer that
// stopped early reads as ASCII — which is why parseStl checks the result rather than
// trusting whichever branch ran.
export function isBinaryStl(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 84) return false;
  const view = new DataView(buffer);
  const faces = view.getUint32(80, true);
  return 84 + faces * 50 <= buffer.byteLength;
}

export function parseBinaryStl(buffer: ArrayBuffer): ParsedStl {
  const view = new DataView(buffer);
  const faces = view.getUint32(80, true);
  if (faces === 0) throw new Error("STL header declares zero triangles");
  const positions = new Float32Array(faces * 9);
  const normals = new Float32Array(faces * 9);

  for (let face = 0; face < faces; face += 1) {
    const offset = 84 + face * 50;
    const normalX = view.getFloat32(offset, true);
    const normalY = view.getFloat32(offset + 4, true);
    const normalZ = view.getFloat32(offset + 8, true);
    const positionOffset = face * 9;
    for (let vertex = 0; vertex < 3; vertex += 1) {
      const source = offset + 12 + vertex * 12;
      const target = positionOffset + vertex * 3;
      positions[target] = view.getFloat32(source, true);
      positions[target + 1] = view.getFloat32(source + 4, true);
      positions[target + 2] = view.getFloat32(source + 8, true);
      normals[target] = normalX;
      normals[target + 1] = normalY;
      normals[target + 2] = normalZ;
    }
  }

  return { positions, normals };
}

export function parseAsciiStl(buffer: ArrayBuffer): ParsedStl {
  const text = new TextDecoder().decode(buffer);
  const positions: number[] = [];
  const normals: number[] = [];
  const normalPattern = /facet\s+normal\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/gi;
  const vertexPattern = /vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/gi;
  const faceNormals: number[][] = [];
  let normalMatch: RegExpExecArray | null;
  while ((normalMatch = normalPattern.exec(text))) {
    faceNormals.push([Number(normalMatch[1]) || 0, Number(normalMatch[2]) || 0, Number(normalMatch[3]) || 0]);
  }

  let vertexMatch: RegExpExecArray | null;
  let vertexIndex = 0;
  while ((vertexMatch = vertexPattern.exec(text))) {
    positions.push(Number(vertexMatch[1]) || 0, Number(vertexMatch[2]) || 0, Number(vertexMatch[3]) || 0);
    const normal = faceNormals[Math.floor(vertexIndex / 3)] || [0, 0, 1];
    normals.push(normal[0], normal[1], normal[2]);
    vertexIndex += 1;
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
  };
}

/**
 * Parses either STL flavor, and throws rather than handing back an empty mesh. An empty
 * mesh has no bounding box, so the arena would render a blank frame and ask someone to
 * grade it against a real model.
 */
export function parseStl(buffer: ArrayBuffer): ParsedStl {
  const parsed = isBinaryStl(buffer) ? parseBinaryStl(buffer) : parseAsciiStl(buffer);
  if (parsed.positions.length === 0) throw new Error(EMPTY_STL_ERROR);
  return parsed;
}
