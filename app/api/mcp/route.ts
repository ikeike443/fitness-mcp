import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { verifyBearerToken } from "@/lib/auth";
import {
  listRecentWorkouts,
  getWorkoutDetail,
  getBodyMeasurements,
} from "@/lib/hevy";
import {
  getDailyMacros,
  getWeightTrend,
  getNutritionTrends,
} from "@/lib/macrofactorStore";

export const maxDuration = 30;

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "get_recent_workouts",
      {
        title: "Get recent Hevy workouts",
        description:
          "List the user's most recent workouts from Hevy, newest first. Each entry includes title, start/end time, and exercise names.",
        inputSchema: z.object({
          limit: z
            .number()
            .int()
            .min(1)
            .max(10)
            .optional()
            .describe(
              "How many recent workouts to return (max 10, default 5)"
            ),
        }),
      },
      async ({ limit }) => {
        const workouts = await listRecentWorkouts(limit ?? 5);
        return {
          content: [
            { type: "text", text: JSON.stringify(workouts, null, 2) },
          ],
        };
      }
    );

    server.registerTool(
      "get_workout_detail",
      {
        title: "Get Hevy workout detail",
        description:
          "Get full exercise/set/rep/weight detail for a single Hevy workout by its ID (obtain the ID from get_recent_workouts).",
        inputSchema: z.object({
          workoutId: z.string().describe("The Hevy workout ID"),
        }),
      },
      async ({ workoutId }) => {
        const workout = await getWorkoutDetail(workoutId);
        return {
          content: [
            { type: "text", text: JSON.stringify(workout, null, 2) },
          ],
        };
      }
    );

    server.registerTool(
      "get_body_measurements",
      {
        title: "Get Hevy body measurements",
        description:
          "List the user's most recent body measurements (weight, body fat %, etc.) logged in Hevy.",
        inputSchema: z.object({
          limit: z
            .number()
            .int()
            .min(1)
            .max(10)
            .optional()
            .describe(
              "How many recent measurements to return (max 10, default 10)"
            ),
        }),
      },
      async ({ limit }) => {
        const measurements = await getBodyMeasurements(limit ?? 10);
        return {
          content: [
            { type: "text", text: JSON.stringify(measurements, null, 2) },
          ],
        };
      }
    );

    server.registerTool(
      "get_daily_macros",
      {
        title: "Get daily MacroFactor calories and macros",
        description:
          "Get daily calories, protein, carbs, fat, and step count from MacroFactor for a date range or the last N days. Automatically pulls in any newly exported MacroFactor data from Google Drive first, so it reflects the most recent manual export.",
        inputSchema: z.object({
          days: z
            .number()
            .int()
            .min(1)
            .max(90)
            .optional()
            .describe(
              "Number of most recent days to return (default 14, max 90). Ignored if startDate is given."
            ),
          startDate: z
            .string()
            .optional()
            .describe("Start date YYYY-MM-DD (inclusive)"),
          endDate: z
            .string()
            .optional()
            .describe("End date YYYY-MM-DD (inclusive), default today"),
        }),
      },
      async ({ days, startDate, endDate }) => {
        const macros = await getDailyMacros({ days, startDate, endDate });
        return {
          content: [{ type: "text", text: JSON.stringify(macros, null, 2) }],
        };
      }
    );

    server.registerTool(
      "get_weight_trend",
      {
        title: "Get MacroFactor weight trend",
        description:
          "Get daily body weight, MacroFactor's smoothed weight trend, and body fat % over a date range or the last N days. Automatically pulls in any newly exported MacroFactor data first.",
        inputSchema: z.object({
          days: z
            .number()
            .int()
            .min(1)
            .max(180)
            .optional()
            .describe(
              "Number of most recent days to return (default 30, max 180). Ignored if startDate is given."
            ),
          startDate: z
            .string()
            .optional()
            .describe("Start date YYYY-MM-DD (inclusive)"),
          endDate: z
            .string()
            .optional()
            .describe("End date YYYY-MM-DD (inclusive), default today"),
        }),
      },
      async ({ days, startDate, endDate }) => {
        const trend = await getWeightTrend({ days, startDate, endDate });
        return {
          content: [{ type: "text", text: JSON.stringify(trend, null, 2) }],
        };
      }
    );

    server.registerTool(
      "get_nutrition_trends",
      {
        title: "Get precomputed MacroFactor monthly/yearly trends",
        description:
          "Get precomputed average calories/macros/steps and weight change for a whole month or year. Cheap: reads a precomputed summary instead of rescanning all daily data.",
        inputSchema: z.object({
          period: z
            .enum(["month", "year"])
            .describe("Aggregation period"),
          key: z
            .string()
            .optional()
            .describe(
              "'YYYY-MM' for month or 'YYYY' for year; defaults to the current month/year"
            ),
        }),
      },
      async ({ period, key }) => {
        const trends = await getNutritionTrends({ period, key });
        return {
          content: [{ type: "text", text: JSON.stringify(trends, null, 2) }],
        };
      }
    );
  },
  {
    serverInfo: { name: "fitness-mcp", version: "0.1.0" },
  }
);

const authedHandler = withMcpAuth(handler, verifyBearerToken, {
  required: true,
});

export { authedHandler as GET, authedHandler as POST };
