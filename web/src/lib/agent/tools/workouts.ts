import { createWorkout, resolveExerciseIds, type ExerciseInput } from "@/lib/domain/workouts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AgentInputError, type AgentTool } from "../types";

const MAX_EXERCISES_PER_CALL = 40;
const MAX_SETS_PER_EXERCISE = 40;

/**
 * PostgREST returns at most 1000 rows per request. Every read below is
 * paginated against that ceiling rather than chunked by id count: chunking
 * bounds how many ids go into one `in(...)`, which is not the same thing as
 * bounding how many rows come back. 200 workouts' worth of exercises, or 200
 * exercises' worth of sets, can exceed 1000 on their own, and the truncation
 * is silent -- the affected workouts simply come back looking emptier than
 * they are, with tonnage to match.
 */
const PAGE = 1000;
/** How many ids go into one `in(...)` filter, to keep the URL a sane length. */
const CHUNK = 200;

/** Every page of a query, with errors raised rather than dropped. */
async function fetchAllPages<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  what: string,
): Promise<T[]> {
  const all: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await build(offset, offset + PAGE - 1);
    // A dropped error here does not surface as an error: it surfaces as a
    // workout that appears to have no exercises, which reads as fact.
    if (error) throw new Error(`${what}: ${error.message}`);
    const page = (data ?? []) as T[];
    all.push(...page);
    if (page.length < PAGE) return all;
  }
}

/**
 * Rows from `table` whose `column` is in `ids`, chunked and fully paginated.
 *
 * Ordered by `orderCol` and then by id, because `range` pagination needs a
 * total order: exercise_order and set_number both repeat heavily, and ties
 * broken differently between two requests would let a row at a page boundary
 * come back twice or not at all.
 */
async function fetchAllByIds<T>(
  supabase: SupabaseClient,
  table: string,
  select: string,
  column: string,
  ids: string[],
  orderCol: string,
): Promise<T[]> {
  const all: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    all.push(
      ...(await fetchAllPages<T>(
        (from, to) =>
          supabase
            .from(table)
            .select(select)
            .in(column, chunk)
            .order(orderCol, { ascending: true })
            .order("id", { ascending: true })
            .range(from, to),
        table,
      )),
    );
  }
  return all;
}

