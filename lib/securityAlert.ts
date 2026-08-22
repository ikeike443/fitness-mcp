import { after } from "next/server";

/**
 * Fire-and-forget security logging/alerting for auth-related failures on
 * this server (bad/missing MCP bearer token, invalid OAuth client_id or
 * client_secret, bad PKCE, disallowed redirect_uri).
 *
 * Two independent layers, so this degrades gracefully:
 *
 *  1. logSecurityEvent() ALWAYS runs and writes one line of structured JSON
 *     to stderr. On Vercel this lands in the function's logs with zero
 *     extra setup — no env var required. This is the floor: even if you
 *     never configure a webhook, failed auth attempts are not silently
 *     invisible.
 *  2. sendSecurityAlert() additionally POSTs the same event to
 *     SECURITY_ALERT_WEBHOOK_URL (a Slack or Discord "incoming webhook"
 *     URL) if that env var is set, so an attempted intrusion surfaces as a
 *     push notification instead of only being visible if/when someone
 *     happens to open the Vercel log viewer.
 *
 * Never include the actual secret value being checked (bearer token,
 * client_secret, code_verifier, etc.) in a logged/alerted event — only
 * metadata about the failed attempt (reason, IP, path, time). The whole
 * point of this module is to help detect a leak, so it must not itself
 * become a new place secrets can leak from (log aggregators, Slack
 * channels, etc. are not necessarily as tightly access-controlled as the
 * env vars themselves).
 */

export interface SecurityEvent {
  event: string;
  reason: string;
  ip: string;
  userAgent: string;
  path: string;
  time: string;
  [key: string]: unknown;
}

/**
 * Best-effort client IP extraction. This is a triage signal only, NOT a
 * security control — do not use it for allow/deny decisions, rate limiting,
 * or anything else that assumes it can't be forged.
 *
 * We take the leftmost entry of `x-forwarded-for`, which is the entry a
 * client can set itself: `x-forwarded-for` is a comma-separated list that
 * each proxy hop is expected to *append* to, so the leftmost value is
 * whatever the original request arrived with (attacker-controlled) and the
 * rightmost entries are the ones added by infrastructure closer to us. This
 * code assumes Vercel's edge appends the real connecting IP as a trusted
 * hop rather than overwriting/discarding a spoofed incoming header — that
 * assumption is not verified here (it would need a real Vercel deployment
 * to confirm) and may not hold. Net effect: this value may simply be
 * whatever an attacker chose to send, not the true connecting IP. Treat it
 * as "best available hint for a human reading the logs", never as proof of
 * where a request came from.
 */
export function getClientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}

/**
 * Truncates a string value so a single oversized attacker-controlled field
 * (redirect_uri, client_id, user-agent, etc.) can't blow up the logged JSON
 * line or webhook message body. Non-string values are passed through
 * unchanged — callers only apply this to fields expected to be strings.
 */
export function truncate(value: unknown, max = 200): unknown {
  if (typeof value !== "string" || value.length <= max) return value;
  return `${value.slice(0, max)}...[truncated]`;
}

export function buildSecurityEvent(
  req: Request,
  event: string,
  reason: string,
  extra: Record<string, unknown> = {}
): SecurityEvent {
  const truncatedExtra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    truncatedExtra[key] = truncate(value);
  }
  return {
    event,
    reason,
    ip: getClientIp(req),
    userAgent: truncate(req.headers.get("user-agent") ?? "unknown") as string,
    path: new URL(req.url).pathname,
    time: new Date().toISOString(),
    ...truncatedExtra,
  };
}

/**
 * Shared plumbing for every auth-failure reporting call site in this repo:
 * build the structured event, always log it, and best-effort schedule the
 * webhook alert. `event` distinguishes which surface failed
 * ("mcp_auth_failure", "oauth_authorize_failure", "oauth_token_failure");
 * `reason` distinguishes why. Callers typically wrap this with a
 * fixed-`event` helper (see reportAuthFailure in lib/auth.ts and
 * reportOAuthFailure in the two OAuth route files) rather than calling it
 * directly.
 */
export function reportSecurityFailure(
  req: Request,
  event: string,
  reason: string,
  extra?: Record<string, unknown>
): void {
  const evt = buildSecurityEvent(req, event, reason, extra);
  logSecurityEvent(evt); // always — visible in Vercel's function logs
  scheduleSecurityAlert(evt); // best-effort webhook, non-blocking
}

/**
 * Always logs, never throws. One line of JSON so a log viewer / log drain
 * can filter or alert on `event`/`reason`/`ip` directly instead of parsing
 * free text.
 */
export function logSecurityEvent(e: SecurityEvent): void {
  console.error(JSON.stringify(e));
}

/**
 * Schedules sendSecurityAlert() without making the caller await it.
 *
 * Prefers Next's `after()` so the webhook POST runs once the response has
 * already been sent — no added latency on the auth check, and (unlike a
 * bare un-awaited call) not at risk of being cut off mid-flight if the
 * serverless function is frozen right after responding.
 *
 * `after()` only works inside an active Next.js request scope (a Route
 * Handler, Server Action, or Middleware actually handling a request) — it
 * throws when called from anywhere else, e.g. a unit test that calls
 * verifyBearerToken()/this module directly instead of going through a real
 * HTTP request. That's caught here and falls back to a plain fire-and-forget
 * call, so this function is safe to call unconditionally from both
 * production route handlers and tests.
 */
export function scheduleSecurityAlert(e: SecurityEvent): void {
  try {
    after(() => sendSecurityAlert(e));
  } catch {
    void sendSecurityAlert(e);
  }
}

/**
 * Best-effort webhook alert. Prefer scheduleSecurityAlert() (above) from
 * callers — call this directly only if you already have your own reason to
 * control the awaiting/scheduling yourself.
 */
export async function sendSecurityAlert(e: SecurityEvent): Promise<void> {
  const webhookUrl = process.env.SECURITY_ALERT_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Slack's incoming-webhook format wants a top-level "text" field.
      // Discord's *native* incoming-webhook format wants "content" instead
      // — it only understands "text" at the Slack-compatibility endpoint
      // (same URL + "/slack" suffix). Sending both keys means this same
      // body works unmodified against a bare Discord webhook URL, a
      // Discord webhook URL with "/slack" appended, and a Slack webhook
      // URL — each provider ignores keys it doesn't recognize. If you
      // point this at some other webhook provider, adjust the body shape
      // to match what it expects.
      body: JSON.stringify({
        content: `🚨 [${e.event}] ${e.reason} — ip=${e.ip} path=${e.path} ua="${e.userAgent}" at ${e.time}`,
        text: `🚨 [${e.event}] ${e.reason} — ip=${e.ip} path=${e.path} ua="${e.userAgent}" at ${e.time}`,
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    // Alerting must never break auth or throw into the caller. Log the
    // delivery failure itself (not the original event, already logged by
    // the caller) so a broken/expired webhook URL doesn't fail silently
    // forever — you'll see *this* line in Vercel's logs even if the
    // webhook never arrives.
    console.error(
      JSON.stringify({
        event: "security_alert_delivery_failed",
        error: err instanceof Error ? err.message : String(err),
        time: new Date().toISOString(),
      })
    );
  }
}
