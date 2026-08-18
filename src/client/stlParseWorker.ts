import { parseStl } from "./stlParse";

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

workerScope.onmessage = async (event: MessageEvent<ParseRequest>) => {
  const { id, url } = event.data;
  try {
    const response = await fetch(url, { cache: "force-cache" });
    if (!response.ok) throw new Error(`STL fetch failed ${response.status}`);
    const parsed = parseStl(await response.arrayBuffer());
    const message: ParseSuccess = { id, positions: parsed.positions, normals: parsed.normals };
    workerScope.postMessage(message, [message.positions.buffer, message.normals.buffer]);
  } catch (error) {
    const message: ParseFailure = {
      id,
      error: error instanceof Error ? error.message : "STL parse failed",
    };
    workerScope.postMessage(message);
  }
};
