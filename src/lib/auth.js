/**
 * Simple shared-secret guard for internal API routes.
 *
 * Callers send "Authorization: Bearer <API_TOKEN>". This is enough for an
 * office-internal tool; swap for Cloudflare Access (SSO) before exposing any
 * UI to staff browsers.
 */

/**
 * Constant-time string comparison so response timing can't be used to guess
 * the token one character at a time.
 */
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Length leak is acceptable; content comparison is constant-time.
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/** Returns a 401/500 Response if the request isn't authorized, else null. */
export function requireApiToken(request, env) {
  if (!env.API_TOKEN) {
    // Fail closed: never run unauthenticated because a secret wasn't set.
    return new Response("Server not configured", { status: 500 });
  }
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !timingSafeEqual(token, env.API_TOKEN)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": "Bearer" },
    });
  }
  return null;
}
