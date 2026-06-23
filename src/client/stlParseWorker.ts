type ParseRequest = {
  id: number;
  url: string;
};

type ParseSuccess = {
  id: number;
  positions: Float32Array;
  normals: Float32Array;
};

type ParseFailure = {
  id: number;
  error: string;
};

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<ParseRequest>) => void) | null;
  postMessage: (message: ParseSuccess | ParseFailure, transfer?: Transferable[]) => void;
};

function isBinaryStl(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 84) return false;
  const view = new DataView(buffer);
  const faces = view.getUint32(80, true);
  return 84 + faces * 50 <= buffer.byteLength;
}

function parseBinaryStl(buffer: ArrayBuffer): ParseSuccess {
  const view = new DataView(buffer);
  const faces = view.getUint32(80, true);
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

  return { id: 0, positions, normals };
}

function parseAsciiStl(buffer: ArrayBuffer): ParseSuccess {
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
    id: 0,
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
  };
}

function parseStl(buffer: ArrayBuffer): ParseSuccess {
  return isBinaryStl(buffer) ? parseBinaryStl(buffer) : parseAsciiStl(buffer);
}

workerScope.onmessage = async (event: MessageEvent<ParseRequest>) => {
  const { id, url } = event.data;
  try {
    const response = await fetch(url, { cache: "force-cache" });
    if (!response.ok) throw new Error(`STL fetch failed ${response.status}`);
    const parsed = parseStl(await response.arrayBuffer());
    const message: ParseSuccess = { ...parsed, id };
    workerScope.postMessage(message, [message.positions.buffer, message.normals.buffer]);
  } catch (error) {
    const message: ParseFailure = {
      id,
      error: error instanceof Error ? error.message : "STL parse failed",
    };
    workerScope.postMessage(message);
  }
};
