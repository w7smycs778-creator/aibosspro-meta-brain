import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { OWNER_COOKIE, ownerAllowed } from "@/lib/engine/owner-access";
import { OwnerScreen } from "./owner-screen";

export const dynamic = "force-dynamic";

export const metadata = { title: "Owner screen - Meta Brain" };

export default async function OwnerPage() {
  const cookie = (await cookies()).get(OWNER_COOKIE)?.value;
  if (!ownerAllowed({ cookie, authorization: (await headers()).get("authorization") })) notFound();
  return <OwnerScreen />;
}
