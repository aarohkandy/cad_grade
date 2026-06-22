const RAW_VOTE_PATH_PATTERN =
  /^votes\/v1\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_[^/]+\.json$/;

export function completedUtcHour(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));
}

export function votePathCreatedAt(pathname: string): Date | null {
  const match = RAW_VOTE_PATH_PATTERN.exec(pathname);
  if (!match) return null;
  const [, folderDay, day, hour, minute, second, ms] = match;
  if (folderDay !== day) return null;
  const createdAt = new Date(`${day}T${hour}:${minute}:${second}.${ms}Z`);
  return Number.isFinite(createdAt.getTime()) ? createdAt : null;
}

export function isPrunableRawVotePath(pathname: string, now = new Date()): boolean {
  const createdAt = votePathCreatedAt(pathname);
  return Boolean(createdAt && createdAt < completedUtcHour(now));
}

export function prunableRawVotePaths(paths: string[], now = new Date()): string[] {
  return [...new Set(paths)]
    .filter((path) => typeof path === "string")
    .filter((path) => isPrunableRawVotePath(path, now))
    .sort();
}