const getWorkouts: AgentTool = {
  name: "getWorkouts",
  path: "/api/ai/workouts",
  method: "GET",
  readOnly: true,
  summary: "Get workout history",
  description:
    "Returns workouts with type, duration, rating, notes, per-exercise sets (reps and weight), exercise tonnage, and total workout tonnage.",
  responseDescription: "Workout history with exercises, sets, and tonnage",
  inputSchema: {
    type: "object",
    properties: {
      start: { type: "string", format: "date", description: "Start date in YYYY-MM-DD format." },
      end: { type: "string", format: "date", description: "End date in YYYY-MM-DD format (default: today)" },
      days: {
        type: "integer",
        description:
          "Number of days to look back from end (default 60, max 3650). Ignored if start is provided.",
        default: 60,
        minimum: 1,
        maximum: 3650,
      },
    },
  },
  handler: async (ctx, input) => {
    const today = new Date().toISOString().slice(0, 10);
    const end = (input.end as string) || today;

    let start = (input.start as string) || "";
    if (!start) {
      const days = Math.min((input.days as number) ?? 60, 3650);
      const startDate = new Date(end);
      startDate.setDate(startDate.getDate() - days + 1);
      start = startDate.toISOString().slice(0, 10);
    }

    // days maxes out at 3650, which over this history is thousands of rows --
    // well past the 1000 PostgREST will return in one response. Unpaginated,
    // a ten-year question silently answered with the most recent 1000
    // workouts and looked complete.
    type WorkoutRow = {
      id: string;
      date: string;
      workout_type: string | null;
      duration_minutes: number | null;
      rating: number | null;
      notes: string | null;
      body_weight: number | null;
      body_fat_pct: number | null;
    };
    const workouts = await fetchAllPages<WorkoutRow>(
      (from, to) =>
        ctx.supabase
          .from("workouts")
          .select("id, date, workout_type, duration_minutes, rating, notes, body_weight, body_fat_pct")
          .eq("owner_id", ctx.ownerId)
          .gte("date", start)
          .lte("date", end)
          .order("date", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to),
      "workouts",
    );

    if (workouts.length === 0) {
      return { period: { start, end }, workouts: [] };
    }

    const workoutIds = workouts.map((w) => w.id);

    type ExRow = {
      id: string;
      workout_id: string;
      exercise_name_display: string;
      exercise_order: number;
      notes: string | null;
    };
    const allExercises = await fetchAllByIds<ExRow>(
      ctx.supabase,
      "workout_exercises",
      "id, workout_id, exercise_name_display, exercise_order, notes",
      "workout_id",
      workoutIds,
      "exercise_order",
    );

    const exerciseIds = allExercises.map((e) => e.id);

    type SetRow = {
      workout_exercise_id: string;
      set_number: number;
      reps: number | null;
      weight: number | null;
      is_missed: boolean;
      set_type: string;
    };
    const allSets = await fetchAllByIds<SetRow>(
      ctx.supabase,
      "workout_sets",
      "workout_exercise_id, set_number, reps, weight, is_missed, set_type",
      "workout_exercise_id",
      exerciseIds,
      "set_number",
    );

    const setsByExercise = new Map<string, SetRow[]>();
    for (const s of allSets) {
      if (!setsByExercise.has(s.workout_exercise_id)) setsByExercise.set(s.workout_exercise_id, []);
      setsByExercise.get(s.workout_exercise_id)!.push(s);
    }

    const exercisesByWorkout = new Map<string, ExRow[]>();
    for (const ex of allExercises) {
      if (!exercisesByWorkout.has(ex.workout_id)) exercisesByWorkout.set(ex.workout_id, []);
      exercisesByWorkout.get(ex.workout_id)!.push(ex);
    }

    const result = workouts.map((w) => {
      const exercises = (exercisesByWorkout.get(w.id) || []).map((ex) => {
        const sets = (setsByExercise.get(ex.id) || [])
          .filter((s) => !s.is_missed && s.reps !== null && s.weight !== null)
          .map((s) => ({ reps: s.reps!, weight: s.weight! }));
        const tonnage = Math.round(sets.reduce((sum, s) => sum + s.reps * s.weight, 0));
        return {
          name: ex.exercise_name_display,
          notes: ex.notes || undefined,
          sets,
          tonnage_lbs: tonnage,
        };
      });

      const workoutTonnage = exercises.reduce((sum, ex) => sum + ex.tonnage_lbs, 0);

      return {
        date: w.date,
        type: w.workout_type,
        duration_minutes: w.duration_minutes,
        rating: w.rating,
        notes: w.notes,
        body_weight: w.body_weight,
        body_fat_pct: w.body_fat_pct,
        total_tonnage_lbs: workoutTonnage,
        exercises,
      };
    });

    return { period: { start, end }, workouts: result };
  },
};

