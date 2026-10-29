"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { sourceBox } from "@/lib/engine/display";

type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
const DAYS: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

type Service = { id: string; name: string; durationMin: number; priceCents: number; currency: string };
type Discount = {
  id: string;
  description: string;
  percentOff: number | null;
  amountOffCents: number | null;
  serviceIds: string[];
  weekdays: Weekday[];
  conditions: string;
};
type Brain = {
  name: string;
  timezone: string;
  languages: string[];
  tone: { adjectives: string[]; example: string };
  currency: string;
  services: Service[];
  hours: Record<Weekday, Array<[string, string]>>;
  discounts: Discount[];
  bookingPolicy: { approvalRequired: true };
  doNotSay: string[];
};
type Version = {
  version: number;
  approved: boolean;
  brain: Brain;
  createdAt: string;
  source: { kind: string; text: string | null; audioPath: string | null } | null;
};

async function call(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error([data.error, ...(data.errors ?? [])].filter(Boolean).join("; ") || `HTTP ${res.status}`);
  return data;
}

/** Any browser-decodable audio -> mono 16-bit PCM WAV at 16 kHz, the only format the transcription endpoint takes. */
async function toWav16k(blob: Blob): Promise<Blob> {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  await ctx.close();
  const rate = 16_000;
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const pcm = (await offline.startRendering()).getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  out.setUint32(4, 36 + pcm.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  str(36, "data");
  out.setUint32(40, pcm.length * 2, true);
  pcm.forEach((v, i) => out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
  return new Blob([out], { type: "audio/wav" });
}

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const slug = (name: string) => name.toLowerCase().replace(/\+/g, " and ").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "service";

export function Onboarding() {
  const [versions, setVersions] = useState<Version[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");
  const [recording, setRecording] = useState(false);
  const [edit, setEdit] = useState<Brain | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);

  const refresh = useCallback(async () => {
    const { versions } = await call("/api/brain", "GET");
    setVersions(versions);
    const draft = versions.find((v: Version) => !v.approved);
    setEdit(draft ? structuredClone(draft.brain) : null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const draft = versions.find((v) => !v.approved) ?? null;
  const approved = versions.find((v) => v.approved) ?? null;

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(true);
    setStatus(label);
    try {
      await fn();
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
      return;
    } finally {
      setBusy(false);
    }
  }

  async function fromAudio(blob: Blob) {
    await run("Converting audio to 16 kHz WAV...", async () => {
      const wav = await toWav16k(blob);
      setStatus("Transcribing with Meta Voice Transcribe...");
      const form = new FormData();
      form.append("audio", wav, "voice-note.wav");
      const res = await fetch("/api/onboard/transcribe", { method: "POST", body: form });
      const t = await res.json();
      if (!res.ok) throw new Error(t.error ?? `HTTP ${res.status}`);
      setStatus("Extracting the brain draft with Muse Spark...");
      await call("/api/onboard/extract", "POST", { text: t.transcript, sourceKind: "voice", audioPath: t.audioPath });
      await refresh();
      setStatus("Draft ready for review.");
    });
  }

  async function fromText() {
    await run("Extracting the brain draft with Muse Spark...", async () => {
      await call("/api/onboard/extract", "POST", { text: typed, sourceKind: "text" });
      await refresh();
      setStatus("Draft ready for review.");
    });
  }

  async function toggleRecording() {
    if (recording) {
      recorder.current?.stop();
      setRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunks.current = [];
      rec.ondataavailable = (e) => chunks.current.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void fromAudio(new Blob(chunks.current, { type: rec.mimeType }));
      };
      rec.start();
      recorder.current = rec;
      setRecording(true);
      setStatus("Recording... press Stop when done.");
    } catch (err) {
      setStatus(`Microphone unavailable: ${(err as Error).message}. Upload a file or type instead.`);
    }
  }

  function normalised(b: Brain): Brain {
    return { ...b, services: b.services.map((s) => ({ ...s, id: s.id || slug(s.name) })) };
  }

  const save = () => run("Saving edits...", async () => {
    await call(`/api/brain/${draft!.version}`, "PUT", { brain: normalised(edit!) });
    await refresh();
    setStatus("Edits saved.");
  });
  const approve = () => run("Approving...", async () => {
    await call(`/api/brain/${draft!.version}/approve`, "POST", { brain: normalised(edit!) });
    await refresh();
    setStatus(`Brain v${draft!.version} approved. The engine uses it from the next customer message.`);
  });
  const discard = () => run("Discarding...", async () => {
    await call(`/api/brain/${draft!.version}`, "DELETE");
    await refresh();
    setStatus("Draft discarded.");
  });

  const set = (patch: Partial<Brain>) => setEdit((e) => (e ? { ...e, ...patch } : e));

  return (
    <main className="min-h-screen space-y-4 bg-gray-50 p-4 text-sm text-gray-900">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Onboarding: tell Meta Brain how the business works</h1>
        <a href="/owner" className="underline">Owner screen</a>
      </div>
      <p className="text-gray-600">
        Approved brain: {approved ? `v${approved.version} (${approved.brain.name})` : "none"}
        {draft ? ` · draft v${draft.version} waiting for review` : ""}
      </p>

      <section className="grid gap-3 rounded border bg-white p-3 md:grid-cols-3">
        <div className="space-y-2">
          <h2 className="font-semibold">1. Record a voice note</h2>
          <button disabled={busy && !recording} onClick={toggleRecording} className={`rounded px-3 py-1 text-white ${recording ? "bg-red-600" : "bg-blue-600"} disabled:opacity-50`}>
            {recording ? "Stop" : "Record"}
          </button>
        </div>
        <div className="space-y-2">
          <h2 className="font-semibold">2. Or upload an audio file</h2>
          <input type="file" accept="audio/*" disabled={busy} onChange={(e) => e.target.files?.[0] && fromAudio(e.target.files[0])} />
        </div>
        <div className="space-y-2">
          <h2 className="font-semibold">3. Or type the rules</h2>
          <textarea value={typed} onChange={(e) => setTyped(e.target.value)} rows={5} className="w-full rounded border p-2" placeholder="Name, services with prices and durations, hours, discounts, tone..." />
          <button disabled={busy || !typed.trim()} onClick={fromText} className="rounded bg-blue-600 px-3 py-1 text-white disabled:opacity-50">
            Build draft
          </button>
        </div>
      </section>
      {status && <p className="rounded border bg-white p-2">{status}</p>}

      {draft && edit && (
        <section key={draft.version} className="grid gap-4 rounded border bg-white p-3 lg:grid-cols-[1fr_2fr]">
          <div>
            <h2 className="mb-1 font-semibold">{sourceBox(draft.version, draft.source).label}</h2>
            <pre className="whitespace-pre-wrap rounded bg-gray-100 p-2 text-xs">{sourceBox(draft.version, draft.source).text}</pre>
            {draft.source?.audioPath && <p className="mt-1 break-all text-xs text-gray-500">Audio: {draft.source.audioPath}</p>}
          </div>
          <div className="space-y-3">
            <h2 className="font-semibold">Draft brain v{draft.version}: review every field</h2>
            <div className="grid gap-2 md:grid-cols-3">
              <label>Business name<input className="w-full rounded border px-2 py-1" value={edit.name} onChange={(e) => set({ name: e.target.value })} /></label>
              <label>Time zone<input className="w-full rounded border px-2 py-1" value={edit.timezone} onChange={(e) => set({ timezone: e.target.value })} /></label>
              <label>Currency<input className="w-full rounded border px-2 py-1" value={edit.currency} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} /></label>
              <label>Languages (comma)<input className="w-full rounded border px-2 py-1" value={edit.languages.join(", ")} onChange={(e) => set({ languages: list(e.target.value) })} /></label>
              <label>Tone adjectives (3-5, comma)<input className="w-full rounded border px-2 py-1" value={edit.tone.adjectives.join(", ")} onChange={(e) => set({ tone: { ...edit.tone, adjectives: list(e.target.value) } })} /></label>
              <label>Tone example<input className="w-full rounded border px-2 py-1" value={edit.tone.example} onChange={(e) => set({ tone: { ...edit.tone, example: e.target.value } })} /></label>
            </div>

            <div>
              <h3 className="font-medium">Services</h3>
              <table className="w-full text-left">
                <thead><tr><th>Name</th><th>Price</th><th>Currency</th><th>Minutes</th><th>Id</th><th /></tr></thead>
                <tbody>
                  {edit.services.map((s, i) => {
                    const upd = (p: Partial<Service>) => set({ services: edit.services.map((x, j) => (j === i ? { ...x, ...p } : x)) });
                    return (
                      <tr key={i}>
                        <td><input className="w-full rounded border px-1" value={s.name} onChange={(e) => upd({ name: e.target.value })} /></td>
                        <td><input className="w-20 rounded border px-1" type="number" value={s.priceCents / 100} onChange={(e) => upd({ priceCents: Math.round(Number(e.target.value) * 100) })} /></td>
                        <td><input className="w-16 rounded border px-1" value={s.currency} onChange={(e) => upd({ currency: e.target.value.toUpperCase() })} /></td>
                        <td><input className="w-16 rounded border px-1" type="number" value={s.durationMin} onChange={(e) => upd({ durationMin: Number(e.target.value) })} /></td>
                        <td className="font-mono text-xs">{s.id || slug(s.name)}</td>
                        <td><button onClick={() => set({ services: edit.services.filter((_, j) => j !== i) })}>✕</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <button className="mt-1 underline" onClick={() => set({ services: [...edit.services, { id: "", name: "", priceCents: 0, durationMin: 30, currency: edit.currency }] })}>+ service</button>
            </div>

            <div>
              <h3 className="font-medium">Weekly hours (e.g. 09:00-18:00, 19:00-21:00; empty = closed)</h3>
              <div className="grid gap-1 md:grid-cols-2">
                {DAYS.map((d) => (
                  <label key={d} className="flex items-center gap-2">
                    <span className="w-10 uppercase">{d}</span>
                    <input
                      className="flex-1 rounded border px-1"
                      defaultValue={edit.hours[d].map(([o, c]) => `${o}-${c}`).join(", ")}
                      onBlur={(e) => set({ hours: { ...edit.hours, [d]: list(e.target.value).map((w) => w.split("-").map((t) => t.trim()) as [string, string]) } })}
                    />
                  </label>
                ))}
              </div>
            </div>

            <div>
              <h3 className="font-medium">Discount rules</h3>
              {edit.discounts.map((d, i) => {
                const upd = (p: Partial<Discount>) => set({ discounts: edit.discounts.map((x, j) => (j === i ? { ...x, ...p } : x)) });
                const isPct = d.percentOff !== null;
                return (
                  <div key={i} className="mb-1 grid gap-1 rounded border p-1 md:grid-cols-6">
                    <input className="rounded border px-1 md:col-span-2" value={d.description} onChange={(e) => upd({ description: e.target.value })} placeholder="Description" />
                    <select className="rounded border" value={isPct ? "pct" : "amount"} onChange={(e) => upd(e.target.value === "pct" ? { percentOff: (d.amountOffCents ?? 0) / 100, amountOffCents: null } : { amountOffCents: (d.percentOff ?? 0) * 100, percentOff: null })}>
                      <option value="pct">% off</option>
                      <option value="amount">amount off</option>
                    </select>
                    <input className="rounded border px-1" type="number" value={isPct ? (d.percentOff ?? 0) : (d.amountOffCents ?? 0) / 100} onChange={(e) => upd(isPct ? { percentOff: Number(e.target.value) } : { amountOffCents: Math.round(Number(e.target.value) * 100) })} />
                    <input className="rounded border px-1" value={d.serviceIds.join(", ")} onChange={(e) => upd({ serviceIds: list(e.target.value) })} placeholder="service ids (empty = all)" />
                    <input className="rounded border px-1" value={d.weekdays.join(", ")} onChange={(e) => upd({ weekdays: list(e.target.value) as Weekday[] })} placeholder="days (empty = all)" />
                    <input className="rounded border px-1 md:col-span-5" value={d.conditions} onChange={(e) => upd({ conditions: e.target.value })} placeholder="Other conditions" />
                    <button onClick={() => set({ discounts: edit.discounts.filter((_, j) => j !== i) })}>✕ remove</button>
                  </div>
                );
              })}
              <button className="underline" onClick={() => set({ discounts: [...edit.discounts, { id: `discount_${edit.discounts.length + 1}`, description: "", percentOff: 10, amountOffCents: null, serviceIds: [], weekdays: [], conditions: "" }] })}>+ discount</button>
            </div>

            <label className="block">Never say (one per line)
              <textarea className="w-full rounded border p-1" rows={3} value={edit.doNotSay.join("\n")} onChange={(e) => set({ doNotSay: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) })} />
            </label>
            <p className="text-gray-600">Booking policy: every booking needs the owner&apos;s approval (always, in this version).</p>

            <div className="flex gap-2">
              <button disabled={busy} onClick={approve} className="rounded bg-green-600 px-3 py-1 text-white disabled:opacity-50">Approve brain</button>
              <button disabled={busy} onClick={save} className="rounded border px-3 py-1 disabled:opacity-50">Save edits</button>
              <button disabled={busy} onClick={discard} className="rounded bg-red-600 px-3 py-1 text-white disabled:opacity-50">Discard</button>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
