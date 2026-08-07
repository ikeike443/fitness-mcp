import { Readable } from "node:stream";
import { google, type drive_v3, type sheets_v4 } from "googleapis";

/**
 * Auth: OAuth 2.0 with a stored refresh token for the user's own Google
 * account — NOT a service account.
 *
 * A service account was tried first and doesn't work here: on a personal
 * (non-Workspace) Gmail account, service accounts have zero storage quota
 * of their own, so Drive rejects `files.create` (and, in some cases,
 * `files.update`) with "Service Accounts do not have storage quota" even
 * when the target folder is shared with them as Editor. Shared Drives
 * (which sidestep this) and domain-wide delegation are both
 * Workspace-only, unavailable here. Authenticating as the real account via
 * OAuth avoids the problem entirely — every file this app touches is
 * simply owned by the user, same as if they'd created it by hand — and as
 * a bonus, no folder-sharing step is needed since the app acts as the
 * account that already owns "Health data".
 */

let cachedAuth: InstanceType<typeof google.auth.OAuth2> | null = null;

function getAuthClient() {
  if (cachedAuth) return cachedAuth;

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REFRESH_TOKEN must all be set"
    );
  }

  const client = new google.auth.OAuth2(clientId, clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  cachedAuth = client;
  return cachedAuth;
}

function getClients() {
  const auth = getAuthClient();
  const drive = google.drive({ version: "v3", auth });
  const sheets = google.sheets({ version: "v4", auth });
  return { drive, sheets };
}

export interface DriveFile {
  id: string;
  name: string;
  modifiedTime: string;
  createdTime: string;
}

function toDriveFile(f: drive_v3.Schema$File): DriveFile {
  return {
    id: f.id!,
    name: f.name!,
    modifiedTime: f.modifiedTime!,
    createdTime: f.createdTime!,
  };
}

export async function listFilesInFolder(
  folderId: string,
  opts?: { nameContains?: string; mimeType?: string; modifiedAfter?: string }
): Promise<DriveFile[]> {
  const { drive } = getClients();
  const clauses = [`'${folderId}' in parents`, "trashed = false"];
  if (opts?.nameContains) clauses.push(`name contains '${opts.nameContains}'`);
  if (opts?.mimeType) clauses.push(`mimeType = '${opts.mimeType}'`);
  if (opts?.modifiedAfter) clauses.push(`modifiedTime > '${opts.modifiedAfter}'`);

  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: clauses.join(" and "),
      fields: "nextPageToken, files(id, name, modifiedTime, createdTime)",
      pageSize: 100,
      pageToken,
    });
    for (const f of res.data.files ?? []) files.push(toDriveFile(f));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return files;
}

async function findChildByName(
  drive: drive_v3.Drive,
  parentId: string,
  name: string
): Promise<DriveFile | null> {
  const res = await drive.files.list({
    q: `'${parentId}' in parents and trashed = false and name = '${name}'`,
    fields: "files(id, name, modifiedTime, createdTime)",
    pageSize: 1,
  });
  const f = res.data.files?.[0];
  return f ? toDriveFile(f) : null;
}

export async function ensureFolder(
  parentFolderId: string,
  name: string
): Promise<string> {
  const { drive } = getClients();
  const existing = await findChildByName(drive, parentFolderId, name);
  if (existing) return existing.id;

  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentFolderId],
    },
    fields: "id",
  });
  return res.data.id!;
}

export async function readJsonFile<T>(
  folderId: string,
  name: string
): Promise<T | null> {
  const { drive } = getClients();
  const file = await findChildByName(drive, folderId, name);
  if (!file) return null;

  const res = await drive.files.get(
    { fileId: file.id, alt: "media" },
    { responseType: "text" }
  );
  return JSON.parse(res.data as unknown as string) as T;
}

export async function writeJsonFile(
  folderId: string,
  name: string,
  data: unknown
): Promise<string> {
  const { drive } = getClients();
  const existing = await findChildByName(drive, folderId, name);
  const body = JSON.stringify(data, null, 2);
  const media = { mimeType: "application/json", body };

  if (existing) {
    const res = await drive.files.update({
      fileId: existing.id,
      media,
      fields: "id",
    });
    return res.data.id!;
  }

  const res = await drive.files.create({
    requestBody: { name, parents: [folderId] },
    media,
    fields: "id",
  });
  return res.data.id!;
}

export async function readGzipJsonFile<T>(
  folderId: string,
  name: string
): Promise<T | null> {
  const { drive } = getClients();
  const file = await findChildByName(drive, folderId, name);
  if (!file) return null;

  const res = await drive.files.get(
    { fileId: file.id, alt: "media" },
    { responseType: "arraybuffer" }
  );
  const zlib = await import("node:zlib");
  const buf = zlib.gunzipSync(Buffer.from(res.data as ArrayBuffer));
  return JSON.parse(buf.toString("utf-8")) as T;
}

export async function writeGzipJsonFile(
  folderId: string,
  name: string,
  data: unknown
): Promise<string> {
  const { drive } = getClients();
  const zlib = await import("node:zlib");
  const buf = zlib.gzipSync(Buffer.from(JSON.stringify(data)));
  const existing = await findChildByName(drive, folderId, name);
  const media = { mimeType: "application/gzip", body: Readable.from(buf) };

  if (existing) {
    const res = await drive.files.update({
      fileId: existing.id,
      media,
      fields: "id",
    });
    return res.data.id!;
  }

  const res = await drive.files.create({
    requestBody: { name, parents: [folderId] },
    media,
    fields: "id",
  });
  return res.data.id!;
}

export async function getSpreadsheetTabTitles(
  spreadsheetId: string
): Promise<string[]> {
  const { sheets } = getClients();
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties.title",
  });
  return (res.data.sheets ?? [])
    .map((s) => s.properties?.title)
    .filter((t): t is string => Boolean(t));
}

export async function batchGetTabValues(
  spreadsheetId: string,
  sheetNames: string[]
): Promise<Record<string, string[][]>> {
  if (sheetNames.length === 0) return {};
  const { sheets } = getClients();
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: sheetNames.map((n) => `'${n}'`),
    valueRenderOption: "FORMATTED_VALUE",
  });

  const out: Record<string, string[][]> = {};
  const valueRanges = res.data.valueRanges as sheets_v4.Schema$ValueRange[] | undefined;
  (valueRanges ?? []).forEach((vr, i) => {
    out[sheetNames[i]] = (vr.values ?? []) as string[][];
  });
  return out;
}
