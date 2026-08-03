import {
  listFilesInFolder,
  ensureFolder,
  readJsonFile,
  writeJsonFile,
  getSpreadsheetTabTitles,
  batchGetTabValues,
} from "./googleDrive";

const HEALTH_DATA_FOLDER_ID = "1935fgdgA5VVjTp9olOZ39Q0c5mv8Vx4B";
const STORE_FOLDER_NAME = "_store";
const META_FILE = "meta.json";
const DAILY_FILE = "daily-summary.json";
const MONTHLY_ROLLUP_FILE = "rollups-monthly.json";
const YEARLY_ROLLUP_FILE = "rollups-yearly.json";

const TAB_CALORIES = "カロリー＆PFC";
const TAB_WEIGHT = "体重実測値";
const TAB_WEIGHT_TREND = "体重傾向値";
const TAB_STEPS = "歩数";
const KNOWN_TABS = [TAB_CALORIES, TAB_WEIGHT, TAB_WEIGHT_TREND, TAB_STEPS];

export interface DailyEntry {
  calories?: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
  weightKg?: number;
  weightTrendKg?: number;
  bodyFatPercent?: number;
  steps?: number;
  sourceExportedAt?: string;
}
export type DailySummary = Record<string, DailyEntry>;

interface StoreMeta {
  schemaVersion: number;
  processedFiles: Record<
    string,
    { modifiedTime: string; exportedAt: string; processedAt: string }
  >;
  lastSyncAt: string;
}

export interface PeriodStats {
  daysLogged: number;
  avgCalories: number | null;
  avgProteinG: number | null;
  avgCarbsG: number | null;
  avgFatG: number | null;
  avgSteps: number | null;
  startWeightKg: number | null;
  endWeightKg: number | null;
  weightChangeKg: number | null;
  updatedAt: string;
}
export interface MonthlyRollup extends PeriodStats {
  month: string;
}
export interface YearlyRollup extends PeriodStats {
  year: string;
  monthsWithData: string[];
}

