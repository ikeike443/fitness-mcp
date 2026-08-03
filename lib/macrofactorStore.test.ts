import { describe, it, expect } from "vitest";
import {
  normalizeDate,
  parseTabRows,
  parseExportedAtFromName,
  computeMonthlyRollup,
  computeYearlyRollup,
  resolveRange,
  type DailySummary,
} from "./macrofactorStore";

describe("normalizeDate", () => {
  it("normalizes MacroFactor's unpadded M/D slash format", () => {
    expect(normalizeDate("2026/8/3")).toBe("2026-08-03");
    expect(normalizeDate("2026/12/25")).toBe("2026-12-25");
  });

  it("passes through already-ISO dates", () => {
    expect(normalizeDate("2026-08-03")).toBe("2026-08-03");
  });

  it("returns null for unrecognized formats", () => {
    expect(normalizeDate("not a date")).toBeNull();
    expect(normalizeDate("")).toBeNull();
  });
});

describe("parseExportedAtFromName", () => {
  it("parses the MacroFactor export filename timestamp", () => {
    expect(parseExportedAtFromName("MacroFactor-20260803144822")).toBe(
      "2026-08-03T14:48:22Z"
    );
  });

  it("returns null for names that don't match the pattern", () => {
    expect(parseExportedAtFromName("workouts (3).csv")).toBeNull();
    expect(parseExportedAtFromName("MacroFactor-not-a-timestamp")).toBeNull();
  });
});

describe("parseTabRows", () => {
  // Header/row shapes below are taken verbatim from a real MacroFactor
  // Granular Export spreadsheet.
  it("parses the カロリー＆PFC tab", () => {
    const rows = [
      ["日時", "カロリー（kcal ）", "脂質（g ）", "炭水化物（g ）", "たんぱく質（g ）"],
      ["2026/6/25", "2068", "57", "252", "143"],
      ["2026/6/26", "1905", "73", "167", "155"],
    ];
    const parsed = parseTabRows("カロリー＆PFC", rows);
    expect(parsed["2026-06-25"]).toEqual({
      calories: 2068,
      fatG: 57,
      carbsG: 252,
      proteinG: 143,
    });
    expect(parsed["2026-06-26"].calories).toBe(1905);
  });

  it("parses the 体重実測値 tab", () => {
    const rows = [
      ["日時", "体重（kg ）", "体脂肪率"],
      ["2026/6/25", "77.9", "16"],
    ];
    expect(parseTabRows("体重実測値", rows)["2026-06-25"]).toEqual({
      weightKg: 77.9,
      bodyFatPercent: 16,
    });
  });

  it("parses the 体重傾向値 tab", () => {
    const rows = [
      ["日時", "体重傾向値（kg ）"],
      ["2026/6/25", "78.08"],
    ];
    expect(parseTabRows("体重傾向値", rows)["2026-06-25"]).toEqual({
      weightTrendKg: 78.08,
    });
  });

  it("parses the 歩数 tab", () => {
    const rows = [
      ["日時", "歩数"],
      ["2026/6/25", "9786"],
    ];
    expect(parseTabRows("歩数", rows)["2026-06-25"]).toEqual({ steps: 9786 });
  });

  it("treats blank cells as missing rather than zero", () => {
    const rows = [
      ["日時", "カロリー（kcal ）", "脂質（g ）", "炭水化物（g ）", "たんぱく質（g ）"],
      ["2026/6/25", "", "", "", ""],
    ];
    const parsed = parseTabRows("カロリー＆PFC", rows);
    expect(parsed["2026-06-25"].calories).toBeUndefined();
    expect(parsed["2026-06-25"].fatG).toBeUndefined();
  });

  it("returns an empty object for a tab with only a header row", () => {
    expect(parseTabRows("歩数", [["日時", "歩数"]])).toEqual({});
  });

  it("returns an empty object when no date column is found", () => {
    expect(
      parseTabRows("歩数", [
        ["foo", "bar"],
        ["1", "2"],
      ])
    ).toEqual({});
  });

  it("skips rows with a missing or unparseable date", () => {
    const rows = [
      ["日時", "歩数"],
      ["", "9786"],
      ["not a date", "5000"],
      ["2026/6/25", "1000"],
    ];
    const parsed = parseTabRows("歩数", rows);
    expect(Object.keys(parsed)).toEqual(["2026-06-25"]);
  });
});

describe("computeMonthlyRollup / computeYearlyRollup", () => {
  const daily: DailySummary = {
    "2026-06-25": {
      calories: 2000,
      proteinG: 140,
      carbsG: 200,
      fatG: 60,
      steps: 8000,
      weightKg: 78.0,
    },
    "2026-06-26": {
      calories: 2200,
      proteinG: 150,
      carbsG: 220,
      fatG: 65,
      steps: 9000,
      weightKg: 77.5,
    },
    "2026-07-01": {
      calories: 2400,
      proteinG: 160,
      carbsG: 240,
      fatG: 70,
      steps: 10000,
      weightKg: 77.0,
    },
  };

  it("computes a monthly rollup scoped to just that month", () => {
    const rollup = computeMonthlyRollup(daily, "2026-06");
    expect(rollup.month).toBe("2026-06");
    expect(rollup.daysLogged).toBe(2);
    expect(rollup.avgCalories).toBe(2100);
    expect(rollup.startWeightKg).toBe(78.0);
    expect(rollup.endWeightKg).toBe(77.5);
    expect(rollup.weightChangeKg).toBe(-0.5);
  });

  it("computes a yearly rollup spanning all matching months", () => {
    const rollup = computeYearlyRollup(daily, "2026");
    expect(rollup.daysLogged).toBe(3);
    expect(rollup.monthsWithData).toEqual(["2026-06", "2026-07"]);
    expect(rollup.startWeightKg).toBe(78.0);
    expect(rollup.endWeightKg).toBe(77.0);
  });

  it("returns nulls (not zeros or crashes) for a period with no data", () => {
    const rollup = computeMonthlyRollup(daily, "2025-01");
    expect(rollup.daysLogged).toBe(0);
    expect(rollup.avgCalories).toBeNull();
    expect(rollup.weightChangeKg).toBeNull();
  });
});

describe("resolveRange", () => {
  it("defaults to the last N days ending today", () => {
    const { start, end } = resolveRange({ days: 7 }, 14, 90);
    const diffDays = Math.round(
      (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000
    );
    expect(diffDays).toBe(6);
  });

  it("caps the day count at maxDays", () => {
    const { start, end } = resolveRange({ days: 1000 }, 14, 90);
    const diffDays = Math.round(
      (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000
    );
    expect(diffDays).toBe(89);
  });

  it("uses startDate/endDate directly when given, ignoring days", () => {
    const { start, end } = resolveRange(
      { startDate: "2026-01-01", endDate: "2026-01-10", days: 3 },
      14,
      90
    );
    expect(start).toBe("2026-01-01");
    expect(end).toBe("2026-01-10");
  });
});
