// /owner?token=... and /onboard?token=...: a matching token sets the owner
// cookie and redirects to the same path without the token, so it does not stay
// in the address bar. A wrong or missing token changes nothing; the page then
// answers as it would without the proxy (404 on a hosted deploy without access).
import { NextResponse, type NextRequest } from "next/server";
import { OWNER_COOKIE, OWNER_COOKIE_MAX_AGE, ownerCookieValue, ownerToken, tokenMatches } from "./lib/engine/owner-access";

export function proxy(request: NextRequest) {
  const given = request.nextUrl.searchParams.get("token");
  if (given === null) return NextResponse.next();
  const clean = request.nextUrl.clone();
  clean.searchParams.delete("token");
  const res = NextResponse.redirect(clean);
  const token = ownerToken();
  if (token && tokenMatches(given)) {
    res.cookies.set(OWNER_COOKIE, ownerCookieValue(token), {
      httpOnly: true,
      secure: request.nextUrl.protocol === "https:",
      sameSite: "lax",
      path: "/",
      maxAge: OWNER_COOKIE_MAX_AGE,
    });
  }
  return res;
}

export const config = { matcher: ["/owner", "/onboard"] };
