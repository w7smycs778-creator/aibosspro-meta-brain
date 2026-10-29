"use client";

import { useCallback, useEffect, useState } from "react";

type Offer = { id: string; label: string };
type Check = { rule: string; claim: string; pass: boolean; detail?: string };
type Creative = {
  id: string;
  status: "pending_approval" | "approved" | "rejected";
  caption: string;
  captionLog: { attempts?: Array<{ text: string; pass: boolean; checks: Check[] }>; final?: string; ownerEdit?: { pass: boolean | null; checks: Check[] } } | null;
  offer: { label?: string };
  brainVersion: number;
  cutoutKind: string;
  sceneKind: string;
  createdAt: string;
};

const media = (id: string, file: string) => `/api/content/${id}/media/${file}`;

export function ContentSection() {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [creatives, setCreatives] = useState<Creative[]>([]);
  const [offerId, setOfferId] = useState("");
  const [object, setObject] = useState("main object");
  const [photo, setPhoto] = useState<File | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [captions, setCaptions] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    const r = await (await fetch("/api/content")).json();
    setOffers(r.offers ?? []);
    setCreatives(r.creatives ?? []);
    setOfferId((cur) => cur || r.offers?.[0]?.id || "");
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function generate() {
    if (!photo || !offerId) return;
    setBusy(true);
    setStatus("Cutting out the subject, generating the scene, composing and writing the caption...");
    try {
      const form = new FormData();
      form.append("photo", photo);
      form.append("offerId", offerId);
      form.append("object", object);
      const res = await fetch("/api/content", { method: "POST", body: form });
      const r = await res.json();
      setStatus(res.ok ? "Creative ready for approval." : `Error: ${r.error}`);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function act(id: string, action: "approve" | "reject") {
    await fetch(`/api/content/${id}/${action}`, { method: "POST" });
    await refresh();
  }

  async function saveCaption(id: string) {
    await fetch(`/api/content/${id}/caption`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ caption: captions[id] ?? "" }) });
    await refresh();
  }

  return (
    <div className="rounded border bg-white p-3">
      <h2 className="mb-2 font-semibold">Content</h2>
      <div className="grid gap-2 md:grid-cols-4">
        <input type="file" accept="image/jpeg,image/png" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
        <select className="rounded border px-1" value={offerId} onChange={(e) => setOfferId(e.target.value)}>
          {offers.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
        <input className="rounded border px-1" value={object} onChange={(e) => setObject(e.target.value)} placeholder="What to cut out (e.g. clippers)" />
        <button disabled={busy || !photo || !offerId} onClick={generate} className="rounded bg-blue-600 px-3 py-1 text-white disabled:opacity-50">
          {busy ? "Generating..." : "Generate"}
        </button>
      </div>
      {status && <p className="mt-2 text-gray-600">{status}</p>}

      <ul className="mt-3 space-y-4">
        {creatives.map((c) => {
          const lastChecks = c.captionLog?.ownerEdit?.checks ?? c.captionLog?.attempts?.at(-1)?.checks ?? [];
          return (
            <li key={c.id} className="rounded border p-2">
              <p className="mb-1 text-gray-600">
                {c.offer.label} · brain v{c.brainVersion} · cutout: {c.cutoutKind} · scene: {c.sceneKind} · <span className="font-mono">{c.status.toUpperCase()}</span>
              </p>
              <div className="flex flex-wrap gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={media(c.id, "feed.png")} alt="Feed 1080x1080" className="h-56 rounded border" />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={media(c.id, "story.png")} alt="Story 1080x1920" className="h-56 rounded border" />
              </div>
              <textarea
                className="mt-2 w-full rounded border p-1"
                rows={2}
                disabled={c.status !== "pending_approval"}
                value={captions[c.id] ?? c.caption}
                placeholder="No verified caption; write one."
                onChange={(e) => setCaptions((m) => ({ ...m, [c.id]: e.target.value }))}
              />
              <details className="text-xs text-gray-600">
                <summary>Caption check ({c.captionLog?.ownerEdit ? "owner edit" : c.captionLog?.final ?? "none"})</summary>
                <ul className="font-mono">
                  {lastChecks.map((k, i) => (
                    <li key={i}>{k.pass ? "ok" : "x"} {k.rule} &quot;{k.claim}&quot;{k.detail ? `: ${k.detail}` : ""}</li>
                  ))}
                </ul>
              </details>
              {c.status === "pending_approval" && (
                <div className="mt-2 flex gap-2">
                  <button onClick={() => saveCaption(c.id)} className="rounded border px-2 py-1">Save caption</button>
                  <button onClick={() => act(c.id, "approve")} className="rounded bg-green-600 px-2 py-1 text-white">Approve</button>
                  <button onClick={() => act(c.id, "reject")} className="rounded bg-red-600 px-2 py-1 text-white">Reject</button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