function parseExportedAtFromName(name: string): string | null {
  const m = name.match(/^MacroFactor-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}

function normalizeDate(raw: string): string | null {
  const trimmed = raw.trim();
  const slashMatch = trimmed.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (slashMatch) {
    const [, y, mo, d] = slashMatch;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return isoMatch[0];
  return null;
}

function columnIndex(headers: string[], candidates: string[]): number {
  for (const c of candidates) {
    const idx = headers.findIndex((h) => h.startsWith(c));
    if (idx !== -1) return idx;
  }
  return -1;
}

function parseNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function parseTabRows(
  tabName: string,
  rows: string[][]
): Record<string, Partial<DailyEntry>> {
  const out: Record<string, Partial<DailyEntry>> = {};
  if (rows.length < 2) return out;

  const headers = rows[0];
  const dateIdx = columnIndex(headers, ["日時"]);
  if (dateIdx === -1) return out;

  for (const row of rows.slice(1)) {
    const rawDate = row[dateIdx];
    if (!rawDate) continue;
    const date = normalizeDate(rawDate);
    if (!date) continue;

    const entry: Partial<DailyEntry> = {};
    if (tabName === TAB_CALORIES) {
      entry.calories = parseNumber(row[columnIndex(headers, ["カロリー"])]);
      entry.fatG = parseNumber(row[columnIndex(headers, ["脂質"])]);
      entry.carbsG = parseNumber(row[columnIndex(headers, ["炭水化物"])]);
      entry.proteinG = parseNumber(row[columnIndex(headers, ["たんぱく質"])]);
    } else if (tabName === TAB_WEIGHT) {
      entry.weightKg = parseNumber(row[columnIndex(headers, ["体重"])]);
      entry.bodyFatPercent = parseNumber(row[columnIndex(headers, ["体脂肪率"])]);
    } else if (tabName === TAB_WEIGHT_TREND) {
      entry.weightTrendKg = parseNumber(row[columnIndex(headers, ["体重傾向値"])]);
    } else if (tabName === TAB_STEPS) {
      entry.steps = parseNumber(row[columnIndex(headers, ["歩数"])]);
    }

    out[date] = entry;
  }

  return out;
}

async function computeFileDaily(
  spreadsheetId: string
): Promise<Record<string, Partial<DailyEntry>>> {
  const tabTitles = await getSpreadsheetTabTitles(spreadsheetId);
  const wantedTabs = KNOWN_TABS.filter((t) => tabTitles.includes(t));
  if (wantedTabs.length === 0) return {};

  const tabValues = await batchGetTabValues(spreadsheetId, wantedTabs);
  const merged: Record<string, Partial<DailyEntry>> = {};
  for (const tab of wantedTabs) {
    const parsed = parseTabRows(tab, tabValues[tab] ?? []);
    for (const [date, fields] of Object.entries(parsed)) {
      merged[date] = { ...(merged[date] ?? {}), ...fields };
    }
  }
  return merged;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  return Math.round((sum / values.length) * 10) / 10;
}

function computePeriodStats(daily: DailySummary, dates: string[]): PeriodStats {
  const entries = dates.map((d) => daily[d]);
  const numbers = (pick: (e: DailyEntry) => number | undefined) =>
    entries.map(pick).filter((v): v is number => v !== undefined);

  const weightEntries = dates
    .map((d) => ({ date: d, weight: daily[d].weightKg }))
    .filter((e): e is { date: string; weight: number } => e.weight !== undefined);
  const startWeight = weightEntries[0]?.weight ?? null;
  const endWeight = weightEntries[weightEntries.length - 1]?.weight ?? null;

  return {
    daysLogged: dates.length,
    avgCalories: average(numbers((e) => e.calories)),
    avgProteinG: average(numbers((e) => e.proteinG)),
    avgCarbsG: average(numbers((e) => e.carbsG)),
    avgFatG: average(numbers((e) => e.fatG)),
    avgSteps: average(numbers((e) => e.steps)),
    startWeightKg: startWeight,
    endWeightKg: endWeight,
    weightChangeKg:
      startWeight !== null && endWeight !== null
        ? Math.round((endWeight - startWeight) * 10) / 10
        : null,
    updatedAt: new Date().toISOString(),
  };
}

function computeMonthlyRollup(daily: DailySummary, month: string): MonthlyRollup {
  const dates = Object.keys(daily)
    .filter((d) => d.startsWith(month))
    .sort();
  return { month, ...computePeriodStats(daily, dates) };
}

function computeYearlyRollup(daily: DailySummary, year: string): YearlyRollup {
  const dates = Object.keys(daily)
    .filter((d) => d.startsWith(year))
    .sort();
  const monthsWithData = Array.from(new Set(dates.map((d) => d.slice(0, 7)))).sort();
  return { year, monthsWithData, ...computePeriodStats(daily, dates) };
}

async function runSync(): Promise<{ storeFolderId: string; daily: DailySummary }> {
  const storeFolderId = await ensureFolder(HEALTH_DATA_FOLDER_ID, STORE_FOLDER_NAME);
  const meta = (await readJsonFile<StoreMeta>(storeFolderId, META_FILE)) ?? {
    schemaVersion: 1,
    processedFiles: {},
    lastSyncAt: "",
  };

  const candidates = await listFilesInFolder(HEALTH_DATA_FOLDER_ID, {
    nameContains: "MacroFactor-",
    mimeType: "application/vnd.google-apps.spreadsheet",
    modifiedAfter: meta.lastSyncAt || undefined,
  });
  const newFiles = candidates.filter((f) => !meta.processedFiles[f.id]);

  if (newFiles.length === 0) {
    const daily = (await readJsonFile<DailySummary>(storeFolderId, DAILY_FILE)) ?? {};
    return { storeFolderId, daily };
  }

  newFiles.sort((a, b) => {
    const ea = parseExportedAtFromName(a.name) ?? a.createdTime;
    const eb = parseExportedAtFromName(b.name) ?? b.createdTime;
    return ea.localeCompare(eb);
  });

  const daily = (await readJsonFile<DailySummary>(storeFolderId, DAILY_FILE)) ?? {};
  const touchedMonths = new Set<string>();
  const touchedYears = new Set<string>();

  for (const file of newFiles) {
    const exportedAt = parseExportedAtFromName(file.name) ?? file.createdTime;
    const fileDaily = await computeFileDaily(file.id);

    for (const [date, fields] of Object.entries(fileDaily)) {
      const existing = daily[date];
      if (!existing || exportedAt >= (existing.sourceExportedAt ?? "")) {
        daily[date] = { ...fields, sourceExportedAt: exportedAt };
        touchedMonths.add(date.slice(0, 7));
        touchedYears.add(date.slice(0, 4));
      }
    }

    meta.processedFiles[file.id] = {
      modifiedTime: file.modifiedTime,
      exportedAt,
      processedAt: new Date().toISOString(),
    };
    if (file.modifiedTime > meta.lastSyncAt) meta.lastSyncAt = file.modifiedTime;
  }

  await writeJsonFile(storeFolderId, DAILY_FILE, daily);

  const monthlyRollups =
    (await readJsonFile<Record<string, MonthlyRollup>>(
      storeFolderId,
      MONTHLY_ROLLUP_FILE
    )) ?? {};
  const yearlyRollups =
    (await readJsonFile<Record<string, YearlyRollup>>(
      storeFolderId,
      YEARLY_ROLLUP_FILE
    )) ?? {};
  for (const m of touchedMonths) monthlyRollups[m] = computeMonthlyRollup(daily, m);
  for (const y of touchedYears) yearlyRollups[y] = computeYearlyRollup(daily, y);
  await writeJsonFile(storeFolderId, MONTHLY_ROLLUP_FILE, monthlyRollups);
  await writeJsonFile(storeFolderId, YEARLY_ROLLUP_FILE, yearlyRollups);

  await writeJsonFile(storeFolderId, META_FILE, meta);

  return { storeFolderId, daily };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function resolveRange(
  opts: { days?: number; startDate?: string; endDate?: string },
  defaultDays: number,
  maxDays: number
): { start: string; end: string } {
  const end = opts.endDate ?? todayIso();
  if (opts.startDate) return { start: opts.startDate, end };

  const days = Math.min(opts.days ?? defaultDays, maxDays);
  const start = new Date(`${end}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { start: start.toISOString().slice(0, 10), end };
}

export async function getDailyMacros(opts: {
  days?: number;
  startDate?: string;
  endDate?: string;
}) {
  const { daily } = await runSync();
  const { start, end } = resolveRange(opts, 14, 90);
  return Object.keys(daily)
    .filter((d) => d >= start && d <= end)
    .sort()
    .map((d) => {
      const e = daily[d];
      return {
        date: d,
        calories: e.calories,
        proteinG: e.proteinG,
        carbsG: e.carbsG,
        fatG: e.fatG,
        steps: e.steps,
      };
    });
}

export async function getWeightTrend(opts: {
  days?: number;
  startDate?: string;
  endDate?: string;
}) {
  const { daily } = await runSync();
  const { start, end } = resolveRange(opts, 30, 180);
  return Object.keys(daily)
    .filter((d) => d >= start && d <= end)
    .sort()
    .map((d) => {
      const e = daily[d];
      return {
        date: d,
        weightKg: e.weightKg,
        weightTrendKg: e.weightTrendKg,
        bodyFatPercent: e.bodyFatPercent,
      };
    });
}

export async function getNutritionTrends(opts: {
  period: "month" | "year";
  key?: string;
}) {
  const { storeFolderId } = await runSync();

  if (opts.period === "month") {
    const key = opts.key ?? todayIso().slice(0, 7);
    const rollups =
      (await readJsonFile<Record<string, MonthlyRollup>>(
        storeFolderId,
        MONTHLY_ROLLUP_FILE
      )) ?? {};
    return rollups[key] ?? { message: `No data for ${key}` };
  }

  const key = opts.key ?? todayIso().slice(0, 4);
  const rollups =
    (await readJsonFile<Record<string, YearlyRollup>>(
      storeFolderId,
      YEARLY_ROLLUP_FILE
    )) ?? {};
  return rollups[key] ?? { message: `No data for ${key}` };
}
