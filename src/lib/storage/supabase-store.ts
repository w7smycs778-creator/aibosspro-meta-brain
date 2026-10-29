// Postgres store through Supabase with the service-role key. Server only: the
// key bypasses RLS, so this module must never be imported by client code.
// Tables and ledger functions: supabase/migrations/ (20261027120000 through 20261029220000).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import type { Env } from "../gateway/types";
import type { LedgerLimits, LedgerSnapshot, ReserveRequest, ReserveResult, SpendUsage } from "../gateway/ledger";
import type { NanoUsd } from "../gateway/money";
import { SEED_BRAIN, SEED_BUSINESS_ID } from "./seed";
import { SlotTakenError, StorageConfigError } from "./errors";
import { upgradeBrain } from "./brain";
import { bookingPayload } from "./payload";
import type {
  Booking,
  BrainSource,
  BrainVersion,
  Business,
  BusinessBrain,
  Channel,
  Creative,
  CreativePatch,
  NewCreative,
  Conversation,
  ConversationMode,
  ConversationState,
  NewApproval,
  NewBookingRequest,
  NewConversation,
  NewTurn,
  PendingApproval,
  SpendEntry,
  Storage,
  Turn,
} from "./types";

type Row = Record<string, any>;

/** Throws the PostgREST error with its message; never includes request headers. */
function check<T>(res: { data: T; error: { message: string; code?: string } | null }, what: string): T {
  if (res.error) throw new Error(`supabase ${what} failed: ${res.error.code ?? ""} ${res.error.message}`.trim());
  return res.data;
}

/**
 * Realtime is never used. supabase-js builds its realtime client on construction
 * and throws on Node 20, which has no native WebSocket; a transport that is
 * never constructed avoids that (Vercel runs Node 24 and is unaffected).
 */
class NoRealtimeTransport {
  constructor() {
    throw new Error("Supabase realtime is not used by Meta Brain");
  }
}

export class SupabaseStore implements Storage {
  readonly backend = "supabase" as const;

  private constructor(private readonly db: SupabaseClient) {}

