import { notFound } from "next/navigation";
import { ownerScreenAllowed } from "@/lib/engine/deps";
import { OwnerScreen } from "./owner-screen";

export const dynamic = "force-dynamic";

export const metadata = { title: "Owner screen - Meta Brain" };

export default function OwnerPage() {
  if (!ownerScreenAllowed()) notFound();
  return <OwnerScreen />;
}
