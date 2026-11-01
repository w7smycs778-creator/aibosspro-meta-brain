// The HTTP boundary under MetaDispatcher, for the demo. LIVE: a recording
// fetch keeps every model request and response (no request headers, so no
// API key; cookies dropped) with latency and the provider request id. REPLAY:
// a fetch that answers from those recordings in order, and refuses (throws)
// when a request differs from the recorded one, so a replay either
// reproduces the recorded run exactly or fails loudly. Neither touches the
// gateway, the ledger, the tools or the verifier: those run for real.
import { createHash } from "node:crypto";

export type Exchange = {
  seq: number;
  startedAt: string;
  latencyMs: number;
  method: string;
  /** URL path only (no host), e.g. "/v1/chat/completions". */
  path: string;
  /** Parsed JSON request body; non-JSON bodies are described, not stored. */
  request: unknown;
  /** sha256 of the normalized request (ids replaced), used to match on replay. */
  requestKey: string;
  response: { status: number; headers: Record<string, string>; body: string } | null;
  error: string | null;
  providerRequestId: string | null;
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Booking and approval ids are random per run; they are replaced before matching. */
export function normalize(body: unknown): string {
  return JSON.stringify(body).replace(UUID, "<uuid>");
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return { nonJson: true, sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length };
    }
  }
  if (body instanceof FormData) {
    const fields: Record<string, string> = {};
    body.forEach((v, k) => {
      fields[k] = typeof v === "string" ? v : `<file ${v.size} bytes>`;
    });
    return { multipart: fields };
  }
  return { body: body == null ? null : "<binary>" };
}

function headersOf(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (k.toLowerCase() !== "set-cookie") out[k.toLowerCase()] = v;
  });
  return out;
}

function requestId(headers: Record<string, string>): string | null {
  return headers["x-request-id"] ?? headers["request-id"] ?? headers["x-fb-trace-id"] ?? null;
}

const pathOf = (input: RequestInfo | URL) => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;

export function recordingFetch(inner: typeof fetch, onExchange: (e: Exchange) => void): typeof fetch {
  let seq = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = parseBody(init?.body);
    const base = { seq: ++seq, startedAt: new Date().toISOString(), method: init?.method ?? "GET", path: pathOf(input), request, requestKey: sha(normalize(request)) };
    const started = performance.now();
    try {
      const res = await inner(input, init);
      const body = await res.text();
      const headers = headersOf(res);
      onExchange({ ...base, latencyMs: Math.round(performance.now() - started), response: { status: res.status, headers, body }, error: null, providerRequestId: requestId(headers) });
      return new Response(body, { status: res.status, headers: res.headers });
    } catch (err) {
      onExchange({ ...base, latencyMs: Math.round(performance.now() - started), response: null, error: `${(err as Error).name}: ${(err as Error).message}`, providerRequestId: null });
      throw err;
    }
  }) as typeof fetch;
}

export class ReplayMismatchError extends Error {}

/** Answers from recorded exchanges in order; any difference from the recording throws. */
export function replayFetch(exchanges: Exchange[], onExchange?: (e: Exchange) => void): typeof fetch & { remaining(): number } {
  let next = 0;
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = parseBody(init?.body);
    const path = pathOf(input);
    const rec = exchanges[next];
    if (!rec) throw new ReplayMismatchError(`REPLAY: call ${next + 1} to ${path} has no recording (the recording has ${exchanges.length} calls)`);
    const key = sha(normalize(request));
    if (rec.path !== path || rec.requestKey !== key) {
      throw new ReplayMismatchError(`REPLAY: call ${next + 1} differs from the recording (${rec.path} vs ${path}; ${firstDifference(normalize(rec.request), normalize(request))}). Re-record with LIVE.`);
    }
    next++;
    if (!rec.response) throw new Error(`REPLAY: recorded call ${rec.seq} failed live: ${rec.error}`);
    onExchange?.({ ...rec, startedAt: new Date().toISOString() });
    return new Response(rec.response.body, { status: rec.response.status, headers: rec.response.headers });
  }) as typeof fetch & { remaining(): number };
  f.remaining = () => exchanges.length - next;
  return f;
}

/** Where two normalized requests first differ, with a little context from each. */
export function firstDifference(recorded: string, now: string): string {
  let i = 0;
  while (i < recorded.length && i < now.length && recorded[i] === now[i]) i++;
  if (i === recorded.length && i === now.length) return "request same";
  const at = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 40), i + 60));
  return `request differs at char ${i}: recorded ${at(recorded)} vs now ${at(now)}`;
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
