import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildSecurityEvent,
  sendSecurityAlert,
  truncate,
} from "../../lib/securityAlert";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://fitness-mcp.example/api/oauth/token", {
    headers,
  });
}

describe("truncate", () => {
  it("leaves short strings and non-strings unchanged", () => {
    expect(truncate("short")).toBe("short");
    expect(truncate(null)).toBe(null);
    expect(truncate(undefined)).toBe(undefined);
    expect(truncate(42)).toBe(42);
  });

  it("truncates strings longer than max with a marker", () => {
    const long = "a".repeat(300);
    const result = truncate(long) as string;
    expect(result.length).toBeLessThan(long.length);
    expect(result.endsWith("...[truncated]")).toBe(true);
    expect(result.startsWith("a".repeat(200))).toBe(true);
  });

  it("respects a custom max", () => {
    const result = truncate("abcdefghij", 5) as string;
    expect(result).toBe("abcde...[truncated]");
  });
});

describe("buildSecurityEvent", () => {
  it("truncates an oversized user-agent header", () => {
    const longUa = "x".repeat(500);
    const evt = buildSecurityEvent(
      makeRequest({ "user-agent": longUa }),
      "oauth_token_failure",
      "invalid_client"
    );
    expect((evt.userAgent as string).length).toBeLessThan(longUa.length);
    expect(evt.userAgent).toMatch(/\.\.\.\[truncated\]$/);
  });

  it("truncates oversized string fields passed via extra", () => {
    const longRedirectUri = `https://claude.ai/${"a".repeat(500)}`;
    const evt = buildSecurityEvent(
      makeRequest(),
      "oauth_authorize_failure",
      "disallowed_redirect_uri",
      { redirectUri: longRedirectUri, clientId: null }
    );
    expect((evt.redirectUri as string).length).toBeLessThan(
      longRedirectUri.length
    );
    expect(evt.redirectUri).toMatch(/\.\.\.\[truncated\]$/);
    // Non-string extras (e.g. null for a missing field) pass through as-is.
    expect(evt.clientId).toBe(null);
  });

  it("leaves normal-length fields untouched", () => {
    const evt = buildSecurityEvent(
      makeRequest({ "user-agent": "curl/8.0" }),
      "mcp_auth_failure",
      "invalid_token"
    );
    expect(evt.userAgent).toBe("curl/8.0");
  });
});

describe("sendSecurityAlert", () => {
  it("POSTs a body containing both 'content' (Discord-native) and 'text' (Slack / Discord-slack-compat) keys", async () => {
    process.env.SECURITY_ALERT_WEBHOOK_URL = "https://discord.example/webhook";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const evt = buildSecurityEvent(
      makeRequest({ "user-agent": "curl/8.0" }),
      "oauth_token_failure",
      "invalid_client"
    );
    await sendSecurityAlert(evt);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(typeof body.content).toBe("string");
    expect(typeof body.text).toBe("string");
    expect(body.content).toBe(body.text);
    expect(body.content).toContain("invalid_client");
  });

  it("carries a truncated field through into the webhook text", async () => {
    process.env.SECURITY_ALERT_WEBHOOK_URL = "https://discord.example/webhook";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const longUa = "x".repeat(500);
    const evt = buildSecurityEvent(
      makeRequest({ "user-agent": longUa }),
      "oauth_token_failure",
      "invalid_client"
    );
    await sendSecurityAlert(evt);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.text).not.toContain(longUa);
    expect(body.text).toContain("...[truncated]");
  });
});
