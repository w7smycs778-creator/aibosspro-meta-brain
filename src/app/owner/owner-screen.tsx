"use client";

import { useCallback, useEffect, useState } from "react";

type Mode = "AUTO" | "HUMAN" | "PAUSED";
type Turn = { id: string; seq: number; role: string; content: string; checkpoint: Record<string, any> | null };
type OwnerState = {
  business: { id: string; name: string } | null;
  businessName?: string;
  brain?: { version: number; approved: boolean; name: string } | null;
  approvedVersion?: number | null;
  conversations?: Array<{ id: string; channel: string; externalId: string; mode: Mode; state: string; lastCustomerMessage: string | null }>;
  approvals?: Array<{ id: string; conversationId: string | null; booking: null | { serviceName: string; when: string; customerName: string | null; customerContact: string | null } }>;
  bookings?: Array<{ id: string; serviceName: string; when: string; status: string; customerName: string | null }>;
};
type PanelMessage = { who: "customer" | "assistant" | "owner"; text: string; outcome?: string; trace?: Turn[] };

const MODES: Mode[] = ["AUTO", "HUMAN", "PAUSED"];

async function post(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

export function OwnerScreen() {
  const [state, setState] = useState<OwnerState | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [panelConversationId, setPanelConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<PanelMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [ownerDrafts, setOwnerDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setState(await (await fetch("/api/owner/state")).json());
  }, []);

  useEffect(() => {
    setSessionId(`panel-${crypto.randomUUID()}`);
    void refresh();
  }, [refresh]);

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setDraft("");
    setMessages((m) => [...m, { who: "customer", text }]);
    try {
      const r = await post("/api/panel/message", { sessionId, eventId: crypto.randomUUID(), text });
      if (r.conversationId) setPanelConversationId(r.conversationId);
      setMessages((m) => [
        ...m,
        { who: "assistant", text: r.replyText ?? r.error ?? "(no reply: conversation is paused or with the owner)", outcome: r.outcome, trace: r.trace },
      ]);
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  async function decide(id: string, decision: "approve" | "reject", conversationId: string | null) {
    const r = await post(`/api/approvals/${id}/${decision}`);
    if (r.replyText && conversationId && conversationId === panelConversationId) {
      setMessages((m) => [...m, { who: "owner", text: `${decision === "reject" ? "Draft: " : ""}${r.replyText}` }]);
    }
    await refresh();
  }

  async function sendAsOwner(id: string) {
    const text = (ownerDrafts[id] ?? "").trim();
    if (!text) return;
    const r = await post(`/api/conversations/${id}/owner-message`, { text });
    if (r.turn) {
      setOwnerDrafts((d) => ({ ...d, [id]: "" }));
      if (id === panelConversationId) setMessages((m) => [...m, { who: "owner", text: `Owner: ${text}` }]);
    }
    await refresh();
  }

  async function switchMode(id: string, mode: Mode) {
    await post(`/api/conversations/${id}/mode`, { mode });
    await refresh();
  }

  async function reset() {
    await post("/api/admin/reset");
    setSessionId(`panel-${crypto.randomUUID()}`);
    setPanelConversationId(null);
    setMessages([]);
    await refresh();
  }

  return (
    <main className="grid min-h-screen grid-cols-1 gap-4 bg-gray-50 p-4 text-sm text-gray-900 lg:grid-cols-2">
      <section className="space-y-4">
        <div className="rounded border bg-white p-3">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-semibold">{state?.business ? state.businessName ?? state.business.name : "No business yet"}</h1>
            <span className="space-x-2">
              <a href="/onboard" className="rounded border px-2 py-1 hover:bg-gray-100">
                Onboarding / brain review
              </a>
              <button onClick={reset} className="rounded border px-2 py-1 hover:bg-gray-100">
                Reset demo data
              </button>
            </span>
          </div>
          {state?.brain ? (
            <p className="mt-1 text-gray-600">
              Brain v{state.brain.version} · {state.brain.approved ? "approved" : "not approved"}
              {state.approvedVersion && state.approvedVersion !== state.brain.version ? ` · engine uses v${state.approvedVersion}` : ""}
            </p>
          ) : (
            <p className="mt-1 text-gray-600">Press Reset to seed the synthetic business.</p>
          )}
        </div>

        <div className="rounded border bg-white p-3">
          <h2 className="mb-2 font-semibold">Pending approvals</h2>
          {!state?.approvals?.length && <p className="text-gray-500">None.</p>}
          <ul className="space-y-2">
            {state?.approvals?.map((a) => (
              <li key={a.id} className="flex items-center justify-between rounded border p-2">
                <span>
                  {a.booking ? `${a.booking.serviceName} · ${a.booking.when} · ${a.booking.customerName ?? "?"} (${a.booking.customerContact ?? "?"})` : a.id}
                </span>
                <span className="space-x-2">
                  <button onClick={() => decide(a.id, "approve", a.conversationId)} className="rounded bg-green-600 px-2 py-1 text-white">
                    Approve
                  </button>
                  <button onClick={() => decide(a.id, "reject", a.conversationId)} className="rounded bg-red-600 px-2 py-1 text-white">
                    Reject
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded border bg-white p-3">
          <h2 className="mb-2 font-semibold">Conversations</h2>
          {!state?.conversations?.length && <p className="text-gray-500">None.</p>}
          <ul className="space-y-2">
            {state?.conversations?.map((c) => (
              <li key={c.id} className="rounded border p-2">
                <div className="flex items-center justify-between">
                  <span>
                    {c.channel} · {c.state}
                    {c.id === panelConversationId ? " · this panel" : ""}
                  </span>
                  <span className="space-x-1">
                    {MODES.map((m) => (
                      <button
                        key={m}
                        onClick={() => switchMode(c.id, m)}
                        className={`rounded border px-2 py-0.5 ${c.mode === m ? "bg-gray-900 text-white" : "hover:bg-gray-100"}`}
                      >
                        {m}
                      </button>
                    ))}
                  </span>
                </div>
                {c.lastCustomerMessage && <p className="mt-1 truncate text-gray-500">Last: {c.lastCustomerMessage}</p>}
                <form
                  className="mt-2 flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void sendAsOwner(c.id);
                  }}
                >
                  <input
                    value={ownerDrafts[c.id] ?? ""}
                    onChange={(e) => setOwnerDrafts((d) => ({ ...d, [c.id]: e.target.value }))}
                    placeholder="Reply as the owner (switches to HUMAN)"
                    className="flex-1 rounded border px-2 py-1"
                  />
                  <button className="rounded border px-2 py-1 hover:bg-gray-100">Send as owner</button>
                </form>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded border bg-white p-3">
          <h2 className="mb-2 font-semibold">Bookings</h2>
          {!state?.bookings?.length && <p className="text-gray-500">None.</p>}
          <ul className="space-y-1">
            {state?.bookings?.map((b) => (
              <li key={b.id}>
                {b.serviceName} · {b.when} · {b.customerName ?? "?"} · <span className="font-mono">{b.status.toUpperCase()}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="flex flex-col rounded border bg-white p-3">
        <h2 className="mb-2 font-semibold">Customer panel</h2>
        <div className="flex-1 space-y-2 overflow-y-auto">
          {messages.map((m, i) => (
            <div key={i} className={m.who === "customer" ? "text-right" : ""}>
              <div
                className={`inline-block max-w-[85%] whitespace-pre-wrap rounded px-3 py-2 text-left ${
                  m.who === "customer" ? "bg-blue-600 text-white" : m.who === "owner" ? "bg-amber-100" : "bg-gray-100"
                }`}
              >
                {m.text}
              </div>
              {m.trace && m.trace.length > 1 && <Trace turns={m.trace} outcome={m.outcome} />}
            </div>
          ))}
        </div>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Write as the customer"
            className="flex-1 rounded border px-2 py-1"
          />
          <button disabled={busy || !sessionId} className="rounded bg-blue-600 px-3 py-1 text-white disabled:opacity-50">
            {busy ? "..." : "Send"}
          </button>
        </form>
      </section>
    </main>
  );
}

function Trace({ turns, outcome }: { turns: Turn[]; outcome?: string }) {
  return (
    <details className="mt-1 text-xs text-gray-600">
      <summary className="cursor-pointer">Tool trace ({outcome})</summary>
      <ol className="mt-1 space-y-1 border-l pl-3">
        {turns
          .filter((t) => t.role !== "customer")
          .map((t) => (
            <li key={t.id} className="font-mono">
              {describe(t)}
            </li>
          ))}
      </ol>
    </details>
  );
}

function describe(t: Turn): string {
  const cp = t.checkpoint ?? {};
  switch (cp.kind) {
    case "tool_call":
      return `model -> ${(cp.toolCalls ?? []).map((c: any) => `${c.name}(${JSON.stringify(c.arguments)})`).join(", ")}`;
    case "tool_result":
      return `tool ${cp.toolCall?.name}: ${cp.result?.ok ? "ok" : `error: ${cp.result?.error}`} ${cp.result?.ok ? JSON.stringify(cp.result.output).slice(0, 160) : ""}`;
    case "tool_refused":
      return `REFUSED ${cp.toolCall?.name} (permitted: ${(cp.permitted ?? []).join(", ")})`;
    case "verifier":
      return `verifier ${cp.target}: ${cp.pass ? "PASS" : "BLOCK"} ${(cp.checks ?? [])
        .map((c: any) => `[${c.inconclusive ? "?" : c.pass ? "ok" : "x"} ${c.rule} "${c.claim}"${c.detail ? `: ${c.detail}` : ""}]`)
        .join(" ")}`;
    case "invalid_output":
      return `invalid model output: ${cp.error}`;
    case "owner_help":
      return `owner help: ${cp.reason} ${cp.detail ?? ""}`;
    default:
      return `${cp.kind ?? t.role}: ${t.content.slice(0, 160)}`;
  }
}
