import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { cookieFrom, OWNER_COOKIE, ownerAllowed, ownerCookieValue, requestAllowed } from "./owner-access";
import { localOnly, ownerOnly } from "./http";
import { proxy } from "../../proxy";

const TOKEN = "test-owner-token-0123456789abcdef";
const HOSTED = { VERCEL: "1", OWNER_ACCESS_TOKEN: TOKEN };

const req = (headers: Record<string, string> = {}) => new Request("https://brain.example/api/owner/state", { headers });

afterEach(() => vi.unstubAllEnvs());

describe("owner access", () => {
  it("token unset: local allowed, Vercel refused even with a cookie or bearer", () => {
    expect(ownerAllowed({}, {})).toBe(true);
    expect(ownerAllowed({}, { VERCEL: "1" })).toBe(false);
    expect(ownerAllowed({ cookie: ownerCookieValue(TOKEN), authorization: `Bearer ${TOKEN}` }, { VERCEL: "1" })).toBe(false);
  });

  it("token set, local dev: allowed without credentials", () => {
    expect(ownerAllowed({}, { OWNER_ACCESS_TOKEN: TOKEN })).toBe(true);
  });

  it("token set, Vercel: no credentials refused", () => {
    expect(ownerAllowed({}, HOSTED)).toBe(false);
  });

  it("cookie: the token hash passes; the raw token or another hash does not", () => {
    expect(ownerAllowed({ cookie: ownerCookieValue(TOKEN) }, HOSTED)).toBe(true);
    expect(ownerAllowed({ cookie: TOKEN }, HOSTED)).toBe(false);
    expect(ownerAllowed({ cookie: ownerCookieValue("other") }, HOSTED)).toBe(false);
  });

  it("bearer: the exact token passes; a wrong token, a prefix or a bare token does not", () => {
    expect(ownerAllowed({ authorization: `Bearer ${TOKEN}` }, HOSTED)).toBe(true);
    expect(ownerAllowed({ authorization: `bearer ${TOKEN}` }, HOSTED)).toBe(true);
    expect(ownerAllowed({ authorization: "Bearer wrong" }, HOSTED)).toBe(false);
    expect(ownerAllowed({ authorization: `Bearer ${TOKEN.slice(0, -1)}` }, HOSTED)).toBe(false);
    expect(ownerAllowed({ authorization: TOKEN }, HOSTED)).toBe(false);
  });

  it("reads the owner cookie among others", () => {
    expect(cookieFrom(`a=1; ${OWNER_COOKIE}=abc; b=2`)).toBe("abc");
    expect(cookieFrom("a=1")).toBeNull();
    expect(requestAllowed(req({ cookie: `x=1; ${OWNER_COOKIE}=${ownerCookieValue(TOKEN)}` }), HOSTED)).toBe(true);
  });
});

describe("route guards", () => {
  it("ownerOnly: 404 on Vercel without the token configured", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("OWNER_ACCESS_TOKEN", "");
    expect(ownerOnly(req({ authorization: `Bearer ${TOKEN}` }))?.status).toBe(404);
  });

  it("ownerOnly: 404 without credentials, passes with cookie or bearer", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("OWNER_ACCESS_TOKEN", TOKEN);
    expect(ownerOnly(req())?.status).toBe(404);
    expect(ownerOnly(req({ authorization: `Bearer ${TOKEN}` }))).toBeNull();
    expect(ownerOnly(req({ cookie: `${OWNER_COOKIE}=${ownerCookieValue(TOKEN)}` }))).toBeNull();
  });

  it("ownerOnly: local dev passes with no credentials", () => {
    vi.stubEnv("VERCEL", "");
    expect(ownerOnly(req())).toBeNull();
  });

  it("localOnly (demo reset): 404 on Vercel even with owner access", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("OWNER_ACCESS_TOKEN", TOKEN);
    expect(localOnly()?.status).toBe(404);
    vi.stubEnv("VERCEL", "");
    expect(localOnly()).toBeNull();
  });
});

describe("proxy", () => {
  it("a matching token sets the hashed httpOnly cookie and redirects without the token", () => {
    vi.stubEnv("OWNER_ACCESS_TOKEN", TOKEN);
    const res = proxy(new NextRequest(`https://brain.example/owner?business=biz_x&token=${TOKEN}`));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://brain.example/owner?business=biz_x");
    const cookie = res.cookies.get(OWNER_COOKIE);
    expect(cookie?.value).toBe(ownerCookieValue(TOKEN));
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.secure).toBe(true);
    expect(res.headers.get("set-cookie")).not.toContain(TOKEN);
  });

  it("a wrong token redirects without a cookie", () => {
    vi.stubEnv("OWNER_ACCESS_TOKEN", TOKEN);
    const res = proxy(new NextRequest("https://brain.example/owner?token=wrong"));
    expect(res.headers.get("location")).toBe("https://brain.example/owner");
    expect(res.cookies.get(OWNER_COOKIE)).toBeUndefined();
  });

  it("token unset: no cookie for any token", () => {
    vi.stubEnv("OWNER_ACCESS_TOKEN", "");
    const res = proxy(new NextRequest("https://brain.example/owner?token=anything"));
    expect(res.cookies.get(OWNER_COOKIE)).toBeUndefined();
  });

  it("no token parameter: passes through", () => {
    const res = proxy(new NextRequest("https://brain.example/owner"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get(OWNER_COOKIE)).toBeUndefined();
  });
});
