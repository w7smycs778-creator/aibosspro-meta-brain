// The one storage interface for the engine. LocalStore (SQLite under ./data)
// and SupabaseStore (Postgres, service role, server only) both implement it.
import type { LedgerSnapshot, SpendLedgerStore } from "../gateway/ledger";
import type { NanoUsd } from "../gateway/money";

export type StorageBackend = "local" | "supabase";

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export type Service = {
  id: string;
  name: string;
  durationMin: number;
  priceCents: number;
  currency: string;
  /** The service's name in other languages, keyed by language code, e.g. { he: "תספורת וזקן" }. */
  localNames?: Record<string, string>;
};

/** A percent or fixed amount off; empty serviceIds and weekdays mean every service and every day. */
export type DiscountRule = {
  id: string;
  description: string;
  percentOff: number | null;
  amountOffCents: number | null;
  serviceIds: string[];
  weekdays: Weekday[];
  /** Any other condition, as the owner said it. */
  conditions: string;
};

/** What the engine knows about one business. Owner-reviewed before it is used. */
export type BusinessBrain = {
  name: string;
  timezone: string;
  /** Languages the business answers in, e.g. ["English", "Hebrew"]. */
  languages: string[];
  /** 3-5 adjectives and one example sentence in the business's voice. */
  tone: { adjectives: string[]; example: string };
  /** Default currency (ISO code) for prices. */
  currency: string;
  services: Service[];
  /** Opening windows per weekday as [open, close] in local "HH:MM"; empty = closed. */
  hours: Record<Weekday, Array<[string, string]>>;
  discounts: DiscountRule[];
  /** Tier 1: every booking needs owner approval. */
  bookingPolicy: { approvalRequired: true };
  /** Phrases or topics the assistant must not use. */
  doNotSay: string[];
};

export type Business = {
  id: string;
  name: string;
  createdAt: string;
  /** Mode new WhatsApp conversations start in. */
  whatsappDefaultMode: ConversationMode;
};

export type CreativeStatus = "pending_approval" | "approved" | "rejected";

/** A branded post built from one approved offer: images, caption, and how each part was made. */
export type Creative = {
  id: string;
  businessId: string;
  offerId: string;
  /** Offer facts as computed from the brain when the creative was made. */
  offer: Record<string, unknown>;
  brainVersion: number;
  status: CreativeStatus;
  caption: string;
  /** Verifier log for the caption (attempts, checks, final verdict). */
  captionLog: Record<string, unknown> | null;
  /** Absolute local paths under ./data/media/. */
  media: { original: string; cutout: string | null; scene: string | null; feed: string; story: string };
  cutoutKind: "mask" | "box" | "unavailable";
  sceneKind: "generated" | "flat";
  /** Model output shapes and fallback reasons, for review. */
  diagnostics: Record<string, unknown>;
  createdAt: string;
  decidedAt: string | null;
};

export type NewCreative = Omit<Creative, "id" | "status" | "createdAt" | "decidedAt">;
export type CreativePatch = Partial<Pick<Creative, "media" | "cutoutKind" | "sceneKind" | "diagnostics" | "caption" | "captionLog">>;

export type BrainSource = {
  kind: "voice" | "text" | "seed";
  /** Transcript or typed text the draft was extracted from. */
  text: string | null;
  /** Local path of the stored voice note, under ./data/audio/. */
  audioPath: string | null;
};

export type BrainVersion = {
  businessId: string;
  version: number;
  brain: BusinessBrain;
  approved: boolean;
  createdAt: string;
  approvedAt: string | null;
  source: BrainSource | null;
};

export type ConversationMode = "AUTO" | "HUMAN" | "PAUSED";
export type ConversationState = "active" | "owner_help" | "closed";
export type Channel = "whatsapp" | "panel";

export type Conversation = {
  id: string;
  businessId: string;
  channel: Channel;
  /** Channel-side conversation key: WhatsApp sender id, or the panel session id. */
  externalId: string;
  customerRef: string;
  mode: ConversationMode;
  state: ConversationState;
  createdAt: string;
  updatedAt: string;
};

export type TurnRole = "customer" | "assistant" | "tool" | "owner" | "system";

/** JSON state recorded with a turn so a conversation can be inspected or resumed. */
export type Checkpoint = Record<string, unknown>;

export type Turn = {
  id: string;
  conversationId: string;
  /** Monotonic across the store; order turns by it. */
  seq: number;
  role: TurnRole;
  content: string;
  checkpoint: Checkpoint | null;
  createdAt: string;
};

export type ApprovalKind = "booking" | "publication";
export type ApprovalStatus = "pending" | "approved" | "rejected";

export type PendingApproval = {
  id: string;
  businessId: string;
  conversationId: string | null;
  kind: ApprovalKind;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt: string | null;
};

export type BookingStatus = "pending_approval" | "confirmed" | "rejected" | "cancelled";

export type Booking = {
  id: string;
  businessId: string;
  conversationId: string | null;
  serviceId: string;
  customerRef: string;
  customerName: string | null;
  customerContact: string | null;
  startsAt: string;
  status: BookingStatus;
  approvalId: string | null;
  createdAt: string;
  /** Price computed by the booking tool (discount applied when its conditions hold); null on older rows. */
  priceCents: number | null;
  currency: string | null;
  discountId: string | null;
  /** One booking per key: a retried or resumed request returns the existing booking. */
  idempotencyKey: string | null;
};