const logWorkout: AgentTool = {
  name: "logWorkout",
  path: "/api/ai/workouts",
  method: "POST",
  readOnly: false,
  summary: "Record a workout",
  description:
    "Creates a new workout with its exercises and sets. Exercise names are matched against the user's existing exercises so stats and PRs roll up correctly; an unrecognised name is still recorded. Always creates a new workout — it never merges into an existing one for the same date.",
  responseDescription: "The created workout with its exercises and sets",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["date", "exercises"],
    properties: {
      date: { type: "string", format: "date", description: "Workout date in YYYY-MM-DD format." },
      workout_type: {
        type: "string",
        description: "Free-text workout type, e.g. \"Push\", \"Legs\", \"Run\".",
      },
      duration_minutes: { type: "number", description: "Total workout duration in minutes.", minimum: 0 },
      rating: { type: "number", description: "Subjective session rating, 1-5.", minimum: 1, maximum: 5 },
      location: { type: "string", description: "Where the workout happened." },
      body_weight: { type: "number", description: "Body weight recorded at the session.", minimum: 0 },
      body_fat_pct: { type: "number", description: "Body fat percentage recorded at the session.", minimum: 0, maximum: 100 },
      notes: { type: "string", description: "Free-text notes about the session." },
      exercises: {
        type: "array",
        description: `Exercises performed, in order. Maximum ${MAX_EXERCISES_PER_CALL}.`,
        items: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", description: "Exercise name, e.g. \"Bench Press\"." },
            notes: { type: "string", description: "Notes for this exercise." },
            sets: {
              type: "array",
              description: "Sets performed for this exercise, in order.",
              items: {
                type: "object",
                properties: {
                  reps: { type: "number", description: "Repetitions completed.", minimum: 0 },
                  weight: { type: "number", description: "Weight used, in the user's usual unit (lbs).", minimum: 0 },
                  is_pr: { type: "boolean", description: "True if this set was a personal record." },
                  is_missed: { type: "boolean", description: "True if the set was attempted but failed." },
                },
              },
            },
            duration_minutes: { type: "number", description: "For cardio: duration in minutes.", minimum: 0 },
            distance_miles: { type: "number", description: "For cardio: distance in miles.", minimum: 0 },
            incline_pct: { type: "number", description: "For cardio: treadmill incline percentage." },
          },
        },
      },
    },
  },
  handler: async (ctx, input) => {
    const rawExercises = (input.exercises ?? []) as Array<Record<string, unknown>>;

    if (rawExercises.length === 0) {
      throw new AgentInputError("exercises must contain at least one entry");
    }
    if (rawExercises.length > MAX_EXERCISES_PER_CALL) {
      throw new AgentInputError(
        `Too many exercises in one call (${rawExercises.length}). Maximum is ${MAX_EXERCISES_PER_CALL}.`
      );
    }

    const names = rawExercises.map((e) => String(e.name));
    const resolved = await resolveExerciseIds(ctx.supabase, ctx.ownerId, names);

    const exercises: ExerciseInput[] = rawExercises.map((ex, index) => {
      const sets = (ex.sets ?? []) as Array<Record<string, unknown>>;
      if (sets.length > MAX_SETS_PER_EXERCISE) {
        throw new AgentInputError(
          `Too many sets for "${String(ex.name)}" (${sets.length}). Maximum is ${MAX_SETS_PER_EXERCISE}.`
        );
      }

      const name = String(ex.name);
      return {
        exercise_id: resolved.get(name) ?? null,
        exercise_name_display: name,
        exercise_order: index,
        notes: (ex.notes as string) ?? null,
        duration_minutes: (ex.duration_minutes as number) ?? null,
        distance_miles: (ex.distance_miles as number) ?? null,
        incline_pct: (ex.incline_pct as number) ?? null,
        sets: sets.map((s, i) => ({
          set_number: i + 1,
          reps: s.reps === undefined ? null : Number(s.reps),
          weight: s.weight === undefined ? null : Number(s.weight),
          is_pr: s.is_pr === true,
          is_missed: s.is_missed === true,
        })),
      };
    });

    const result = await createWorkout(ctx.supabase, ctx.ownerId, {
      date: input.date as string,
      workout_type: (input.workout_type as string) ?? null,
      duration_minutes: (input.duration_minutes as number) ?? null,
      rating: (input.rating as number) ?? null,
      location: (input.location as string) ?? null,
      body_weight: (input.body_weight as number) ?? null,
      body_fat_pct: (input.body_fat_pct as number) ?? null,
      notes: (input.notes as string) ?? null,
      exercises,
    });

    const unmatched = names.filter((n) => !resolved.has(n));

    return {
      workout: result.workout,
      exercises_created: result.exercises.length,
      sets_created: result.sets.length,
      ...(unmatched.length > 0
        ? {
            note: `Logged, but these exercise names did not match an existing exercise and will not roll up into its stats: ${unmatched.join(", ")}`,
          }
        : {}),
      ...(result.partialError ? { warning: result.partialError } : {}),
    };
  },
};

export const workoutTools: AgentTool[] = [getWorkouts, logWorkout];