  /** fetchImpl is for tests; production uses the global fetch. */
  static fromEnv(env: Env = process.env, fetchImpl?: typeof fetch): SupabaseStore {
    if (typeof window !== "undefined") throw new StorageConfigError("SupabaseStore is server only");
    const url = env.SUPABASE_URL;
    const key = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !url.startsWith("https://")) throw new StorageConfigError("SUPABASE_URL is missing or not https");
    if (!key) throw new StorageConfigError("SUPABASE_SERVICE_ROLE_KEY is not set");
    return new SupabaseStore(
      createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        realtime: { transport: NoRealtimeTransport as never },
        ...(fetchImpl && { global: { fetch: fetchImpl } }),
      }),
    );
  }

  // A GET, not a HEAD: PostgREST answers HEAD on a missing table with 204 and
  // no error, which made an unmigrated project look reachable (2026-10-29).
  async ping(): Promise<void> {
    check(await this.db.from("model_spend_reservations").select("id").limit(1), "ping");
  }

  async isDurable(): Promise<boolean> {
    try {
      await this.ping();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {}

  async reset(seed: BusinessBrain = SEED_BRAIN): Promise<{ businessId: string }> {
    // Cascades to brains, conversations, turns, approvals and bookings.
    check(await this.db.from("businesses").delete().neq("id", ""), "reset delete");
    const at = new Date().toISOString();
    check(
      await this.db.from("businesses").insert({ id: SEED_BUSINESS_ID, name: seed.name, created_at: at, whatsapp_default_mode: "AUTO" }),
      "reset business",
    );
    check(
      await this.db
        .from("brain_versions")
        .insert({ business_id: SEED_BUSINESS_ID, version: 1, brain: seed, approved: true, created_at: at, approved_at: at, source_kind: "seed" }),
      "reset brain",
    );
    return { businessId: SEED_BUSINESS_ID };
  }

  async getBusiness(id: string): Promise<Business | null> {
    const r = check(await this.db.from("businesses").select("*").eq("id", id).maybeSingle(), "getBusiness") as Row | null;
    return r ? { id: r.id, name: r.name, createdAt: r.created_at, whatsappDefaultMode: r.whatsapp_default_mode ?? "HUMAN" } : null;
  }

  async updateBusinessSettings(id: string, settings: { whatsappDefaultMode: ConversationMode }): Promise<Business> {
    check(await this.db.from("businesses").update({ whatsapp_default_mode: settings.whatsappDefaultMode }).eq("id", id), "updateBusinessSettings");
    const b = await this.getBusiness(id);
    if (!b) throw new Error(`business ${id} not found`);
    return b;
  }

  async createCreative(input: NewCreative): Promise<Creative> {
    const r = check(
      await this.db
        .from("creatives")
        .insert({
          id: randomUUID(),
          business_id: input.businessId,
          offer_id: input.offerId,
          offer: input.offer,
          brain_version: input.brainVersion,
          status: "pending_approval",
          caption: input.caption,
          caption_log: input.captionLog,
          media: input.media,
          cutout_kind: input.cutoutKind,
          scene_kind: input.sceneKind,
          diagnostics: input.diagnostics,
        })
        .select()
        .single(),
      "createCreative",
    );
    return toCreative(r);
  }

  async getCreative(id: string): Promise<Creative | null> {
    const r = check(await this.db.from("creatives").select("*").eq("id", id).maybeSingle(), "getCreative");
    return r ? toCreative(r) : null;
  }

  async listCreatives(businessId: string): Promise<Creative[]> {
    const rows = check(await this.db.from("creatives").select("*").eq("business_id", businessId).order("created_at", { ascending: false }), "listCreatives");
    return (rows as Row[]).map(toCreative);
  }

  async updateCreativeCaption(id: string, caption: string, captionLog: Record<string, unknown> | null): Promise<Creative> {
    const rows = check(
      await this.db.from("creatives").update({ caption, caption_log: captionLog }).eq("id", id).eq("status", "pending_approval").select(),
      "updateCreativeCaption",
    ) as Row[];
    if (rows.length === 0) throw new Error(`creative ${id} is not pending approval`);
    return toCreative(rows[0]);
  }

  async updateCreative(id: string, patch: CreativePatch): Promise<Creative> {
    const row: Record<string, unknown> = {};
    if (patch.media !== undefined) row.media = patch.media;
    if (patch.cutoutKind !== undefined) row.cutout_kind = patch.cutoutKind;
    if (patch.sceneKind !== undefined) row.scene_kind = patch.sceneKind;
    if (patch.diagnostics !== undefined) row.diagnostics = patch.diagnostics;
    if (patch.caption !== undefined) row.caption = patch.caption;
    if (patch.captionLog !== undefined) row.caption_log = patch.captionLog;
    const rows = check(await this.db.from("creatives").update(row).eq("id", id).eq("status", "pending_approval").select(), "updateCreative") as Row[];
    if (rows.length === 0) throw new Error(`creative ${id} is not pending approval`);
    return toCreative(rows[0]);
  }

  async decideCreative(id: string, decision: "approved" | "rejected"): Promise<{ creative: Creative; changed: boolean }> {
    const rows = check(
      await this.db
        .from("creatives")
        .update({ status: decision, decided_at: new Date().toISOString() })
        .eq("id", id)
        .eq("status", "pending_approval")
        .select(),
      "decideCreative",
    ) as Row[];
    if (rows.length) return { creative: toCreative(rows[0]), changed: true };
    const current = await this.getCreative(id);
    if (!current) throw new Error(`creative ${id} not found`);
    return { creative: current, changed: false };
  }

  async addBrainVersion(businessId: string, brain: BusinessBrain, source?: BrainSource): Promise<BrainVersion> {
    const latest = await this.getBrain(businessId);
    const r = check(
      await this.db
        .from("brain_versions")
        .insert({
          business_id: businessId,
          version: (latest?.version ?? 0) + 1,
          brain,
          approved: false,
          source_kind: source?.kind ?? null,
          source_text: source?.text ?? null,
          audio_path: source?.audioPath ?? null,
        })
        .select()
        .single(),
      "addBrainVersion",
    );
    return toBrain(r);
  }

  async updateBrainDraft(businessId: string, version: number, brain: BusinessBrain): Promise<BrainVersion> {
    const rows = check(
      await this.db
        .from("brain_versions")
        .update({ brain })
        .eq("business_id", businessId)
        .eq("version", version)
        .eq("approved", false)
        .select(),
      "updateBrainDraft",
    ) as Row[];
    if (rows.length === 0) throw new Error(`brain version ${version} is not an unapproved draft of ${businessId}`);
    return toBrain(rows[0]);
  }

  async deleteBrainDraft(businessId: string, version: number): Promise<boolean> {
    const rows = check(
      await this.db.from("brain_versions").delete().eq("business_id", businessId).eq("version", version).eq("approved", false).select(),
      "deleteBrainDraft",
    ) as Row[];
    return rows.length === 1;
  }

  async listBrainVersions(businessId: string): Promise<BrainVersion[]> {
    const rows = check(
      await this.db.from("brain_versions").select("*").eq("business_id", businessId).order("version", { ascending: false }),
      "listBrainVersions",
    );
    return (rows as Row[]).map(toBrain);
  }

  async approveBrainVersion(businessId: string, version: number): Promise<BrainVersion> {
    const r = check(
      await this.db
        .from("brain_versions")
        .update({ approved: true, approved_at: new Date().toISOString() })
        .eq("business_id", businessId)
        .eq("version", version)
        .select()
        .single(),
      "approveBrainVersion",
    );
    return toBrain(r);
  }

  async getBrain(businessId: string, opts: { approvedOnly?: boolean } = {}): Promise<BrainVersion | null> {
    let q = this.db.from("brain_versions").select("*").eq("business_id", businessId);
    if (opts.approvedOnly) q = q.eq("approved", true);
    const r = check(await q.order("version", { ascending: false }).limit(1).maybeSingle(), "getBrain");
    return r ? toBrain(r) : null;
  }

  async createConversation(input: NewConversation): Promise<Conversation> {
    const r = check(
      await this.db
        .from("conversations")
        .insert({
          id: randomUUID(),
          business_id: input.businessId,
          channel: input.channel,
          external_id: input.externalId,
          customer_ref: input.customerRef,
          mode: input.mode ?? "HUMAN",
          state: "active",
        })
        .select()
        .single(),
      "createConversation",
    );
    return toConversation(r);
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const r = check(await this.db.from("conversations").select("*").eq("id", id).maybeSingle(), "getConversation");
    return r ? toConversation(r) : null;
  }

  async findConversation(businessId: string, channel: Channel, externalId: string): Promise<Conversation | null> {
    const r = check(
      await this.db
        .from("conversations")
        .select("*")
        .eq("business_id", businessId)
        .eq("channel", channel)
        .eq("external_id", externalId)
        .maybeSingle(),
      "findConversation",
    );
    return r ? toConversation(r) : null;
  }

  async listConversations(businessId: string): Promise<Conversation[]> {
    const rows = check(
      await this.db.from("conversations").select("*").eq("business_id", businessId).order("updated_at", { ascending: false }),
      "listConversations",
    );
    return (rows as Row[]).map(toConversation);
  }

  async updateConversation(id: string, patch: { mode?: ConversationMode; state?: ConversationState }): Promise<Conversation> {
    const r = check(
      await this.db
        .from("conversations")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", id)
        .select()
        .single(),
      "updateConversation",
    );
    return toConversation(r);
  }

  async appendTurn(input: NewTurn): Promise<Turn> {
    const r = check(
      await this.db
        .from("turns")
        .insert({
          id: randomUUID(),
          conversation_id: input.conversationId,
          role: input.role,
          content: input.content,
          checkpoint: input.checkpoint ?? null,
        })
        .select()
        .single(),
      "appendTurn",
    );
    return toTurn(r);
  }

  async listTurns(conversationId: string): Promise<Turn[]> {
    const rows = check(await this.db.from("turns").select("*").eq("conversation_id", conversationId).order("seq"), "listTurns");
    return (rows as Row[]).map(toTurn);
  }

  async requestBooking(input: NewBookingRequest): Promise<{ booking: Booking; approval: PendingApproval; existing: boolean }> {
    const prior = input.idempotencyKey ? await this.bookingByKey(input.idempotencyKey) : null;
    if (prior) return prior;
    const approval = await this.createApproval({
      businessId: input.businessId,
      conversationId: input.conversationId,
      kind: "booking",
      payload: bookingPayload(input),
    });
    const res = await this.db
      .from("bookings")
      .insert({
        id: randomUUID(),
        business_id: input.businessId,
        conversation_id: input.conversationId,
        service_id: input.serviceId,
        customer_ref: input.customerRef,
        customer_name: input.customerName ?? null,
        customer_contact: input.customerContact ?? null,
        starts_at: input.startsAt,
        status: "pending_approval",
        approval_id: approval.id,
        price_cents: input.priceCents ?? null,
        currency: input.currency ?? null,
        discount_id: input.discountId ?? null,
        idempotency_key: input.idempotencyKey ?? null,
      })
      .select()
      .single();
    if (res.error) {
      // No orphan approval for a booking that was never written.
      await this.db.from("approvals").delete().eq("id", approval.id);
      if (res.error.code === "23505") {
        // A concurrent request with the same key won the race: return its booking.
        const winner = input.idempotencyKey ? await this.bookingByKey(input.idempotencyKey) : null;
        if (winner) return winner;
        if (/active_slot/.test(res.error.message)) throw new SlotTakenError(input.startsAt);
      }
    }
    return { booking: toBooking(check(res, "requestBooking")), approval, existing: false };
  }

  private async bookingByKey(key: string): Promise<{ booking: Booking; approval: PendingApproval; existing: true } | null> {
    const row = check(await this.db.from("bookings").select("*").eq("idempotency_key", key).maybeSingle(), "bookingByKey") as Row | null;
    if (!row) return null;
    const approval = (await this.getApproval(row.approval_id))!;
    return { booking: toBooking(row), approval, existing: true };
  }


  async createApproval(input: NewApproval): Promise<PendingApproval> {
    const r = check(
      await this.db
        .from("approvals")
        .insert({
          id: randomUUID(),
          business_id: input.businessId,
          conversation_id: input.conversationId,
          kind: input.kind,
          payload: input.payload,
          status: "pending",
        })
        .select()
        .single(),
      "createApproval",
    );
    return toApproval(r);
  }

  async getApproval(id: string): Promise<PendingApproval | null> {
    const r = check(await this.db.from("approvals").select("*").eq("id", id).maybeSingle(), "getApproval");
    return r ? toApproval(r) : null;
  }

  async decideApproval(id: string, decision: "approved" | "rejected"): Promise<{ approval: PendingApproval; changed: boolean }> {
    const rows = check(
      await this.db
        .from("approvals")
        .update({ status: decision, decided_at: new Date().toISOString() })
        .eq("id", id)
        .eq("status", "pending")
        .select(),
      "decideApproval",
    ) as Row[];
    if (rows.length === 0) {
      const current = await this.getApproval(id);
      if (!current) throw new Error(`approval ${id} not found`);
      return { approval: current, changed: false };
    }
    check(
      await this.db
        .from("bookings")
        .update({ status: decision === "approved" ? "confirmed" : "rejected" })
        .eq("approval_id", id)
        .eq("status", "pending_approval"),
      "decideApproval booking",
    );
    return { approval: toApproval(rows[0]), changed: true };
  }

  async listPendingApprovals(businessId: string): Promise<PendingApproval[]> {
    const rows = check(
      await this.db.from("approvals").select("*").eq("business_id", businessId).eq("status", "pending").order("created_at"),
      "listPendingApprovals",
    );
    return (rows as Row[]).map(toApproval);
  }

  async listBookings(businessId: string): Promise<Booking[]> {
    const rows = check(await this.db.from("bookings").select("*").eq("business_id", businessId).order("created_at"), "listBookings");
    return (rows as Row[]).map(toBooking);
  }

  async reserveSpend(req: ReserveRequest, limits: LedgerLimits): Promise<ReserveResult> {
    const data = check(
      await this.db.rpc("reserve_model_spend", {
        p_amount_nano: req.amountNano,
        p_model: req.model,
        p_hard_cap_nano: limits.hardCapNano,
        p_credit_balance_nano: limits.creditBalanceNano,
        p_buffer_nano: limits.bufferNano,
        p_run_id: req.runId ?? null,
        p_run_cap_nano: req.runCapNano ?? null,
        p_business_id: req.businessId ?? null,
        p_turn_id: req.turnId ?? null,
      }),
      "reserve_model_spend",
    );
    const r = (Array.isArray(data) ? data[0] : data) as Row | null;
    if (r?.reservation_id) return { granted: true, reservationId: r.reservation_id };
    const reason = r?.deny_reason;
    if (reason === "hard_cap_reached" || reason === "run_cap_reached" || reason === "insufficient_credit") {
      return { granted: false, reason, detail: `committed ${r?.committed_nano} + ${req.amountNano} (ledger sum)` };
    }
    throw new Error("reserve_model_spend returned neither a reservation nor a deny reason");
  }

  async settleSpend(reservationId: string, actualNano: NanoUsd, usage: SpendUsage): Promise<void> {
    check(
      await this.db.rpc("settle_model_spend", {
        p_reservation_id: reservationId,
        p_actual_nano: actualNano,
        p_tokens_in: usage.tokensIn,
        p_tokens_out: usage.tokensOut,
        p_finish_reason: usage.finishReason ?? null,
        p_reasoning_tokens: usage.reasoningTokens ?? null,
        p_usage_raw: usage.usageRaw ?? null,
      }),
      "settle_model_spend",
    );
  }

  async releaseSpend(reservationId: string): Promise<void> {
    check(await this.db.rpc("release_model_spend", { p_reservation_id: reservationId }), "release_model_spend");
  }

  async spendTotals(runId?: string): Promise<LedgerSnapshot> {
    const data = check(await this.db.rpc("model_spend_totals", { p_run_id: runId ?? null }), "model_spend_totals");
    const r = (Array.isArray(data) ? data[0] : data) as Row;
    return {
      settledNano: Number(r.settled_nano),
      reservedNano: Number(r.reserved_nano),
      runSettledNano: Number(r.run_settled_nano),
      runReservedNano: Number(r.run_reserved_nano),
    };
  }

  async listSpend(): Promise<SpendEntry[]> {
    const rows = check(await this.db.from("model_spend_reservations").select("*").order("created_at"), "listSpend");
    return (rows as Row[]).map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      model: r.model,
      runId: r.run_id ?? null,
      businessId: r.business_id ?? null,
      turnId: r.turn_id ?? null,
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
      reservedNano: Number(r.reserved_nano),
      settledNano: r.settled_nano === null ? null : Number(r.settled_nano),
      state: r.state,
      finishReason: r.finish_reason ?? null,
      reasoningTokens: r.reasoning_tokens ?? null,
      usageRaw: r.usage_raw ?? null,
    }));
  }

  async claimEvent(source: string, eventId: string): Promise<boolean> {
    const rows = check(
      await this.db
        .from("processed_events")
        .upsert({ source, event_id: eventId }, { onConflict: "source,event_id", ignoreDuplicates: true })
        .select(),
      "claimEvent",
    ) as Row[];
    return rows.length === 1;
  }
}

