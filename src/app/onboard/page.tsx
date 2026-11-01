import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { OWNER_COOKIE, ownerAllowed } from "@/lib/engine/owner-access";
import { getStore } from "@/lib/storage";
import { Onboarding } from "./onboarding";

export const dynamic = "force-dynamic";

export const metadata = { title: "Onboarding - Meta Brain" };

/**
 * Onboarding is always for one named business (?business=<id>). Without one,
 * or with an unknown one, the page lists the businesses to choose from.
 */
export default async function OnboardPage({ searchParams }: { searchParams: Promise<{ business?: string | string[] }> }) {
  const cookie = (await cookies()).get(OWNER_COOKIE)?.value;
  if (!ownerAllowed({ cookie, authorization: (await headers()).get("authorization") })) notFound();
  const raw = (await searchParams).business;
  const requested = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  const store = await getStore();
  const business = requested ? await store.getBusiness(requested) : null;
  if (business) {
    const approved = await store.getBrain(business.id, { approvedOnly: true });
    return <Onboarding businessId={business.id} businessName={approved?.brain.name || business.name} />;
  }
  const businesses = await store.listBusinesses();
  return (
    <main className="min-h-screen space-y-3 bg-gray-50 p-4 text-sm text-gray-900">
      <h1 className="text-lg font-semibold">Onboarding: choose the business</h1>
      {requested && <p className="text-red-700">No business with the id &quot;{requested}&quot;.</p>}
      <ul className="space-y-1">
        {businesses.map((b) => (
          <li key={b.id}>
            <a className="underline" href={`/onboard?business=${encodeURIComponent(b.id)}`}>
              {b.name}
            </a>
          </li>
        ))}
      </ul>
      <a href="/owner" className="underline">Owner screen</a>
    </main>
  );
}
