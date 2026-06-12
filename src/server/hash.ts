import { createHash } from "node:crypto";

export function safeHash(value: string, salt = process.env.IP_HASH_SALT || "local-dev-hash-salt"): string {
  return createHash("sha256").update(`${salt}|${value}`).digest("hex");
}
