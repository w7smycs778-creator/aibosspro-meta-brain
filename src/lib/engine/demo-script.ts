// Scripted model replies for the mock demo path (Step 7a and MODEL_CLIENT=mock).
// Each entry is raw model text, decoded by the same json-mode parser as live
// replies. The customer messages must be sent in this order.
import type { ScriptedStep } from "../gateway/mock-client";

export const DEMO_DATE = "2026-11-05"; // a Thursday
export const DEMO_CLOCK = new Date("2026-10-29T12:00:00Z");

export const DEMO_MESSAGES = [
  "What do you offer?",
  "Do you have Thursday 10:00 for a Cut + beard?",
  "Book it, I'm Dana 050-0000000",
  "Can you give me 50% off?",
];

const call = (name: string, args: Record<string, unknown> = {}): ScriptedStep => ({
  raw: JSON.stringify({ type: "tool_call", name, args }),
});
const final = (text: string): ScriptedStep => ({ raw: JSON.stringify({ type: "final", text }) });

export const DEMO_SCRIPT: ScriptedStep[] = [
  // 1. What do you offer?
  call("list_services"),
  final(
    "We offer Classic cut ($35, 30 min), Beard trim ($20, 15 min), Cut + beard ($50, 45 min) and Kids cut (under 12) ($25, 20 min). Our only discount is 10% off Cut + beard on Tuesdays.",
  ),
  // 2. Thursday 10:00 for Cut + beard? (fenced, to exercise fence stripping)
  { raw: "```json\n" + JSON.stringify({ type: "tool_call", name: "check_availability", args: { date: DEMO_DATE, service: "cut_and_beard" } }) + "\n```" },
  final("Yes, Thursday Nov 5 at 10:00 is open for Cut + beard ($50, 45 min). Shall I request it for you?"),
  // 3. Book it.
  call("request_booking", { service: "cut_and_beard", slot: `${DEMO_DATE}T10:00`, customer_name: "Dana", customer_contact: "050-0000000" }),
  final("Thanks Dana. I've sent Cut + beard on Thu Nov 5 at 10:00 to the owner for approval. You'll get a message once the owner approves it."),
  // 4. Unsupported discount: blocked once, then corrected.
  final("Sure, I can do 50% off your Cut + beard."),
  final("That discount isn't something I can offer. Our only discount is 10% off Cut + beard on Tuesdays, which makes it $45."),
];
