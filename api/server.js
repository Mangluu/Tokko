const tokkoServer = require("../server.js");

/**
 * Vercel Function adapter for Tokko's existing Node HTTP handler.
 *
 * Vercel rewrites every /api/* request to this single function and carries the
 * original path in __tokkoPath. Reconstructing req.url lets the backend keep its
 * existing routing, validation, authentication, and webhook code unchanged.
 */
module.exports = function vercelTokkoHandler(req, res) {
  const incoming = new URL(req.url, "http://localhost");
  const path = String(incoming.searchParams.get("__tokkoPath") || "")
    .replace(/^\/+|\/+$/g, "");
  incoming.searchParams.delete("__tokkoPath");

  const query = incoming.searchParams.toString();
  req.url = `/api${path ? `/${path}` : ""}${query ? `?${query}` : ""}`;
  return tokkoServer.handler(req, res);
};
