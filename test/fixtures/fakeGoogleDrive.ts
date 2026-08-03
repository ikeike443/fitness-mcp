import { vi } from "vitest";

interface FakeFile {
  id: string;
  name: string;
  modifiedTime: string;
  createdTime: string;
  mimeType: string;
}

interface FakeSpreadsheet {
  tabs: Record<string, string[][]>;
}

let filesByFolder = new Map<string, FakeFile[]>();
let jsonStore = new Map<string, unknown>();
let spreadsheets = new Map<string, FakeSpreadsheet>();
let nextId = 1;

function jsonKey(folderId: string, name: string): string {
  return `${folderId}::${name}`;
}

/** Resets all in-memory state. Call in beforeEach for test isolation. */
export function resetFakeDrive(): void {
  filesByFolder = new Map();
  jsonStore = new Map();
  spreadsheets = new Map();
  nextId = 1;
}

/** Registers a fake MacroFactor export spreadsheet inside `folderId`. */
export function seedExportFile(
  folderId: string,
  opts: {
    name: string;
    modifiedTime: string;
    createdTime?: string;
    tabs: Record<string, string[][]>;
  }
): string {
  const id = `file-${nextId++}`;
  const file: FakeFile = {
    id,
    name: opts.name,
    modifiedTime: opts.modifiedTime,
    createdTime: opts.createdTime ?? opts.modifiedTime,
    mimeType: "application/vnd.google-apps.spreadsheet",
  };
  const existing = filesByFolder.get(folderId) ?? [];
  existing.push(file);
  filesByFolder.set(folderId, existing);
  spreadsheets.set(id, { tabs: opts.tabs });
  return id;
}

/** Reads back whatever the code under test wrote via the mocked writeJsonFile. */
export function getWrittenJson<T>(folderId: string, name: string): T | undefined {
  return jsonStore.get(jsonKey(folderId, name)) as T | undefined;
}

// -- mocked lib/googleDrive.ts surface --
// Signatures mirror the real module; macrofactorStore.ts is unaware it's
// talking to an in-memory fake instead of the real Drive/Sheets APIs.

export const listFilesInFolder = vi.fn(
  async (
    folderId: string,
    opts?: { nameContains?: string; mimeType?: string; modifiedAfter?: string }
  ) => {
    const files = filesByFolder.get(folderId) ?? [];
    return files
      .filter((f) => {
        if (opts?.nameContains && !f.name.includes(opts.nameContains)) return false;
        if (opts?.mimeType && f.mimeType !== opts.mimeType) return false;
        if (opts?.modifiedAfter && !(f.modifiedTime > opts.modifiedAfter)) return false;
        return true;
      })
      .map(({ id, name, modifiedTime, createdTime }) => ({
        id,
        name,
        modifiedTime,
        createdTime,
      }));
  }
);

export const ensureFolder = vi.fn(async (parentFolderId: string, name: string) => {
  return `${parentFolderId}/${name}`;
});

export const readJsonFile = vi.fn(async (folderId: string, name: string) => {
  return jsonStore.get(jsonKey(folderId, name)) ?? null;
});

export const writeJsonFile = vi.fn(
  async (folderId: string, name: string, data: unknown) => {
    jsonStore.set(jsonKey(folderId, name), data);
    return `written-${jsonKey(folderId, name)}`;
  }
);

export const getSpreadsheetTabTitles = vi.fn(async (spreadsheetId: string) => {
  const sheet = spreadsheets.get(spreadsheetId);
  return sheet ? Object.keys(sheet.tabs) : [];
});

export const batchGetTabValues = vi.fn(
  async (spreadsheetId: string, sheetNames: string[]) => {
    const sheet = spreadsheets.get(spreadsheetId);
    const out: Record<string, string[][]> = {};
    for (const name of sheetNames) {
      out[name] = sheet?.tabs[name] ?? [];
    }
    return out;
  }
);