function toCreative(r: Row): Creative {
  return {
    id: r.id,
    businessId: r.business_id,
    offerId: r.offer_id,
    offer: r.offer,
    brainVersion: r.brain_version,
    status: r.status,
    caption: r.caption,
    captionLog: r.caption_log ?? null,
    media: r.media,
    cutoutKind: r.cutout_kind,
    sceneKind: r.scene_kind,
    diagnostics: r.diagnostics,
    createdAt: r.created_at,
    decidedAt: r.decided_at ?? null,
  };
}

function toBrain(r: Row): BrainVersion {
  return {
    businessId: r.business_id,
    version: r.version,
    brain: upgradeBrain(r.brain),
    approved: r.approved,
    createdAt: r.created_at,
    approvedAt: r.approved_at ?? null,
    source: r.source_kind ? { kind: r.source_kind, text: r.source_text ?? null, audioPath: r.audio_path ?? null } : null,
  };
}

function toConversation(r: Row): Conversation {
  return {
    id: r.id,
    businessId: r.business_id,
    channel: r.channel,
    externalId: r.external_id,
    customerRef: r.customer_ref,
    mode: r.mode,
    state: r.state,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toTurn(r: Row): Turn {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    seq: Number(r.seq),
    role: r.role,
    content: r.content,
    checkpoint: r.checkpoint ?? null,
    createdAt: r.created_at,
  };
}

function toApproval(r: Row): PendingApproval {
  return {
    id: r.id,
    businessId: r.business_id,
    conversationId: r.conversation_id ?? null,
    kind: r.kind,
    payload: r.payload,
    status: r.status,
    createdAt: r.created_at,
    decidedAt: r.decided_at ?? null,
  };
}

function toBooking(r: Row): Booking {
  return {
    id: r.id,
    businessId: r.business_id,
    conversationId: r.conversation_id ?? null,
    serviceId: r.service_id,
    customerRef: r.customer_ref,
    customerName: r.customer_name ?? null,
    customerContact: r.customer_contact ?? null,
    startsAt: r.starts_at,
    status: r.status,
    approvalId: r.approval_id ?? null,
    createdAt: r.created_at,
    priceCents: r.price_cents ?? null,
    currency: r.currency ?? null,
    discountId: r.discount_id ?? null,
    idempotencyKey: r.idempotency_key ?? null,
  };
}
