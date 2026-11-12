// DEBUG-SANDBOX: debug-only, for the team preview deployment (branch
// debug/team-preview). NEVER MERGE — see MERGE_NOTES.md at the repo root.
//
// DEBUG_SANDBOX=true turns every outbound side effect off: email, SMS, HubSpot
// writes, the AIO dashboard API, Check, the crons. The preview runs against
// the PRODUCTION database (product owner, 2026-11-11), so the rule is stricter
// than "don't call out": an action whose whole purpose is a send / publish /
// provision refuses BEFORE it writes anything, so the DB never records a send
// that didn't happen. Pure DB edits (save a quote, drafts, approvals, rate
// edits, closed lost) still go through; their best-effort HubSpot mirrors are
// refused by `sandboxFetch` below and logged by the caller like any outage.
//
// Three layers, so a path missed by one is caught by the next:
//  1. `assertNotSandbox()` / `isSandbox()` early in the send/publish actions,
//     routes and lib entry points (the clean refusal, before any DB write).
//  2. `sandboxFetch`, imported AS `fetch` by the outbound adapters
//     (hubspot.ts, hubspotFiles.ts, commissionWriteback.ts, check.ts,
//     aioDashboard.ts): reads pass, anything that writes throws.
//  3. email.ts / sms.ts answer `{ sent: false }` exactly as when no transport
//     is configured.
//
// Pure and isomorphic on purpose (no "server-only"): the root layout and a
// client component import SANDBOX_MESSAGE.

export const SANDBOX_MESSAGE = "Sandbox: nothing was sent (debug deployment).";

export function isSandbox(): boolean {
  return process.env.DEBUG_SANDBOX === "true";
}

export class SandboxError extends Error {
  readonly sandbox = true;
  constructor(what?: string) {
    super(what ? `${SANDBOX_MESSAGE} Blocked: ${what}` : SANDBOX_MESSAGE);
    this.name = "SandboxError";
  }
}

/** Throws the action's normal error (an Error) when sandboxed. */
export function assertNotSandbox(what?: string): void {
  if (isSandbox()) throw new SandboxError(what);
}

const HUBSPOT_HOST = "api.hubapi.com";

/**
 * Whether a request only READS. Every GET/HEAD passes. HubSpot's search and
 * batch-read endpoints are POSTs that read nothing but still have to work for
 * the configurator, company picker and deal picker to load — so a POST passes
 * only for HubSpot and only on a path ending `/search` or `/batch/read`.
 * Everything else (POST/PATCH/PUT/DELETE anywhere else) is a write.
 */
export function isSandboxReadRequest(url: string, method: string): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return true;
  if (m !== "POST") return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.hostname !== HUBSPOT_HOST) return false;
  const path = parsed.pathname.replace(/\/+$/, "");
  return path.endsWith("/search") || path.endsWith("/batch/read");
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method;
  if (typeof input === "object" && !(input instanceof URL) && "method" in input) return input.method;
  return "GET";
}

/**
 * Drop-in for `fetch` in the outbound adapters. A pure pass-through (same
 * arguments, same arity, resolved against `globalThis.fetch` at call time so
 * test stubs still apply) unless DEBUG_SANDBOX=true, when a write is refused
 * with a SandboxError instead of leaving the process.
 */
export const sandboxFetch: typeof globalThis.fetch = (...args) => {
  if (isSandbox()) {
    const [input, init] = args;
    const url = requestUrl(input);
    const method = requestMethod(input, init);
    if (!isSandboxReadRequest(url, method)) {
      let where = url;
      try {
        const u = new URL(url);
        where = `${u.hostname}${u.pathname}`;
      } catch {
        // keep the raw string
      }
      console.warn(`[sandbox] blocked ${method.toUpperCase()} ${where}`);
      return Promise.reject(new SandboxError(`${method.toUpperCase()} ${where}`));
    }
  }
  return globalThis.fetch(...args);
};