export type SpendEntry = {
  id: string;
  createdAt: string;
  model: string;
  runId: string | null;
  businessId: string | null;
  turnId: string | null;
  tokensIn: number;
  tokensOut: number;
  /** Conservative estimate reserved before dispatch. */
  reservedNano: NanoUsd;
  /** Actual cost once settled; null while reserved or after release. */
  settledNano: NanoUsd | null;
  state: "reserved" | "settled" | "released";
  /** Provider finish reason ("stop", "length", ...); null if unreported or unsettled. */
  finishReason: string | null;
  /** Reasoning tokens inside tokensOut; null if unreported. */
  reasoningTokens: number | null;
  /** Provider usage object as JSON text. */
  usageRaw: string | null;
};

export type NewConversation = {
  businessId: string;
  channel: Channel;
  externalId: string;
  customerRef: string;
  /** Defaults to HUMAN: the AI acts only after the owner switches to AUTO. */
  mode?: ConversationMode;
};

export type NewTurn = {
  conversationId: string;
  role: TurnRole;
  content: string;
  checkpoint?: Checkpoint | null;
};

export type NewBookingRequest = {
  businessId: string;
  conversationId: string | null;
  serviceId: string;
  customerRef: string;
  customerName?: string | null;
  customerContact?: string | null;
  startsAt: string;
  priceCents?: number | null;
  currency?: string | null;
  discountId?: string | null;
  idempotencyKey?: string | null;
};

export type NewApproval = {
  businessId: string;
  conversationId: string | null;
  kind: ApprovalKind;
  payload: Record<string, unknown>;
};

export interface Storage extends SpendLedgerStore {
  readonly backend: StorageBackend;
  /** Throws unless the store, including the spend ledger table, is reachable. */
  ping(): Promise<void>;
  /**
   * True only when spend rows survive a restart: LocalStore on a writable file
   * outside temp directories, SupabaseStore with its ledger table reachable.
   */
  isDurable(): Promise<boolean>;
  close(): Promise<void>;
  /**
   * Wipes every business with its brains, conversations, turns, approvals and
   * bookings, then seeds the one synthetic business. The spend ledger and the
   * processed-event ids are kept: wiping them would reset the cap and replay
   * events.
   */
  reset(): Promise<{ businessId: string }>;

  getBusiness(id: string): Promise<Business | null>;
  updateBusinessSettings(id: string, settings: { whatsappDefaultMode: ConversationMode }): Promise<Business>;
  /** Stores the next version, unapproved. */
  addBrainVersion(businessId: string, brain: BusinessBrain, source?: BrainSource): Promise<BrainVersion>;
  /** Replaces the brain of an unapproved version; approved versions are immutable. */
  updateBrainDraft(businessId: string, version: number, brain: BusinessBrain): Promise<BrainVersion>;
  /** Deletes an unapproved version; true if one was deleted. */
  deleteBrainDraft(businessId: string, version: number): Promise<boolean>;
  approveBrainVersion(businessId: string, version: number): Promise<BrainVersion>;
  /** Every version, newest first. */
  listBrainVersions(businessId: string): Promise<BrainVersion[]>;
  /** Latest version, or latest approved version with approvedOnly. */
  getBrain(businessId: string, opts?: { approvedOnly?: boolean }): Promise<BrainVersion | null>;

  createConversation(input: NewConversation): Promise<Conversation>;
  getConversation(id: string): Promise<Conversation | null>;
  findConversation(businessId: string, channel: Channel, externalId: string): Promise<Conversation | null>;
  listConversations(businessId: string): Promise<Conversation[]>;
  updateConversation(id: string, patch: { mode?: ConversationMode; state?: ConversationState }): Promise<Conversation>;
  appendTurn(input: NewTurn): Promise<Turn>;
  listTurns(conversationId: string): Promise<Turn[]>;

  /**
   * Creates a pending booking and the owner approval that gates it. With an
   * idempotency key already used, returns that booking (existing: true).
   * Throws SlotTakenError when the business already has a pending or confirmed
   * booking starting at the same time.
   */
  requestBooking(input: NewBookingRequest): Promise<{ booking: Booking; approval: PendingApproval; existing: boolean }>;
  createApproval(input: NewApproval): Promise<PendingApproval>;
  getApproval(id: string): Promise<PendingApproval | null>;
  /**
   * Decides a pending approval; a linked booking becomes confirmed or rejected.
   * An approval that is already decided is left as is (changed: false).
   */
  decideApproval(id: string, decision: "approved" | "rejected"): Promise<{ approval: PendingApproval; changed: boolean }>;
  listPendingApprovals(businessId: string): Promise<PendingApproval[]>;
  listBookings(businessId: string): Promise<Booking[]>;

  /** Stores a creative as PENDING_APPROVAL. */
  createCreative(input: NewCreative): Promise<Creative>;
  getCreative(id: string): Promise<Creative | null>;
  listCreatives(businessId: string): Promise<Creative[]>;
  updateCreativeCaption(id: string, caption: string, captionLog: Record<string, unknown> | null): Promise<Creative>;
  /** Replaces a pending creative's images, caption and logs in place (same id, offer and brain version). */
  updateCreative(id: string, patch: CreativePatch): Promise<Creative>;
  /** Approves or rejects a pending creative; an already decided one is left as is (changed: false). */
  decideCreative(id: string, decision: "approved" | "rejected"): Promise<{ creative: Creative; changed: boolean }>;

  listSpend(): Promise<SpendEntry[]>;
  spendTotals(runId?: string): Promise<LedgerSnapshot>;

  /** Records an event id; true the first time, false on every repeat. */
  claimEvent(source: string, eventId: string): Promise<boolean>;
}
