import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { verifyBearerToken } from "@/lib/auth";
import {
  listRecentWorkouts,
  getWorkoutDetail,
  getBodyMeasurements,
} from "@/lib/hevy";

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
  },
  {
    serverInfo: { name: "fitness-mcp", version: "0.1.0" },
  }
);

const authedHandler = withMcpAuth(handler, verifyBearerToken, {
  required: true,
});

export { authedHandler as GET, authedHandler as POST };
