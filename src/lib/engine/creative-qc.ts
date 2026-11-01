// Wonder creative QC: Muse Wonder looks at the feed export, as a customer would
// see it on a phone, and answers a fixed JSON schema: is the price readable, is
// the expected object there, is any text garbled or drawn as empty boxes. The
// verdict is shown to the owner; it never approves or rejects anything.
// One gateway call (ledger reserve and settle, spend cap), like every other.
import sharp from "sharp";
import type { SpendGateway } from "../gateway";

export const QC_MODEL = "muse-wonder-1.0";
/** The export is checked at roughly phone-feed size, which is also where readability matters. */
export const QC_IMAGE_PX = 768;
export const QC_MAX_OUTPUT_TOKENS = 1_024;

export const QC_SCHEMA = {
  name: "creative_qc",
  strict: true,
  schema: {
    type: "object",
    properties: {
      price_readable: { type: "boolean", description: "The stated price is clearly legible." },
      expected_object_present: { type: "boolean", description: "The named product is visible in the image." },
      garbled_or_tofu_text: { type: "boolean", description: "Any text is garbled, misspelled nonsense, or drawn as empty boxes." },
      overall_pass: { type: "boolean" },
      reasons: { type: "array", items: { type: "string" }, description: "Short reasons, one per problem found; empty when all is fine." },
    },
    required: ["price_readable", "expected_object_present", "garbled_or_tofu_text", "overall_pass", "reasons"],
    additionalProperties: false,
  },
} as const;

export type QcAnswer = {
  price_readable: boolean;
  expected_object_present: boolean;
  garbled_or_tofu_text: boolean;
  overall_pass: boolean;
  reasons: string[];
};

/** What is stored on the creative (diagnostics.qc). */
export type QcVerdict =
  | {
      status: "pass" | "fail";
      model: string;
      checkedAt: string;
      answer: QcAnswer;
      /** Reasons shown to the owner: the model's, plus any failed check it did not explain. */
      reasons: string[];
      /** overall_pass as the model stated it, when it disagrees with its own checks. */
      modelOverallDisagrees?: boolean;
      sent: string;
      costUsd: number;
    }
  | { status: "not_run"; model: string; checkedAt: string; reason: string; costUsd: number };

export function qcPrompt(input: { priceText: string; object: string }): string {
  return [
    "You are checking a social media post image before the business owner reviews it. Answer only from what is visible in the image.",
    `The post must show the price "${input.priceText}" so that it is easy to read on a phone.`,
    `The product in the image should be: "${input.object}".`,
    "Check: price_readable (the price is clearly legible); expected_object_present (that product is visible); garbled_or_tofu_text (any text is garbled, nonsensical, or rendered as empty boxes or squares).",
    "overall_pass is true only if price_readable and expected_object_present are true and garbled_or_tofu_text is false. Give short reasons for each problem; an empty list when there are none.",
  ].join("\n");
}

function isAnswer(v: unknown): v is QcAnswer {
  const a = v as QcAnswer;
  return (
    !!a &&
    typeof a.price_readable === "boolean" &&
    typeof a.expected_object_present === "boolean" &&
    typeof a.garbled_or_tofu_text === "boolean" &&
    typeof a.overall_pass === "boolean" &&
    Array.isArray(a.reasons) &&
    a.reasons.every((r) => typeof r === "string")
  );
}

/**
 * The pass/fail shown is decided by code from the three checks, not by the
 * model's overall_pass alone; a disagreement is recorded.
 */
export async function runCreativeQc(
  gateway: SpendGateway | null,
  input: { feed: Buffer; priceText: string; object: string; businessId: string },
  now: () => Date = () => new Date(),
): Promise<QcVerdict> {
  const checkedAt = now().toISOString();
  if (!gateway) return { status: "not_run", model: QC_MODEL, checkedAt, reason: "model unavailable", costUsd: 0 };
  const image = await sharp(input.feed).resize(QC_IMAGE_PX, QC_IMAGE_PX, { fit: "inside" }).jpeg({ quality: 85 }).toBuffer();
  const r = await gateway.call({
    kind: "vision",
    model: QC_MODEL,
    prompt: qcPrompt(input),
    image: new Uint8Array(image),
    mimeType: "image/jpeg",
    maxOutputTokens: QC_MAX_OUTPUT_TOKENS,
    jsonSchema: QC_SCHEMA as never,
    reasoningEffort: "low",
    businessId: input.businessId,
  });
  const costUsd = r.settledNano / 1e9;
  if (r.outcome === "denied") return { status: "not_run", model: QC_MODEL, checkedAt, reason: `${r.reason}: ${r.detail}`, costUsd };
  if (r.outcome === "failed") return { status: "not_run", model: QC_MODEL, checkedAt, reason: `call failed (status ${r.status})`, costUsd };
  let answer: unknown;
  try {
    answer = JSON.parse(r.output ?? "");
  } catch {
    return { status: "not_run", model: QC_MODEL, checkedAt, reason: "answer was not JSON", costUsd };
  }
  if (!isAnswer(answer)) return { status: "not_run", model: QC_MODEL, checkedAt, reason: "answer did not match the schema", costUsd };
  const checksPass = answer.price_readable && answer.expected_object_present && !answer.garbled_or_tofu_text;
  const reasons = [...answer.reasons];
  if (!answer.price_readable && !reasons.length) reasons.push("price not readable");
  if (!answer.expected_object_present && !reasons.length) reasons.push(`'${input.object}' not visible`);
  if (answer.garbled_or_tofu_text && !reasons.length) reasons.push("garbled or empty-box text");
  return {
    status: checksPass ? "pass" : "fail",
    model: QC_MODEL,
    checkedAt,
    answer,
    reasons: checksPass ? [] : reasons,
    ...(answer.overall_pass !== checksPass && { modelOverallDisagrees: true }),
    sent: `${QC_IMAGE_PX}px JPEG of the feed export`,
    costUsd,
  };
}

/** The status the owner sees: a pending creative whose QC failed shows as qc_failed. */
export function displayStatus(creative: { status: string; diagnostics: Record<string, unknown> }): string {
  const qc = creative.diagnostics.qc as QcVerdict | undefined;
  return creative.status === "pending_approval" && qc?.status === "fail" ? "qc_failed" : creative.status;
}
