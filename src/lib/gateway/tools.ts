// Tool registry and the deterministic rule for which tools a conversation may
// use. The model only ever sees, and can only ever run, the permitted list.
import type { Conversation, Storage } from "../storage/types";
import type { JsonSchemaObject, ToolDefinition } from "./types";

export type ToolContext = {
  store: Storage;
  businessId: string;
  conversationId: string;
  customerRef: string;
  now: () => Date;
};

export type ToolSpec = ToolDefinition & {
  /**
   * read: looks things up. write: creates a record (always owner-gated).
   * escalate: hands the conversation to the owner.
   */
  access: "read" | "write" | "escalate";
  /** Running it ends the turn in owner help. */
  endsTurn?: boolean;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
};

/**
 * PAUSED or waiting on the owner: no tools. HUMAN: read and escalate tools.
 * AUTO: every registered tool; write tools still only create pending records.
 */
export function permittedToolNames(conversation: Conversation, registry: readonly ToolSpec[]): string[] {
  if (conversation.state !== "active") return [];
  switch (conversation.mode) {
    case "PAUSED":
      return [];
    case "HUMAN":
      return registry.filter((t) => t.access !== "write").map((t) => t.name);
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
