import type { StorageMode } from "./voteStore";

export const REQUIRED_PRODUCTION_ENV = [
  "BLOB_READ_WRITE_TOKEN",
  "IP_HASH_SALT",
  "HOLD_VERIFY_SECRET",
] as const;

export function isVercelRuntime(): boolean {
  return process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV);
}

export function hasBlobCredentials(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN || (process.env.VERCEL_OIDC_TOKEN && process.env.BLOB_STORE_ID));
}

export function missingProductionEnv(): string[] {
  const missing = REQUIRED_PRODUCTION_ENV.filter((name) => {
    if (name === "BLOB_READ_WRITE_TOKEN") return !hasBlobCredentials();
    return !process.env[name];
  });
  return [...missing];
}

export function productionVoteEnvReady(): boolean {
  return hasBlobCredentials() && Boolean(process.env.IP_HASH_SALT && process.env.HOLD_VERIFY_SECRET);
}

export function storageReadyForPublicTraffic(mode: StorageMode): boolean {
  if (isVercelRuntime()) return mode === "blob" && missingProductionEnv().length === 0;
  return mode !== "unconfigured";
}
