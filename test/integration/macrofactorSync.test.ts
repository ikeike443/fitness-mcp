import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../lib/googleDrive", () => import("../fixtures/fakeGoogleDrive"));

import {
  resetFakeDrive,
  seedExportFile,
  getWrittenJson,
  listFilesInFolder,
  writeJsonFile,
} from "../fixtures/fakeGoogleDrive";
import {
  getDailyMacros,
  getWeightTrend,
  getNutritionTrends,
  HEALTH_DATA_FOLDER_ID,
  type DailySummary,
} from "../../lib/macrofactorStore";

const STORE_FOLDER_ID = `${HEALTH_DATA_FOLDER_ID}/_store`;

const CALORIES_TAB = "カロリー＆PFC";
const WEIGHT_TAB = "体重実測値";

function caloriesRows(rows: Array<[string, number]>) {
  return [
    ["日時", "カロリー（kcal ）", "脂質（g ）", "炭水化物（g ）", "たんぱく質（g ）"],
    ...rows.map(([date, kcal]) => [date, String(kcal), "50", "200", "150"]),
  ];
}

function weightRows(rows: Array<[string, number]>) {
  return [
    ["日時", "体重（kg ）", "体脂肪率"],
    ...rows.map(([date, kg]) => [date, String(kg), "16"]),
  ];
}

beforeEach(() => {
  resetFakeDrive();
  vi.clearAllMocks();
});

describe("macrofactorStore sync (via fake Drive)", () => {
  it("processes a single export file and returns its daily data", async () => {
    seedExportFile(HEALTH_DATA_FOLDER_ID, {
      name: "MacroFactor-20260601090000",
      modifiedTime: "2026-06-01T09:00:00.000Z",
      tabs: {
        [CALORIES_TAB]: caloriesRows([
          ["2026/6/1", 2000],
          ["2026/6/2", 2100],
        ]),
        [WEIGHT_TAB]: weightRows([["2026/6/1", 78.0]]),
      },
    });

    const macros = await getDailyMacros({ startDate: "2026-06-01", endDate: "2026-06-02" });
    expect(macros).toEqual([
      { date: "2026-06-01", calories: 2000, proteinG: 150, carbsG: 200, fatG: 50, steps: undefined },
      { date: "2026-06-02", calories: 2100, proteinG: 150, carbsG: 200, fatG: 50, steps: undefined },
    ]);

    const weight = await getWeightTrend({ startDate: "2026-06-01", endDate: "2026-06-01" });
    expect(weight).toEqual([
      { date: "2026-06-01", weightKg: 78.0, weightTrendKg: undefined, bodyFatPercent: 16 },
    ]);
  });

  it("does no writes on a second call when no new export exists (fast path)", async () => {
    seedExportFile(HEALTH_DATA_FOLDER_ID, {
      name: "MacroFactor-20260601090000",
      modifiedTime: "2026-06-01T09:00:00.000Z",
      tabs: { [CALORIES_TAB]: caloriesRows([["2026/6/1", 2000]]) },
    });

    await getDailyMacros({ startDate: "2026-06-01", endDate: "2026-06-01" });
    const writesAfterFirstCall = vi.mocked(writeJsonFile).mock.calls.length;
    expect(writesAfterFirstCall).toBeGreaterThan(0);

    vi.mocked(writeJsonFile).mockClear();
    vi.mocked(listFilesInFolder).mockClear();

    await getDailyMacros({ startDate: "2026-06-01", endDate: "2026-06-01" });
    expect(vi.mocked(writeJsonFile)).not.toHaveBeenCalled();
    expect(vi.mocked(listFilesInFolder)).toHaveBeenCalledTimes(1);
  });

  it("resolves overlapping exports by preferring the more recently exported file", async () => {
    // Older export: 6/1-6/3, values all 2000
    seedExportFile(HEALTH_DATA_FOLDER_ID, {
      name: "MacroFactor-20260604000000",
      modifiedTime: "2026-06-04T00:00:00.000Z",
      tabs: {
        [CALORIES_TAB]: caloriesRows([
          ["2026/6/1", 2000],
          ["2026/6/2", 2000],
          ["2026/6/3", 2000],
        ]),
      },
    });
    await getDailyMacros({ startDate: "2026-06-01", endDate: "2026-06-03" });

    // Newer export (later exportedAt): 6/2-6/4, values all 3000 — should win on the
    // overlapping 6/2 and 6/3, and add new data for 6/4, while 6/1 (not covered by
    // this file) stays untouched.
    seedExportFile(HEALTH_DATA_FOLDER_ID, {
      name: "MacroFactor-20260705000000",
      modifiedTime: "2026-07-05T00:00:00.000Z",
      tabs: {
        [CALORIES_TAB]: caloriesRows([
          ["2026/6/2", 3000],
          ["2026/6/3", 3000],
          ["2026/6/4", 3000],
        ]),
      },
    });

    const macros = await getDailyMacros({ startDate: "2026-06-01", endDate: "2026-06-04" });
    const byDate = Object.fromEntries(macros.map((m) => [m.date, m.calories]));
    expect(byDate["2026-06-01"]).toBe(2000); // only in the older file
    expect(byDate["2026-06-02"]).toBe(3000); // overlap: newer wins
    expect(byDate["2026-06-03"]).toBe(3000); // overlap: newer wins
    expect(byDate["2026-06-04"]).toBe(3000); // only in the newer file
  });

  it("persists the merged store back through writeJsonFile", async () => {
    seedExportFile(HEALTH_DATA_FOLDER_ID, {
      name: "MacroFactor-20260601090000",
      modifiedTime: "2026-06-01T09:00:00.000Z",
      tabs: { [CALORIES_TAB]: caloriesRows([["2026/6/1", 2000]]) },
    });

    await getDailyMacros({ startDate: "2026-06-01", endDate: "2026-06-01" });

    const daily = getWrittenJson<DailySummary>(STORE_FOLDER_ID, "daily-summary.json");
    expect(daily?.["2026-06-01"].calories).toBe(2000);
  });

  it("computes monthly rollups incrementally as new exports are merged", async () => {
    seedExportFile(HEALTH_DATA_FOLDER_ID, {
      name: "MacroFactor-20260601090000",
      modifiedTime: "2026-06-01T09:00:00.000Z",
      tabs: {
        [CALORIES_TAB]: caloriesRows([
          ["2026/6/1", 2000],
          ["2026/6/2", 2200],
        ]),
      },
    });

    const trends = await getNutritionTrends({ period: "month", key: "2026-06" });
    expect(trends).toMatchObject({ month: "2026-06", daysLogged: 2, avgCalories: 2100 });
  });

  it("returns a friendly message for a period with no data at all", async () => {
    const trends = await getNutritionTrends({ period: "year", key: "2019" });
    expect(trends).toMatchObject({ message: expect.stringContaining("2019") });
  });
});
