import { timingSafeEqual } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/server";

/**
 * Verifies the bearer token against MCP_BEARER_TOKEN. Personal single-user
 * server, so a shared secret stands in for full OAuth (see README).
 */
export function verifyBearerToken(
  _req: Request,
  bearerToken?: string
): AuthInfo | undefined {
  const expected = process.env.MCP_BEARER_TOKEN;
  if (!expected || !bearerToken) return undefined;

  const provided = Buffer.from(bearerToken);
  const known = Buffer.from(expected);
  if (provided.length !== known.length || !timingSafeEqual(provided, known)) {
    return undefined;
  }

  return {
    token: bearerToken,
    clientId: "personal",
    scopes: [],
  };
}
