import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { OWNER_COOKIE, ownerAllowed } from "@/lib/engine/owner-access";
import { Onboarding } from "./onboarding";

export const dynamic = "force-dynamic";

export const metadata = { title: "Onboarding - Meta Brain" };

export default async function OnboardPage() {
  const cookie = (await cookies()).get(OWNER_COOKIE)?.value;
  if (!ownerAllowed({ cookie, authorization: (await headers()).get("authorization") })) notFound();
  return <Onboarding />;
}
