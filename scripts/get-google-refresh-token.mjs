#!/usr/bin/env node
// One-time helper: obtains a Google OAuth refresh token for this project's
// Drive/Sheets access (see README's "Setting up Google Drive access"
// section for the full setup flow).
//
// Usage:
//   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... \
//     node scripts/get-google-refresh-token.mjs
//
// Requires an OAuth 2.0 Client ID of type "Desktop app" from the Google
// Cloud Console. Desktop clients accept loopback redirects like
// http://localhost:8877 automatically — there's no redirect URI to
// register.

import { google } from "googleapis";
import http from "node:http";
import { randomBytes } from "node:crypto";

const PORT = 8877;
const REDIRECT_URI = `http://localhost:${PORT}`;

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET first " +
      "(from the OAuth client you created in Google Cloud Console)."
  );
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

// CSRF protection on the loopback callback: only accept a redirect that
// echoes back this same value.
const state = randomBytes(16).toString("hex");

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent", // force a refresh_token even if this app was authorized before
  scope: ["https://www.googleapis.com/auth/drive"],
  state,
});

console.log(
  '\nOpen this URL in your browser, sign in with the Google account that\n' +
    'owns the "Health data" folder, and approve access:\n'
);
console.log(authUrl);
console.log(`\nWaiting for the redirect back to ${REDIRECT_URI} ...\n`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const returnedState = url.searchParams.get("state");

  if (error) {
    res.end(`Authorization failed: ${error}. You can close this tab.`);
    console.error(`Authorization failed: ${error}`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.end("No code received. You can close this tab.");
    return;
  }

  if (returnedState !== state) {
    res.end(
      "State mismatch — this redirect wasn't recognized as the one this script started. You can close this tab."
    );
    console.error(
      "\nThe callback's `state` parameter didn't match the one this script " +
        "generated. Refusing to exchange the code (possible CSRF). Run the " +
        "script again and use the printed URL directly."
    );
    server.close();
    process.exit(1);
    return;
  }

  server.close();

  let tokens;
  try {
    ({ tokens } = await oauth2Client.getToken(code));
  } catch (err) {
    res.end(
      "Authorization failed — check the terminal for details. You can close this tab."
    );
    console.error(`\nFailed to exchange the authorization code for tokens: ${err.message}`);
    process.exit(1);
    return;
  }

  if (!tokens.refresh_token) {
    res.end(
      "Authorization did not produce a refresh token — check the terminal for details. You can close this tab."
    );
    console.error(
      "\nNo refresh_token was returned. This usually happens when the app\n" +
        "was already authorized before and Google skips re-issuing one.\n" +
        "Revoke prior access at https://myaccount.google.com/permissions\n" +
        "and run this script again."
    );
    process.exit(1);
    return;
  }

  res.end(
    "Authorization complete — you can close this tab and return to the terminal."
  );
  console.log("\nSet this as GOOGLE_OAUTH_REFRESH_TOKEN:\n");
  console.log(tokens.refresh_token);
  console.log();
});

server.listen(PORT);
