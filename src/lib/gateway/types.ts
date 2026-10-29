import type { NanoUsd } from "./money";

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCallRequest[] }
  | { role: "tool"; toolCallId: string; content: string };

/** JSON Schema subset accepted for tool parameters: flat objects of primitives. */
export type JsonSchemaProperty = {
  type: "string" | "number" | "integer" | "boolean";
  description?: string;
  enum?: Array<string | number>;
};

export type JsonSchemaObject = {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
};

/** A tool call the model asks for. */
export type ToolCallRequest = { id: string; name: string; arguments: Record<string, unknown> };

/** What the engine sends back to the model for one tool call. */
export type ToolCallResult = { callId: string; name: string; ok: boolean; output?: unknown; error?: string };

export type JsonSchemaFormat = {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
};

type CallBase = {
  model: string;
  /** 1-based agent round within one conversation turn. */
  round?: number;
  /** Ledger attribution. */
  businessId?: string;
  turnId?: string;
};

export type ChatCall = CallBase & {
  kind: "chat";
  messages: ChatMessage[];
  maxOutputTokens: number;
  jsonSchema?: JsonSchemaFormat;
  /** Tools the model may call; only those permitted for the conversation. */
  tools?: ToolDefinition[];
};

export type TranscribeCall = CallBase & {
  kind: "transcribe";
  /** Mono integer PCM WAV, 16 or 24 kHz. */
  audio: Uint8Array;
  languageBias?: string[];
};

export type ImageCall = CallBase & {
  kind: "image";
  prompt: string;
  n: number;
  size?: string;
};

export type SegmentCall = CallBase & {
  kind: "segment";
  /** Noun phrase naming the object to segment. */
  prompt: string;
  image: Uint8Array;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
};

export type ModelCall = ChatCall | TranscribeCall | ImageCall | SegmentCall;

/** Billable units reported by the provider for one attempt. */
export type BillingUnits =
  | { kind: "chat"; promptTokens: number; cachedTokens: number; completionTokens: number }
  | { kind: "transcribe"; audioMs: number }
  | { kind: "image"; images: number }
  | { kind: "segment"; images: number };

export type DispatchResult = {
  ok: boolean;
  status: number;
  /** Safe to retry (rate limit, 5xx, network). */
  retryable: boolean;
  /** null when the provider did not report billable units. */
  units: BillingUnits | null;
  output?: string;
  toolCalls?: ToolCallRequest[];
  /** The model answered, but not in the tool protocol; output holds the raw text. */
  protocolError?: string;
  errorBody?: string;
};

export interface Dispatcher {
  /** Checks run once per gateway call, before any reservation or request. */
  preflight?(): Promise<void>;
  dispatch(call: ModelCall): Promise<DispatchResult>;
}

export type DenyReason =
  | "unknown_cost"
  | "bounds_exceeded"
  | "hard_cap_reached"
  | "run_cap_reached"
  | "insufficient_credit"
  | "live_credits_not_verified"
  | "hosted_inference_blocked"
  | "dispatcher_not_configured";

export type AttemptRecord = {
  attempt: number;
  status: number;
  reservedNano: NanoUsd;
  settledNano: NanoUsd;
  latencyMs: number;
};

export type GatewayResult =
  | {
      outcome: "ok" | "failed";
      model: string;
      status: number;
      output?: string;
      toolCalls?: ToolCallRequest[];
      protocolError?: string;
      errorBody?: string;
      attempts: AttemptRecord[];
      reservedNano: NanoUsd;
      settledNano: NanoUsd;
      latencyMs: number;
    }
  | {
      outcome: "denied";
      model: string;
      reason: DenyReason;
      detail: string;
      attempts: AttemptRecord[];
      reservedNano: NanoUsd;
      settledNano: NanoUsd;
    };

/** Environment lookup; process.env satisfies it. */
export type Env = Readonly<Record<string, string | undefined>>;
