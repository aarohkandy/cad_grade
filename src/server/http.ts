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

export function readJsonBody<T>(req: VercelRequest): T {
  if (typeof req.body === "string") return JSON.parse(req.body) as T;
  if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString("utf8")) as T;
  return (req.body || {}) as T;
}

export function clientIp(req: VercelRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return String(value || req.socket.remoteAddress || "unknown")
    .split(",")[0]
    .trim();
}
