import type { VercelRequest, VercelResponse } from "@vercel/node";

export function noStore(res: VercelResponse): void {
  res.setHeader("Cache-Control", "no-store, max-age=0");
}

export function methodAllowed(req: VercelRequest, res: VercelResponse, methods: string[]): boolean {
  if (methods.includes(req.method || "")) return true;
  res.setHeader("Allow", methods.join(", "));
  res.status(405).json({ error: "method_not_allowed" });
  return false;
}

export function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** A body that arrived but is not JSON, so a handler can answer 400 instead of 500. */
export class JsonBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonBodyError";
  }
}

export function readJsonBody<T>(req: VercelRequest): T {
  const raw = typeof req.body === "string" ? req.body : Buffer.isBuffer(req.body) ? req.body.toString("utf8") : null;
  if (raw === null) return (req.body || {}) as T;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new JsonBodyError(error instanceof Error ? error.message : String(error));
  }
}

export function clientIp(req: VercelRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return String(value || req.socket.remoteAddress || "unknown")
    .split(",")[0]
    .trim();
}
