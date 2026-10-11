import { getAgentByName } from "agents";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./env.ts";

/**
 * Single-user auth: humans sign in through Cloudflare Access. This deployment sits behind an
 * Access application (enable it on the Worker's URL, or on a hostname in your zone); the edge
 * authenticates, and the Worker verifies the `Cf-Access-Jwt-Assertion` JWT against the team's
 * public keys, then mints a session from the verified email. The user id is derived from the
 * email, so one identity is one memory repo — no email infrastructure, no open sign-up.
 *
 * Machine agents skip all of this: they carry `Authorization: Bearer <MEMORY_API_KEY>`, which
 * reaches every user's /api (see api.ts).
 *
 * A session is a signed token `<user>.<expires>.<hmac>`, sent as an HttpOnly cookie (so the agent
 * WebSockets carry it too) or as `Authorization: Bearer <token>` for the HTTP API.
 *
 *   GET  /auth/me     → {user, email, token}; mints a session from the Access JWT if none yet
 *   POST /auth/logout → clears the cookie
 */
export const USER = /^[a-z0-9_-]{1,48}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const COOKIE = "mm_session";
const SESSION_SECONDS = 30 * 24 * 60 * 60;

const enc = new TextEncoder();
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });

export async function handleAuth(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const route = `${request.method.toUpperCase()} ${url.pathname}`;

  if (route === "GET /auth/me") {
    const token = readToken(request);
    const user = token ? await verify(token, env.AUTH_SECRET) : null;
    if (user) {
      const email = await (await getAgentByName(env.MemoryAgent, user)).accountEmail();
      return json({ user, email, token });
    }

    // No session yet: mint one from Cloudflare Access.
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD)
      return json({ error: "Cloudflare Access is not configured: set ACCESS_TEAM_DOMAIN and ACCESS_AUD" }, 503);
    const email = await accessEmail(request, env);
    if (!email) return json({ error: "not signed in (Cloudflare Access)" }, 401);
    const newUser = await userIdFor(email);
    await (await getAgentByName(env.MemoryAgent, newUser)).setAccountEmail(email);
    const fresh = await sign(newUser, env.AUTH_SECRET);
    return json({ user: newUser, email, token: fresh }, 200, { "set-cookie": cookie(url, fresh, SESSION_SECONDS) });
  }
  if (route === "POST /auth/logout") return json({ ok: true }, 200, { "set-cookie": cookie(url, "", 0) });
  return json({ error: "not found" }, 404);
}

/** The verified email behind a Cloudflare Access JWT, or null (missing/invalid/misconfigured). */
async function accessEmail(request: Request, env: Env): Promise<string | null> {
  const team = env.ACCESS_TEAM_DOMAIN.replace(/\/+$/, "");
  const assertion = request.headers.get("cf-access-jwt-assertion");
  if (!team || !env.ACCESS_AUD || !assertion) return null;
  try {
    const { payload } = await jwtVerify(assertion, remoteJWKS(team), { issuer: team, audience: env.ACCESS_AUD });
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    return email && EMAIL.test(email) ? email : null;
  } catch {
    return null;
  }
}

/** jose's remote JWKS over the team's public certs, memoized per team (jose refreshes keys itself). */
const JWKS = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function remoteJWKS(team: string) {
  let jwks = JWKS.get(team);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", `${team}/`));
    JWKS.set(team, jwks);
  }
  return jwks;
}

/** The signed-in user for a request (cookie or bearer token), or null. */
export async function sessionUser(request: Request, env: Env): Promise<string | null> {
  const token = readToken(request);
  return token ? verify(token, env.AUTH_SECRET) : null;
}

/** A stable, URL-safe user id for an email: a readable prefix plus a hash, e.g. `ada-3f2a1c9b0e7d`. */
async function userIdFor(email: string): Promise<string> {
  const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(email))));
  const local = email.split("@")[0]!.replace(/[^a-z0-9_-]/g, "").slice(0, 24) || "user";
  return `${local}-${digest.slice(0, 12)}`;
}

// ---- session tokens ------------------------------------------------------------------------

async function sign(user: string, secret: string): Promise<string> {
  const payload = `${user}.${Math.floor(Date.now() / 1000) + SESSION_SECONDS}`;
  return `${payload}.${await hmac(payload, secret)}`;
}

async function verify(token: string, secret: string): Promise<string | null> {
  const [user, expires, sig] = token.split(".");
  if (!user || !expires || !sig || !USER.test(user)) return null;
  if (Number(expires) < Date.now() / 1000) return null;
  return equal(sig, await hmac(`${user}.${expires}`, secret)) ? user : null;
}

async function hmac(payload: string, secret: string): Promise<string> {
  if (!secret) throw new Error("AUTH_SECRET is not set");
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payload))));
}

function readToken(request: Request): string | null {
  const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (bearer) return bearer;
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE) return decodeURIComponent(value.join("="));
  }
  return null;
}

function cookie(url: URL, value: string, maxAge: number): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Constant-time string comparison. */
export function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
