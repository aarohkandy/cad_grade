import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { classicPage, handleRequest, listenProblem, startupProblem } from "../scripts/serve-trends.mjs";

function fakeResponse() {
  return {
    statusCode: 200,
    headersSent: false,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body) {
      this.headersSent = true;
      this.body = body === undefined ? null : String(body);
    },
  };
}

async function analysisDir() {
  const root = await mkdtemp(join(tmpdir(), "cad-trends-"));
  const analysisRoot = join(root, "latest");
  await mkdir(analysisRoot, { recursive: true });
  return { root, analysisRoot, datasetPath: join(root, "items.json") };
}

describe("trend server", () => {
  it("names the command that produces the analysis it is missing", async () => {
    const { root, analysisRoot, datasetPath } = await analysisDir();
    try {
      expect(startupProblem({ analysisRoot, datasetPath })).toContain("npm run process:data");

      await writeFile(join(analysisRoot, "analysis.json"), "{}");
      expect(startupProblem({ analysisRoot, datasetPath })).toContain("git checkout");

      await writeFile(datasetPath, "{}");
      expect(startupProblem({ analysisRoot, datasetPath })).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("names ANALYSIS_PORT when the port is taken, and defers anything else", () => {
    expect(listenProblem({ code: "EADDRINUSE" }, 5175)).toContain("ANALYSIS_PORT");
    expect(listenProblem({ code: "EADDRINUSE" }, 5175)).toContain("5175");
    expect(listenProblem({ code: "EACCES" }, 5175)).toBeNull();
  });

  it("reports a missing classic report instead of reading it", async () => {
    const { root, analysisRoot } = await analysisDir();
    try {
      expect(classicPage(analysisRoot)).toBeNull();
      await writeFile(join(analysisRoot, "index.html"), "<h1>classic</h1>");
      expect(String(classicPage(analysisRoot))).toContain("classic");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("404s /classic rather than throwing at the request", async () => {
    const { root, analysisRoot, datasetPath } = await analysisDir();
    try {
      const response = fakeResponse();
      handleRequest({ method: "GET", url: "/classic" }, response, { analysisRoot, datasetPath });
      expect(response.statusCode).toBe(404);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("answers 500 and logs when the analysis disappears under a running server", async () => {
    const { root, analysisRoot, datasetPath } = await analysisDir();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = fakeResponse();
      expect(() => handleRequest({ method: "GET", url: "/" }, response, { analysisRoot, datasetPath })).not.toThrow();
      expect(response.statusCode).toBe(500);
      expect(response.body).toContain("server log");
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("404s an undecodable path rather than logging a 500", async () => {
    const { root, analysisRoot, datasetPath } = await analysisDir();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = fakeResponse();
      handleRequest({ method: "GET", url: "/%ff" }, response, { analysisRoot, datasetPath });
      expect(response.statusCode).toBe(404);
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  // The URL parser collapses plain "../" segments, so an escape attempt has to arrive encoded.
  it("keeps encoded traversal inside the analysis run", async () => {
    const { root, analysisRoot, datasetPath } = await analysisDir();
    try {
      await writeFile(join(root, "outside.json"), "{}");
      await mkdir(join(root, "latest-sibling"), { recursive: true });
      await writeFile(join(root, "latest-sibling", "outside.json"), "{}");

      for (const url of ["/%2e%2e/outside.json", "/%2e%2e/latest-sibling/outside.json"]) {
        const response = fakeResponse();
        handleRequest({ method: "GET", url }, response, { analysisRoot, datasetPath });
        expect(response.statusCode).toBe(404);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
