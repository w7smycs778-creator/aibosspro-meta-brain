// Tool registry and the deterministic rule for which tools a conversation may
// use. The model only ever sees, and can only ever run, the permitted list.
import type { Conversation, Storage } from "../storage/types";
import type { JsonSchemaObject, ToolDefinition } from "./types";

export type ToolContext = {
  store: Storage;
  businessId: string;
  conversationId: string;
  customerRef: string;
};

export type ToolSpec = ToolDefinition & {
  /** read: looks things up. write: creates a record (always owner-gated). */
  access: "read" | "write";
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
};

/**
 * PAUSED or waiting on the owner: no tools. HUMAN: read-only tools.
 * AUTO: every registered tool; write tools still only create pending records.
 */
export function permittedToolNames(conversation: Conversation, registry: readonly ToolSpec[]): string[] {
  if (conversation.state !== "active") return [];
  switch (conversation.mode) {
    case "PAUSED":
      return [];
    case "HUMAN":
      return registry.filter((t) => t.access === "read").map((t) => t.name);
    case "AUTO":
      return registry.map((t) => t.name);
  }
}

export function toDefinition(t: ToolSpec): ToolDefinition {
  return { name: t.name, description: t.description, parameters: t.parameters };
}

/** Checks arguments against the flat schema subset; returns an error message or null. */
export function argumentError(schema: JsonSchemaObject, args: unknown): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return "arguments must be an object";
  const obj = args as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (!(key in obj)) return `missing required argument "${key}"`;
  }
  for (const [key, value] of Object.entries(obj)) {
    const prop = schema.properties[key];
    if (!prop) {
      if (schema.additionalProperties === false) return `unknown argument "${key}"`;
      continue;
    }
    const ok =
      prop.type === "integer"
        ? Number.isInteger(value)
        : prop.type === "number"
          ? typeof value === "number" && Number.isFinite(value)
          : typeof value === prop.type;
    if (!ok) return `argument "${key}" must be ${prop.type}`;
    if (prop.enum && !prop.enum.includes(value as string | number)) return `argument "${key}" is not an allowed value`;
  }
  return null;
}

export const listServicesTool: ToolSpec = {
  name: "list_services",
  description: "List the business's services with duration and price, from the owner-approved brain.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  access: "read",
  async execute(_args, ctx) {
    const brain = await ctx.store.getBrain(ctx.businessId, { approvedOnly: true });
    if (!brain) throw new Error("no approved brain for this business");
    return { currency: brain.brain.currency, services: brain.brain.services };
  },
};

export const requestBookingTool: ToolSpec = {
  name: "request_booking",
  description: "Ask the owner to approve a booking. Nothing is confirmed until the owner approves.",
  parameters: {
    type: "object",
    properties: {
      service_id: { type: "string", description: "Service id from list_services." },
      starts_at: { type: "string", description: "Start time, ISO 8601 with offset." },
    },
    required: ["service_id", "starts_at"],
    additionalProperties: false,
  },
  access: "write",
  async execute(args, ctx) {
    const brain = await ctx.store.getBrain(ctx.businessId, { approvedOnly: true });
    const serviceId = args.service_id as string;
    if (!brain?.brain.services.some((s) => s.id === serviceId)) throw new Error(`unknown service "${serviceId}"`);
    const startsAt = new Date(args.starts_at as string);
    if (Number.isNaN(startsAt.getTime())) throw new Error("starts_at is not a valid time");
    const { booking, approval } = await ctx.store.requestBooking({
      businessId: ctx.businessId,
      conversationId: ctx.conversationId,
      serviceId,
      customerRef: ctx.customerRef,
      startsAt: startsAt.toISOString(),
    });
    return { bookingId: booking.id, approvalId: approval.id, status: booking.status };
  },
};

export const DEFAULT_TOOLS: readonly ToolSpec[] = [listServicesTool, requestBookingTool];
