// Parsing for the WhatsApp webhook. No I/O here; the route verifies the
// signature, dedupes through the store, then runs the engine after responding.

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

/** Last 4 digits of a phone number, for logs. */
export function last4(phone: string): string {
  return phone.slice(-4);
}
