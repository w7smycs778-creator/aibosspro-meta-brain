// The only module that talks to the Meta Model API. It is constructed by
// createLiveGateway() and must never be called except through SpendGateway.
import { LiveCreditsNotVerifiedError, PreDispatchError } from "./errors";
import { assertLiveInferenceAllowed, type LedgerProbe } from "./live-gate";
import {
  decodeJsonMode,
  decodeNative,
  encodeJsonMode,
  encodeNative,
  jsonModeResponseFormat,
  toolMode,
  type DecodedStep,
} from "./tool-protocol";
import type { BillingUnits, ChatCall, DispatchResult, Dispatcher, Env, ModelCall, ToolCallRequest } from "./types";

type FetchFn = typeof fetch;

const REQUEST_TIMEOUT_MS = 120_000;

/** The raw chat usage object is logged once per process so its real keys are on record. */
let usageLogged = false;
const ERROR_BODY_LIMIT = 2_000;

export class MetaDispatcher implements Dispatcher {
  constructor(
    private readonly env: Env = process.env,
    private readonly fetchFn: FetchFn = fetch,
    private readonly ledgerStore?: LedgerProbe,
  ) {}

  /** Live inference gate (src/lib/gateway/live-gate.ts), run by the gateway before any reservation. */
  async preflight(): Promise<void> {
    await assertLiveInferenceAllowed(this.env, this.ledgerStore);
  }

  async dispatch(call: ModelCall): Promise<DispatchResult> {
    // Read at call time so the guard cannot be bypassed by early construction.
    if (this.env.LIVE_CREDITS_VERIFIED !== "true") throw new LiveCreditsNotVerifiedError();
    const baseUrl = this.env.MODEL_API_BASE_URL?.replace(/\/+$/, "");
    if (!baseUrl || !baseUrl.startsWith("https://")) {
      throw new PreDispatchError("dispatcher_not_configured", "MODEL_API_BASE_URL is missing or not https");
    }
    const key = this.env.MODEL_API_KEY;
    if (!key) throw new PreDispatchError("dispatcher_not_configured", "MODEL_API_KEY is not set");

    const auth = { Authorization: `Bearer ${key}` };
    switch (call.kind) {
      case "chat":
        return this.chat(`${baseUrl}/chat/completions`, auth, call);

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
        // The mask encoding is undocumented, so the whole output structure is kept for the parser.
        }, (body) => ({
          output: body?.output !== undefined ? JSON.stringify(body.output) : responsesText(body),
          units: { kind: "segment", images: 1 },
        }));
      }
    }
  }

  /** Chat, with tool calls carried per MODEL_TOOL_MODE when the call has tools. */
  private chat(url: string, auth: Record<string, string>, call: ChatCall): Promise<DispatchResult> {
    const mode = call.tools ? toolMode(this.env) : null;
    const base = {
      model: call.model,
      max_completion_tokens: call.maxOutputTokens,
      ...(call.reasoningEffort && { reasoning_effort: call.reasoningEffort }),
      ...(call.jsonSchema && { response_format: { type: "json_schema", json_schema: call.jsonSchema } }),
    };
    const payload =
      mode === "json"
        ? { ...base, messages: encodeJsonMode(call.messages, call.tools!), response_format: jsonModeResponseFormat(call.tools!) }
        : mode === "native"
          ? { ...base, ...encodeNative(call.messages, call.tools!) }
          : { ...base, messages: call.messages };
    return this.json(url, auth, payload, (body) => {
      const choice = body?.choices?.[0];
      const message = choice?.message;
      const content: string | undefined = message?.content ?? undefined;
      const usage = body?.usage;
      const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens;
      const units: BillingUnits | null = usage
        ? {
            kind: "chat",
            promptTokens: num(usage.prompt_tokens),
            cachedTokens: num(usage.prompt_tokens_details?.cached_tokens),
            completionTokens: num(usage.completion_tokens),
            ...(typeof reasoning === "number" && { reasoningTokens: num(reasoning) }),
          }
        : null;
      if (!usageLogged) {
        usageLogged = true;
        console.log("meta chat usage object (logged once):", JSON.stringify(usage ?? null), "finish_reason:", choice?.finish_reason ?? null);
      }
      const meta = { units, finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined, usageRaw: usage };
      if (!mode) return { output: content, ...meta };
      const step: DecodedStep = mode === "json" ? decodeJsonMode(content) : decodeNative(message);
      return step.ok
        ? { output: step.text, toolCalls: step.toolCalls, ...meta }
        : { output: content, protocolError: step.error, ...meta };
    });
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
    const { output, units, toolCalls, protocolError, finishReason, usageRaw } = parse(parsed);
    return { ok: true, status: res.status, retryable: false, units, output, toolCalls, protocolError, finishReason, usageRaw };
  }
}

type Parser = (body: any) => {
  output?: string;
  units: BillingUnits | null;
  toolCalls?: ToolCallRequest[];
  protocolError?: string;
  finishReason?: string;
  usageRaw?: unknown;
};

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
