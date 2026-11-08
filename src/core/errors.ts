/**
 * Error types shared across modules. Hooks never let these escape to the host; writers surface them
 * as exit codes (LockBusyError → 75) or audit entries.
 */

export class AuthorityViolationError extends Error {
  constructor(
    public readonly memoryId: string,
    public readonly actor: string,
    public readonly attempted: string
  ) {
    super(`Actor '${actor}' may not ${attempted} human memory ${memoryId}`);
    this.name = "AuthorityViolationError";
  }
}

export class LockBusyError extends Error {
  constructor(
    public readonly lockPath: string,
    public readonly holder: unknown
  ) {
    super(`Write lock busy: ${lockPath}`);
    this.name = "LockBusyError";
  }
}

export class SnapshotUnavailableError extends Error {
  constructor(public readonly reason: "missing" | "corrupt" | "schema") {
    super(`Snapshot unavailable: ${reason}`);
    this.name = "SnapshotUnavailableError";
  }
}

export class DatabaseNewerThanCodeError extends Error {
  constructor(
    public readonly userVersion: number,
    public readonly supported: number
  ) {
    super(`Database user_version ${userVersion} is newer than this build supports (${supported}); upgrade harness-memory`);
    this.name = "DatabaseNewerThanCodeError";
  }
}

export const EXIT_CODES = {
  ok: 0,
  error: 1,
  lock_busy: 75,
} as const;
