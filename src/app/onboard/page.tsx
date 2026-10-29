import { notFound } from "next/navigation";
import { ownerScreenAllowed } from "@/lib/engine/deps";
import { Onboarding } from "./onboarding";

export const dynamic = "force-dynamic";

export const metadata = { title: "Onboarding - Meta Brain" };

export default function OnboardPage() {
  if (!ownerScreenAllowed()) notFound();
  return <Onboarding />;
}
