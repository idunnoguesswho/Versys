/**
 * Versys Worker entry point — a tiny router.
 * Public: GET /         (health check)
 * API:    POST /api/field-tickets/:refNbr/send   (bearer-token protected)
 */
import { requireApiToken } from "./lib/auth.js";
import { sendFieldTicket } from "./routes/fieldTickets.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check — unchanged from the original scaffold.
    if (url.pathname === "/") {
      return new Response("Versys is running.", { status: 200 });
    }

    // Everything under /api requires the shared API token.
    if (url.pathname.startsWith("/api/")) {
      const denied = requireApiToken(request, env);
      if (denied) return denied;

      const send = url.pathname.match(/^\/api\/field-tickets\/([^/]+)\/send$/);
      if (send) {
        if (request.method !== "POST") {
          return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
        }
        return sendFieldTicket(request, env, send[1]);
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};
