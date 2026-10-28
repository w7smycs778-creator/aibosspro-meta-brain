// Parsing, dedupe and reply text for the WhatsApp webhook. No I/O here; the
// route verifies the signature, then sends replies after responding.

export const REPLY_PREFIX = "AIBOSSPRO Brain (AI assistant): I received your message. ";
export const ECHO_LIMIT = 200;

export type InboundText = { id: string; from: string; text: string };

/** Incoming text messages only; statuses and other message types are skipped. */
export function extractTextMessages(payload: unknown): InboundText[] {
  const out: InboundText[] = [];
  const p = payload as any;
  if (p?.object !== "whatsapp_business_account") return out;
  for (const entry of Array.isArray(p.entry) ? p.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field !== "messages") continue;
      for (const m of Array.isArray(change?.value?.messages) ? change.value.messages : []) {
        if (m?.type !== "text" || typeof m.id !== "string" || typeof m.from !== "string") continue;
        if (typeof m.text?.body !== "string") continue;
        out.push({ id: m.id, from: m.from, text: m.text.body });
      }
    }
  }
  return out;
}

/** Echo capped at ECHO_LIMIT characters, counted by code point. */
export function replyText(text: string): string {
  return REPLY_PREFIX + Array.from(text).slice(0, ECHO_LIMIT).join("");
}

/** Last 4 digits of a phone number, for logs. */
export function last4(phone: string): string {
  return phone.slice(-4);
}

/**
 * Best-effort in-memory dedupe on message id: per server instance, lost on
 * cold start. Durable dedupe replaces this later.
 */
export class MessageDedupe {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** True the first time an id is seen within the TTL, false after. */
  claim(id: string): boolean {
    const t = this.now();
    const at = this.seen.get(id);
    if (at !== undefined && t - at < this.ttlMs) return false;
    this.seen.delete(id);
    this.seen.set(id, t);
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value as string;
      this.seen.delete(oldest);
    }
    return true;
  }
}
