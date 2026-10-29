// The only module that talks to the Meta Model API. It is constructed by
// createLiveGateway() and must never be called except through SpendGateway.
import type { Storage } from "../storage/types";
import { HostedInferenceBlockedError, LiveCreditsNotVerifiedError, PreDispatchError } from "./errors";
import type { BillingUnits, DispatchResult, Dispatcher, Env, ModelCall } from "./types";

type FetchFn = typeof fetch;
/** The store holding the spend ledger this dispatcher's gateway writes to. */
type LedgerProbe = Pick<Storage, "backend" | "ping">;

const REQUEST_TIMEOUT_MS = 120_000;
const ERROR_BODY_LIMIT = 2_000;

export class MetaDispatcher implements Dispatcher {
  constructor(
    private readonly env: Env = process.env,
    private readonly fetchFn: FetchFn = fetch,
    private readonly ledgerStore?: LedgerProbe,
  ) {}

  /** Hosted inference gate, run by the gateway before any reservation. */
  async preflight(): Promise<void> {
    this.assertHostedAllowed();
    try {
      await this.ledgerStore!.ping();
    } catch {
      throw new HostedInferenceBlockedError("the Supabase spend ledger table is unreachable");
    }
  }

  // Read at call time so the guard cannot be bypassed by early construction.
  private assertHostedAllowed(): void {
    if (this.env.LIVE_CREDITS_VERIFIED !== "true") throw new LiveCreditsNotVerifiedError();
    if (this.env.STORAGE_BACKEND !== "supabase") {
      throw new HostedInferenceBlockedError("STORAGE_BACKEND is not 'supabase', so the spend ledger is not durable in Postgres");
    }
    if (this.ledgerStore?.backend !== "supabase") {
      throw new HostedInferenceBlockedError("the gateway's spend ledger is not the Supabase store");
    }
  }

  async dispatch(call: ModelCall): Promise<DispatchResult> {
    this.assertHostedAllowed();
    if (call.kind === "chat" && call.tools) {
      throw new PreDispatchError("tools_not_supported", "tool calls are not wired to the Meta Model API yet");
    }
    const baseUrl = this.env.MODEL_API_BASE_URL?.replace(/\/+$/, "");
    if (!baseUrl || !baseUrl.startsWith("https://")) {
      throw new PreDispatchError("dispatcher_not_configured", "MODEL_API_BASE_URL is missing or not https");
    }
    const key = this.env.MODEL_API_KEY;
    if (!key) throw new PreDispatchError("dispatcher_not_configured", "MODEL_API_KEY is not set");

    const auth = { Authorization: `Bearer ${key}` };
    switch (call.kind) {
      case "chat":
        return this.json(`${baseUrl}/chat/completions`, auth, {
          model: call.model,
          messages: call.messages,
          max_completion_tokens: call.maxOutputTokens,
          ...(call.jsonSchema && { response_format: { type: "json_schema", json_schema: call.jsonSchema } }),
        }, (body) => ({
          output: body?.choices?.[0]?.message?.content ?? undefined,
          units: body?.usage
            ? {
                kind: "chat",
                promptTokens: num(body.usage.prompt_tokens),
                cachedTokens: num(body.usage.prompt_tokens_details?.cached_tokens),
                completionTokens: num(body.usage.completion_tokens),
              }
            : null,
        }));

      case "transcribe": {
        const form = new FormData();
        form.append("request", JSON.stringify({
          model: call.model,
          audioEncoding: "WAV",
          mode: "PUSH_TO_TALK",
          ...(call.languageBias && { languageBias: call.languageBias }),
        }));
        form.append("audio", new Blob([new Uint8Array(call.audio)], { type: "audio/wav" }), "clip.wav");
        return this.send(`${baseUrl}/asr/transcribe`, { ...auth, Accept: "application/json" }, form, (body) => ({
          output: typeof body?.transcript === "string" ? body.transcript : undefined,
          units: typeof body?.audioDurationMs === "number" ? { kind: "transcribe", audioMs: body.audioDurationMs } : null,
        }));
      }

      case "image":
        return this.json(`${baseUrl}/images/generations`, auth, {
          model: call.model,
          prompt: call.prompt,
          n: call.n,
          response_format: "b64_json",
          output_format: "png",
          ...(call.size && { size: call.size }),
        }, (body) => {
          const data = Array.isArray(body?.data) ? body.data : null;
          return {
            output: data?.[0]?.b64_json,
            // Billed only for images generated and returned.
            units: data ? { kind: "image", images: data.length } : null,
          };
        });

      case "segment": {
        const dataUrl = `data:${call.mimeType};base64,${Buffer.from(call.image).toString("base64")}`;
        return this.json(`${baseUrl}/responses`, auth, {
          model: call.model,
          stream: false,
          input: [{
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: call.prompt },
              { type: "input_image", image_url: dataUrl },
            ],
          }],
        }, (body) => ({ output: responsesText(body), units: { kind: "segment", images: 1 } }));
      }
    }
  }

  private json(url: string, auth: Record<string, string>, payload: unknown, parse: Parser): Promise<DispatchResult> {
    return this.send(url, { ...auth, "Content-Type": "application/json" }, JSON.stringify(payload), parse);
  }

  private async send(url: string, headers: Record<string, string>, body: BodyInit, parse: Parser): Promise<DispatchResult> {
    const res = await this.fetchFn(url, { method: "POST", headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        retryable: res.status === 429 || res.status >= 500,
        // A rejected request reports no units; the gateway settles it at the reservation.
        units: null,
        errorBody: text.slice(0, ERROR_BODY_LIMIT),
      };
    }
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, status: res.status, retryable: false, units: null, errorBody: `non-JSON body: ${text.slice(0, ERROR_BODY_LIMIT)}` };
    }
    const { output, units } = parse(parsed);
    return { ok: true, status: res.status, retryable: false, units, output };
  }
}

type Parser = (body: any) => { output?: string; units: BillingUnits | null };

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

function responsesText(body: any): string | undefined {
  if (typeof body?.output_text === "string") return body.output_text;
  const parts: string[] = [];
  for (const item of Array.isArray(body?.output) ? body.output : []) {
    for (const c of Array.isArray(item?.content) ? item.content : []) {
      if (typeof c?.text === "string") parts.push(c.text);
    }
  }
  return parts.length ? parts.join("\n") : undefined;
}
