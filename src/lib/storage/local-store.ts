// SQLite store for local runs and tests: one file under the data directory,
// survives restarts. better-sqlite3 is synchronous, and every write that must
// be atomic runs in an IMMEDIATE transaction, so concurrent callers in one
// process and separate processes on the same file are both serialised.
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import type { LedgerLimits, LedgerSnapshot, ReserveRequest, ReserveResult, SpendUsage } from "../gateway/ledger";
import type { NanoUsd } from "../gateway/money";
import { StorageConfigError } from "./errors";
import { upgradeBrain } from "./brain";
import { bookingPayload } from "./payload";
import { SEED_BRAIN, SEED_BUSINESS_ID } from "./seed";
import type {
  Booking,
  BrainSource,
  BrainVersion,
  Business,
  BusinessBrain,
  Channel,
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

export const LOCAL_DB_FILE = "meta-brain.sqlite";
/**
 * Bumped when SCHEMA changes shape. v2 and v3 files are migrated in place
 * (columns added, rows kept); anything older is refused.
 */
const SCHEMA_VERSION = 4;
const MIGRATABLE_VERSIONS = new Set([2, 3]);

/** Ledger columns added in v3, applied to v2 files by ALTER TABLE. */
const V3_LEDGER_COLUMNS: Array<[name: string, ddl: string]> = [
  ["finish_reason", "finish_reason text"],
  ["reasoning_tokens", "reasoning_tokens integer check (reasoning_tokens >= 0)"],
  ["usage_raw", "usage_raw text"],
];

/** Brain-version columns added in v4: where a draft came from. */
const V4_BRAIN_COLUMNS: Array<[name: string, ddl: string]> = [
  ["source_kind", "source_kind text"],
  ["source_text", "source_text text"],
  ["audio_path", "audio_path text"],
];

const SCHEMA = `
create table if not exists businesses (
  id text primary key,
  name text not null,
  created_at text not null
);
create table if not exists brain_versions (
  business_id text not null references businesses(id) on delete cascade,
  version integer not null check (version > 0),
  brain text not null,
  approved integer not null default 0,
  created_at text not null,
  approved_at text,
  source_kind text,
  source_text text,
  audio_path text,
  primary key (business_id, version)
);
create table if not exists conversations (
  id text primary key,
  business_id text not null references businesses(id) on delete cascade,
  channel text not null check (channel in ('whatsapp', 'panel')),
  external_id text not null,
  customer_ref text not null,
  mode text not null check (mode in ('AUTO', 'HUMAN', 'PAUSED')),
  state text not null check (state in ('active', 'owner_help', 'closed')),
  created_at text not null,
  updated_at text not null,
  unique (business_id, channel, external_id)
);
create table if not exists turns (
  seq integer primary key autoincrement,
  id text not null unique,
  conversation_id text not null references conversations(id) on delete cascade,
  role text not null check (role in ('customer', 'assistant', 'tool', 'owner', 'system')),
  content text not null,
  checkpoint text,
  created_at text not null
);
create index if not exists turns_conversation_idx on turns (conversation_id, seq);
create table if not exists approvals (
  id text primary key,
  business_id text not null references businesses(id) on delete cascade,
  conversation_id text references conversations(id) on delete set null,
  kind text not null check (kind in ('booking', 'publication')),
  payload text not null,
  status text not null check (status in ('pending', 'approved', 'rejected')),
  created_at text not null,
  decided_at text
);
create table if not exists bookings (
  id text primary key,
  business_id text not null references businesses(id) on delete cascade,
  conversation_id text references conversations(id) on delete set null,
  service_id text not null,
  customer_ref text not null,
  customer_name text,
  customer_contact text,
  starts_at text not null,
  status text not null check (status in ('pending_approval', 'confirmed', 'rejected', 'cancelled')),
  approval_id text references approvals(id) on delete set null,
  created_at text not null
);
create table if not exists model_spend_reservations (
  id text primary key,
  created_at text not null,
  model text not null,
  run_id text,
  business_id text,
  turn_id text,
  tokens_in integer not null default 0 check (tokens_in >= 0),
  tokens_out integer not null default 0 check (tokens_out >= 0),
  reserved_nano integer not null check (reserved_nano > 0),
  settled_nano integer check (settled_nano >= 0),
  state text not null check (state in ('reserved', 'settled', 'released')),
  closed_at text,
  finish_reason text,
  reasoning_tokens integer check (reasoning_tokens >= 0),
  usage_raw text
);
create index if not exists model_spend_reservations_run_idx on model_spend_reservations (run_id, state);
create table if not exists processed_events (
  source text not null,
  event_id text not null,
  processed_at text not null,
  primary key (source, event_id)
);
`;

const COMMITTED_SQL = `
select coalesce(sum(case state when 'reserved' then reserved_nano when 'settled' then settled_nano else 0 end), 0) as n
  from model_spend_reservations`;

type Row = Record<string, any>;

const now = () => new Date().toISOString();

export class LocalStore implements Storage {
  readonly backend = "local" as const;

  private constructor(
    private readonly db: Database.Database,
    /** Absolute database file path; null for an in-memory store. */
    private readonly file: string | null,
  ) {}

  /** Opens (creating if needed) the store under dir. */
  static open(dir: string): LocalStore {
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, LOCAL_DB_FILE);
    const db = new Database(file);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    return new LocalStore(prepare(db, file), file);
  }

  /** Throwaway store; never durable. */
  static memory(): LocalStore {
    return new LocalStore(prepare(new Database(":memory:"), ":memory:"), null);
  }

  async ping(): Promise<void> {
    this.db.prepare("select 1 from model_spend_reservations limit 1").get();
  }

  async isDurable(): Promise<boolean> {
    if (!this.file || !existsSync(this.file)) return false;
    try {
      accessSync(this.file, constants.W_OK);
    } catch {
      return false;
    }
    const real = realpathSync(this.file);
    const temps = new Set([tmpdir(), "/tmp", "/private/tmp"].filter(existsSync).map((d) => realpathSync(d)));
    return ![...temps].some((t) => real === t || real.startsWith(t + sep));
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async reset(): Promise<{ businessId: string }> {
    this.db
      .transaction(() => {
        this.db.prepare("delete from businesses").run();
        const at = now();
        this.db.prepare("insert into businesses (id, name, created_at) values (?, ?, ?)").run(SEED_BUSINESS_ID, SEED_BRAIN.name, at);
        this.db
          .prepare(
            `insert into brain_versions (business_id, version, brain, approved, created_at, approved_at, source_kind)
             values (?, 1, ?, 1, ?, ?, 'seed')`,
          )
          .run(SEED_BUSINESS_ID, JSON.stringify(SEED_BRAIN), at, at);
      })
      .immediate();
    return { businessId: SEED_BUSINESS_ID };
  }

  async getBusiness(id: string): Promise<Business | null> {
    const r = this.db.prepare("select * from businesses where id = ?").get(id) as Row | undefined;
    return r ? { id: r.id, name: r.name, createdAt: r.created_at } : null;
  }

  async addBrainVersion(businessId: string, brain: BusinessBrain, source?: BrainSource): Promise<BrainVersion> {
    return this.db
      .transaction(() => {
        const { v } = this.db
          .prepare("select coalesce(max(version), 0) + 1 as v from brain_versions where business_id = ?")
          .get(businessId) as Row;
        this.db
          .prepare(
            `insert into brain_versions (business_id, version, brain, approved, created_at, source_kind, source_text, audio_path)
             values (?, ?, ?, 0, ?, ?, ?, ?)`,
          )
          .run(businessId, v, JSON.stringify(brain), now(), source?.kind ?? null, source?.text ?? null, source?.audioPath ?? null);
        return this.brainRow(businessId, v)!;
      })
      .immediate();
  }

  async updateBrainDraft(businessId: string, version: number, brain: BusinessBrain): Promise<BrainVersion> {
    const res = this.db
      .prepare("update brain_versions set brain = ? where business_id = ? and version = ? and approved = 0")
      .run(JSON.stringify(brain), businessId, version);
    if (res.changes === 0) throw new Error(`brain version ${version} is not an unapproved draft of ${businessId}`);
    return this.brainRow(businessId, version)!;
  }

  async deleteBrainDraft(businessId: string, version: number): Promise<boolean> {
    return (
      this.db.prepare("delete from brain_versions where business_id = ? and version = ? and approved = 0").run(businessId, version).changes === 1
    );
  }

  async listBrainVersions(businessId: string): Promise<BrainVersion[]> {
    return (this.db.prepare("select * from brain_versions where business_id = ? order by version desc").all(businessId) as Row[]).map(toBrain);
  }

  async approveBrainVersion(businessId: string, version: number): Promise<BrainVersion> {
    const res = this.db
      .prepare("update brain_versions set approved = 1, approved_at = ? where business_id = ? and version = ?")
      .run(now(), businessId, version);
    if (res.changes === 0) throw new Error(`brain version ${version} not found for ${businessId}`);
    return this.brainRow(businessId, version)!;
  }

  async getBrain(businessId: string, opts: { approvedOnly?: boolean } = {}): Promise<BrainVersion | null> {
    const r = this.db
      .prepare(
        `select * from brain_versions where business_id = ? ${opts.approvedOnly ? "and approved = 1" : ""}
         order by version desc limit 1`,
      )
      .get(businessId) as Row | undefined;
    return r ? toBrain(r) : null;
  }

  async createConversation(input: NewConversation): Promise<Conversation> {
    const id = randomUUID();
    const at = now();
    this.db
      .prepare(
        `insert into conversations (id, business_id, channel, external_id, customer_ref, mode, state, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(id, input.businessId, input.channel, input.externalId, input.customerRef, input.mode ?? "HUMAN", at, at);
    return (await this.getConversation(id))!;
  }

  async findConversation(businessId: string, channel: Channel, externalId: string): Promise<Conversation | null> {
    const r = this.db
      .prepare("select * from conversations where business_id = ? and channel = ? and external_id = ?")
      .get(businessId, channel, externalId) as Row | undefined;
    return r ? toConversation(r) : null;
  }

  async listConversations(businessId: string): Promise<Conversation[]> {
    return (
      this.db.prepare("select * from conversations where business_id = ? order by updated_at desc").all(businessId) as Row[]
    ).map(toConversation);
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const r = this.db.prepare("select * from conversations where id = ?").get(id) as Row | undefined;
    return r ? toConversation(r) : null;
  }

  async updateConversation(id: string, patch: { mode?: ConversationMode; state?: ConversationState }): Promise<Conversation> {
    const res = this.db
      .prepare("update conversations set mode = coalesce(?, mode), state = coalesce(?, state), updated_at = ? where id = ?")
      .run(patch.mode ?? null, patch.state ?? null, now(), id);
    if (res.changes === 0) throw new Error(`conversation ${id} not found`);
    return (await this.getConversation(id))!;
  }

  async appendTurn(input: NewTurn): Promise<Turn> {
    const id = randomUUID();
    this.db
      .prepare("insert into turns (id, conversation_id, role, content, checkpoint, created_at) values (?, ?, ?, ?, ?, ?)")
      .run(id, input.conversationId, input.role, input.content, input.checkpoint ? JSON.stringify(input.checkpoint) : null, now());
    return toTurn(this.db.prepare("select * from turns where id = ?").get(id) as Row);
  }

  async listTurns(conversationId: string): Promise<Turn[]> {
    return (this.db.prepare("select * from turns where conversation_id = ? order by seq").all(conversationId) as Row[]).map(toTurn);
  }

  async requestBooking(input: NewBookingRequest): Promise<{ booking: Booking; approval: PendingApproval }> {
    return this.db
      .transaction(() => {
        const approval = this.insertApproval({
          businessId: input.businessId,
          conversationId: input.conversationId,
          kind: "booking",
          payload: bookingPayload(input),
        });
        const id = randomUUID();
        this.db
          .prepare(
            `insert into bookings (id, business_id, conversation_id, service_id, customer_ref, customer_name, customer_contact,
                                   starts_at, status, approval_id, created_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?)`,
          )
          .run(
            id,
            input.businessId,
            input.conversationId,
            input.serviceId,
            input.customerRef,
            input.customerName ?? null,
            input.customerContact ?? null,
            input.startsAt,
            approval.id,
            now(),
          );
        return { booking: toBooking(this.db.prepare("select * from bookings where id = ?").get(id) as Row), approval };
      })
      .immediate();
  }

  async createApproval(input: NewApproval): Promise<PendingApproval> {
    return this.insertApproval(input);
  }

  async getApproval(id: string): Promise<PendingApproval | null> {
    const r = this.db.prepare("select * from approvals where id = ?").get(id) as Row | undefined;
    return r ? toApproval(r) : null;
  }

  async decideApproval(id: string, decision: "approved" | "rejected"): Promise<{ approval: PendingApproval; changed: boolean }> {
    return this.db
      .transaction(() => {
        const res = this.db
          .prepare("update approvals set status = ?, decided_at = ? where id = ? and status = 'pending'")
          .run(decision, now(), id);
        const row = this.db.prepare("select * from approvals where id = ?").get(id) as Row | undefined;
        if (!row) throw new Error(`approval ${id} not found`);
        if (res.changes === 1) {
          this.db
            .prepare("update bookings set status = ? where approval_id = ? and status = 'pending_approval'")
            .run(decision === "approved" ? "confirmed" : "rejected", id);
        }
        return { approval: toApproval(row), changed: res.changes === 1 };
      })
      .immediate();
  }

  async listPendingApprovals(businessId: string): Promise<PendingApproval[]> {
    return (
      this.db.prepare("select * from approvals where business_id = ? and status = 'pending' order by created_at").all(businessId) as Row[]
    ).map(toApproval);
  }

  async listBookings(businessId: string): Promise<Booking[]> {
    return (this.db.prepare("select * from bookings where business_id = ? order by created_at").all(businessId) as Row[]).map(toBooking);
  }

  async reserveSpend(req: ReserveRequest, limits: LedgerLimits): Promise<ReserveResult> {
    return this.db
      .transaction((): ReserveResult => {
        const amount = req.amountNano;
        const committed = (this.db.prepare(COMMITTED_SQL).get() as Row).n as number;
        if (committed + amount > limits.hardCapNano) {
          return { granted: false, reason: "hard_cap_reached", detail: `committed ${committed} + ${amount} > cap ${limits.hardCapNano}` };
        }
        const spendable = limits.creditBalanceNano - limits.bufferNano - committed;
        if (amount > spendable) {
          return { granted: false, reason: "insufficient_credit", detail: `spendable ${spendable} after buffer < ${amount}` };
        }
        if (req.runCapNano !== undefined) {
          const runCommitted = (this.db.prepare(`${COMMITTED_SQL} where run_id is ?`).get(req.runId ?? null) as Row).n as number;
          if (runCommitted + amount > req.runCapNano) {
            return { granted: false, reason: "run_cap_reached", detail: `run ${runCommitted} + ${amount} > run cap ${req.runCapNano}` };
          }
        }
        const id = randomUUID();
        this.db
          .prepare(
            `insert into model_spend_reservations (id, created_at, model, run_id, business_id, turn_id, reserved_nano, state)
             values (?, ?, ?, ?, ?, ?, ?, 'reserved')`,
          )
          .run(id, now(), req.model, req.runId ?? null, req.businessId ?? null, req.turnId ?? null, amount);
        return { granted: true, reservationId: id };
      })
      .immediate();
  }

  async settleSpend(reservationId: string, actualNano: NanoUsd, usage: SpendUsage): Promise<void> {
    const res = this.db
      .prepare(
        `update model_spend_reservations
            set state = 'settled', settled_nano = ?, tokens_in = ?, tokens_out = ?, closed_at = ?,
                finish_reason = ?, reasoning_tokens = ?, usage_raw = ?
          where id = ? and state = 'reserved'`,
      )
      .run(
        actualNano,
        usage.tokensIn,
        usage.tokensOut,
        now(),
        usage.finishReason ?? null,
        usage.reasoningTokens ?? null,
        usage.usageRaw ?? null,
        reservationId,
      );
    if (res.changes === 0) throw new Error(`reservation ${reservationId} is not open`);
  }

  async releaseSpend(reservationId: string): Promise<void> {
    const res = this.db
      .prepare("update model_spend_reservations set state = 'released', closed_at = ? where id = ? and state = 'reserved'")
      .run(now(), reservationId);
    if (res.changes === 0) throw new Error(`reservation ${reservationId} is not open`);
  }

  async spendTotals(runId?: string): Promise<LedgerSnapshot> {
    const r = this.db
      .prepare(
        `select
           coalesce(sum(case when state = 'settled' then settled_nano end), 0) as settled,
           coalesce(sum(case when state = 'reserved' then reserved_nano end), 0) as reserved,
           coalesce(sum(case when state = 'settled' and run_id = ? then settled_nano end), 0) as run_settled,
           coalesce(sum(case when state = 'reserved' and run_id = ? then reserved_nano end), 0) as run_reserved
         from model_spend_reservations`,
      )
      .get(runId ?? null, runId ?? null) as Row;
    return { settledNano: r.settled, reservedNano: r.reserved, runSettledNano: r.run_settled, runReservedNano: r.run_reserved };
  }

  async listSpend(): Promise<SpendEntry[]> {
    return (this.db.prepare("select * from model_spend_reservations order by created_at, rowid").all() as Row[]).map(toSpend);
  }

  async claimEvent(source: string, eventId: string): Promise<boolean> {
    const res = this.db
      .prepare("insert into processed_events (source, event_id, processed_at) values (?, ?, ?) on conflict do nothing")
      .run(source, eventId, now());
    return res.changes === 1;
  }

  private brainRow(businessId: string, version: number): BrainVersion | null {
    const r = this.db.prepare("select * from brain_versions where business_id = ? and version = ?").get(businessId, version) as
      | Row
      | undefined;
    return r ? toBrain(r) : null;
  }

  private insertApproval(input: NewApproval): PendingApproval {
    const id = randomUUID();
    this.db
      .prepare(
        `insert into approvals (id, business_id, conversation_id, kind, payload, status, created_at)
         values (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(id, input.businessId, input.conversationId, input.kind, JSON.stringify(input.payload), now());
    return toApproval(this.db.prepare("select * from approvals where id = ?").get(id) as Row);
  }
}

/** Applies the schema, migrating a v2 file in place; refuses any other older version. */
function prepare(db: Database.Database, file: string): Database.Database {
  db.pragma("foreign_keys = ON");
  const version = db.pragma("user_version", { simple: true }) as number;
  const hasTables = (db.prepare("select count(*) as n from sqlite_master where type = 'table'").get() as Row).n > 0;
  if (hasTables && version !== SCHEMA_VERSION && !MIGRATABLE_VERSIONS.has(version)) {
    db.close();
    throw new StorageConfigError(`local store ${file} has schema v${version}, expected v2-v${SCHEMA_VERSION}; move the file aside and reopen`);
  }
  db.transaction(() => {
    db.exec(SCHEMA);
    migrateV2ToV3(db);
    migrateV3ToV4(db);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }).immediate();
  return db;
}

function addMissingColumns(db: Database.Database, table: string, columns: Array<[string, string]>): string[] {
  const have = new Set((db.prepare(`pragma table_info(${table})`).all() as Row[]).map((c) => c.name));
  const added: string[] = [];
  for (const [name, ddl] of columns) {
    if (have.has(name)) continue;
    db.exec(`alter table ${table} add column ${ddl}`);
    added.push(name);
  }
  return added;
}

/** Adds the v4 brain-source columns that are missing; rows are untouched. Safe to run repeatedly. */
export function migrateV3ToV4(db: Database.Database): string[] {
  return addMissingColumns(db, "brain_versions", V4_BRAIN_COLUMNS);
}

/** Adds the v3 ledger columns that are missing; rows are untouched. Safe to run repeatedly. */
export function migrateV2ToV3(db: Database.Database): string[] {
  return addMissingColumns(db, "model_spend_reservations", V3_LEDGER_COLUMNS);
}

function toBrain(r: Row): BrainVersion {
  return {
    businessId: r.business_id,
    version: r.version,
    brain: upgradeBrain(JSON.parse(r.brain)),
    approved: r.approved === 1,
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
    seq: r.seq,
    role: r.role,
    content: r.content,
    checkpoint: r.checkpoint ? JSON.parse(r.checkpoint) : null,
    createdAt: r.created_at,
  };
}

function toApproval(r: Row): PendingApproval {
  return {
    id: r.id,
    businessId: r.business_id,
    conversationId: r.conversation_id ?? null,
    kind: r.kind,
    payload: JSON.parse(r.payload),
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
  };
}

function toSpend(r: Row): SpendEntry {
  return {
    id: r.id,
    createdAt: r.created_at,
    model: r.model,
    runId: r.run_id ?? null,
    businessId: r.business_id ?? null,
    turnId: r.turn_id ?? null,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    reservedNano: r.reserved_nano,
    settledNano: r.settled_nano ?? null,
    state: r.state,
    finishReason: r.finish_reason ?? null,
    reasoningTokens: r.reasoning_tokens ?? null,
    usageRaw: r.usage_raw ?? null,
  };
}
