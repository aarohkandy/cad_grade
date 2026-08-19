import { afterEach, describe, expect, it, vi } from "vitest";
import { preloadStlGeometry, resetStlWorkerForTests } from "../src/client/stlViewer";

const MODEL_URL = "http://stl-viewer-cache.test/model.stl";
const SILENT_WORKER_URL = "http://stl-viewer-cache.test/silent.stl";
const REBUILD_URL = "http://stl-viewer-cache.test/rebuild.stl";
const WORKER_ERROR_URL = "http://stl-viewer-cache.test/worker-error.stl";
const ANSWERED_URL = "http://stl-viewer-cache.test/answered.stl";
const SLOW_URL = "http://stl-viewer-cache.test/slow.stl";
const LATE_URL = "http://stl-viewer-cache.test/late.stl";
// Kept in step with WORKER_REQUEST_TIMEOUT_MS in stlViewer.ts.
const WORKER_TIMEOUT_MS = 60_000;

type ParseRequest = { id: number; url: string };
type ParseReply = { id: number; positions?: Float32Array; normals?: Float32Array; error?: string };

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

// Just enough Worker for the viewer, which constructs one, posts {id, url} and waits on
// onmessage. An `answer` of null is a worker that takes the request and stays silent.
function fakeWorkers(answer: (request: ParseRequest) => ParseReply | null) {
  const created: FakeWorker[] = [];

  class FakeWorker {
    posted: ParseRequest[] = [];
    terminated = false;
    onmessage: ((event: { data: ParseReply }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessageerror: (() => void) | null = null;

    constructor() {
      created.push(this);
    }

    postMessage(request: ParseRequest): void {
      this.posted.push(request);
      const reply = answer(request);
      if (reply) queueMicrotask(() => this.onmessage?.({ data: reply }));
    }

    terminate(): void {
      this.terminated = true;
    }
  }

  return { created, FakeWorker };
}

afterEach(() => {
  // unstubAllGlobals puts the real Worker back but the module is still holding the stub it
  // built, so without this the next test to stub a Worker never sees one constructed.
  resetStlWorkerForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("geometry cache", () => {
  it("re-fetches a model whose first load failed", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", async () => {
      attempts += 1;
      throw new TypeError("fetch failed");
    });

    preloadStlGeometry(MODEL_URL);
    await settle();
    expect(attempts).toBe(1);

    preloadStlGeometry(MODEL_URL);
    await settle();
    expect(attempts).toBe(2);
  });
});

describe("stl worker requests", () => {
  it("gives up on a worker that takes the request and never answers", async () => {
    vi.useFakeTimers();
    const { created, FakeWorker } = fakeWorkers(() => null);
    vi.stubGlobal("Worker", FakeWorker);
    let fetches = 0;
    vi.stubGlobal("fetch", async () => {
      fetches += 1;
      throw new TypeError("fetch failed");
    });

    preloadStlGeometry(SILENT_WORKER_URL);
    await vi.advanceTimersByTimeAsync(0);
    expect(created).toHaveLength(1);
    expect(created[0].posted).toHaveLength(1);
    expect(fetches).toBe(0);

    await vi.advanceTimersByTimeAsync(WORKER_TIMEOUT_MS);
    // Nothing asserts the rejection text: loadGeometry catches it and falls back to Three's
    // loader, so the one visible consequence of giving up is that the fallback fetch runs.
    expect(fetches).toBe(1);
    expect(created[0].terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    preloadStlGeometry(REBUILD_URL);
    await vi.advanceTimersByTimeAsync(0);
    expect(created).toHaveLength(2);
  });

  // The worker awaits its own fetch, so a second request is picked up while the first is
  // still running. A deadline that failed every pending request would charge a load that
  // started a second ago for the sixty seconds an earlier one sat there.
  it("only gives up on the request whose own deadline passed", async () => {
    vi.useFakeTimers();
    const { created, FakeWorker } = fakeWorkers(() => null);
    vi.stubGlobal("Worker", FakeWorker);
    const fetched: string[] = [];
    // Three's loader hands fetch a Request rather than a URL string.
    vi.stubGlobal("fetch", async (input: string | Request) => {
      fetched.push(typeof input === "string" ? input : input.url);
      throw new TypeError("fetch failed");
    });

    preloadStlGeometry(SLOW_URL);
    await vi.advanceTimersByTimeAsync(WORKER_TIMEOUT_MS - 1000);
    preloadStlGeometry(LATE_URL);
    await vi.advanceTimersByTimeAsync(1000);

    expect(fetched).toEqual([SLOW_URL]);
    expect(created).toHaveLength(1);
    expect(created[0].terminated).toBe(false);

    await vi.advanceTimersByTimeAsync(WORKER_TIMEOUT_MS);
    expect(fetched).toEqual([SLOW_URL, LATE_URL]);
    expect(created[0].terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops the timer along with the request when the worker itself errors", async () => {
    vi.useFakeTimers();
    const { created, FakeWorker } = fakeWorkers(() => null);
    vi.stubGlobal("Worker", FakeWorker);
    let fetches = 0;
    vi.stubGlobal("fetch", async () => {
      fetches += 1;
      throw new TypeError("fetch failed");
    });

    preloadStlGeometry(WORKER_ERROR_URL);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    created[0].onerror?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetches).toBe(1);
    expect(created[0].terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no timer running once the worker answers", async () => {
    vi.useFakeTimers();
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const { created, FakeWorker } = fakeWorkers((request) => ({ id: request.id, positions, normals }));
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("fetch", async () => {
      throw new Error("the worker answered, so nothing should reach the network");
    });

    preloadStlGeometry(ANSWERED_URL);
    await vi.advanceTimersByTimeAsync(0);

    expect(created[0].terminated).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
