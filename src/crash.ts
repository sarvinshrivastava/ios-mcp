/**
 * crash.ts — reading Apple's .ips crash reports, shared by both backends.
 *
 * The FORMAT is identical wherever the report comes from — a simulator writes
 * it to ~/Library/Logs/DiagnosticReports, a real device keeps it in its own
 * systemCrashLogs domain and we copy it off with devicectl — so only the
 * discovery differs, and that lives with each backend.
 *
 * Format (verified on macOS 26 / iOS 27): line 1 is a small JSON header
 * (app_name/name/timestamp/bundleID), the remainder is a pretty-printed JSON
 * body (procName, procPath, exception{type,subtype,message},
 * termination{namespace,indicator}). Both halves are parsed defensively — a
 * half-written or format-shifted report degrades to a weaker answer, never a
 * throw, because a crash report is what you read WHEN things are already wrong.
 */

export interface CrashReport {
  /** Absolute path of the .ips report on THIS machine. */
  path: string;
  /** Best-effort one-line reason (exception type/message or termination indicator). */
  reason: string;
  /** ISO timestamp of the crash (report header, else file mtime). */
  at: string;
}

export interface ParsedIps {
  header: Record<string, unknown>;
  body: Record<string, unknown>;
}

/** Split an .ips into its header and body objects. Never throws. */
export function parseIps(raw: string): ParsedIps {
  let header: Record<string, unknown> = {};
  let body: Record<string, unknown> = {};
  const nl = raw.indexOf("\n");
  try {
    header = JSON.parse(nl === -1 ? raw : raw.slice(0, nl));
  } catch {
    /* header unreadable — the body may still identify the process */
  }
  if (nl !== -1) {
    try {
      body = JSON.parse(raw.slice(nl));
    } catch {
      /* body unreadable — the header may still identify the process */
    }
  }
  return { header, body };
}

/** The process this report belongs to, by whichever field exists. */
export function crashProcess({ header, body }: ParsedIps): string {
  return (
    (body.procName as string) ||
    (header.name as string) ||
    (header.app_name as string) ||
    ""
  );
}

/** One line that tells the agent WHY it crashed, best field available first. */
export function crashReason({ header, body }: ParsedIps): string {
  const exc = body.exception as
    | { type?: string; subtype?: string; message?: string; signal?: string }
    | undefined;
  if (exc?.type) {
    const parts = [exc.type];
    if (exc.signal) parts.push(`(${exc.signal})`);
    else if (exc.subtype) parts.push(`(${exc.subtype})`);
    if (exc.message) parts.push(`— ${exc.message}`);
    return parts.join(" ");
  }
  const term = body.termination as
    | { indicator?: string; namespace?: string }
    | undefined;
  if (term?.indicator) {
    return term.namespace
      ? `${term.namespace}: ${term.indicator}`
      : term.indicator;
  }
  if (header.bug_type) return `bug_type ${header.bug_type}`;
  return "unknown (open the report)";
}

/** Crash time: header `timestamp` ("2026-08-17 10:54:02.00 +0530"), else mtime. */
export function crashTimestamp(
  header: Record<string, unknown>,
  mtimeMs: number,
): string {
  const ts = header.timestamp as string | undefined;
  if (ts) {
    // "2026-08-17 10:54:02.00 +0530" — drop the nonstandard fraction, T-join
    // date and time, glue the offset on: "2026-08-17T10:54:02+0530".
    const norm = ts
      .replace(/\.\d+(?= )/, "")
      .replace(" ", "T")
      .replace(" ", "");
    const parsed = Date.parse(norm);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(mtimeMs).toISOString();
}
