/**
 * Rule-based priority scoring. Pure functions, no I/O — so this stays testable
 * and survives any front-end redesign untouched.
 *
 * Deliberately transparent rather than clever: every score comes with the
 * reasons that produced it, because `priority_snapshots.reasoning` is meant to
 * be shown to the user. A ranking you can't interrogate is one you won't trust.
 *
 * The AI reasoning layer (build step 3, second half) goes ON TOP of this — it
 * should adjust and explain, not replace. Keeping the rules as the floor means
 * the app still works when the API is down or slow.
 */

export type ScoredTask = {
  taskId: string;
  title: string;
  score: number;
  reasons: string[];
};

type TaskInput = {
  id: string;
  title: string;
  goal_id: string | null;
  status: string;
  due_date: string | null;
  created_at: string;
};

type GoalInput = {
  id: string;
  title: string;
  horizon: string | null;
  status: string;
};

// --- Tunable weights -------------------------------------------------------
// These sum to 1.0. Adjust here rather than scattering magic numbers below.
const W_DUE = 0.5; // deadlines dominate — a missed date has real consequences
const W_HORIZON = 0.2; // nearer-term goals push harder than lifetime ones
const W_DRIFT = 0.3; // neglect surfaces work; this is the anti-drift lever

// A goal untouched this long is considered fully drifted (max drift boost).
const DRIFT_SATURATION_DAYS = 30;

// Lowest urgency a task with a real deadline can reach. Must stay above the
// undated value in dueComponent() so an explicit date always outranks none.
const DUE_FLOOR = 0.32;

function daysBetween(from: Date, to: Date): number {
  const MS_PER_DAY = 86_400_000;
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

/** Parse a YYYY-MM-DD date column as local midnight, not UTC. */
function parseDateOnly(value: string): Date {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function dueComponent(
  dueDate: string | null,
  now: Date,
): { value: number; reason: string | null } {
  if (!dueDate) {
    // Deliberately below DUE_FLOOR: a stated deadline is a commitment, an
    // undated task is a maybe. A dated task must never rank below an undated
    // one on this component, however distant the date.
    return { value: 0.28, reason: "no deadline" };
  }
  const days = daysBetween(now, parseDateOnly(dueDate));
  if (days < 0) return { value: 1, reason: `overdue by ${Math.abs(days)}d` };
  if (days === 0) return { value: 0.95, reason: "due today" };
  if (days <= 3) return { value: 0.85, reason: `due in ${days}d` };
  if (days <= 7) return { value: 0.7, reason: "due this week" };
  if (days <= 14) return { value: 0.5, reason: "due within 2 weeks" };
  if (days <= 30) return { value: 0.35, reason: "due this month" };
  // Floor, not a decay to zero — urgency is flat past a month, but the task
  // still has a real date and stays above anything undated.
  return { value: DUE_FLOOR, reason: `due in ${days}d` };
}

function horizonComponent(
  horizon: string | null,
): { value: number; reason: string | null } {
  switch (horizon) {
    case "quarter":
      return { value: 1, reason: "quarter-horizon goal" };
    case "year":
      return { value: 0.6, reason: "year-horizon goal" };
    case "life":
      return { value: 0.35, reason: "lifetime goal" };
    default:
      return { value: 0.5, reason: null };
  }
}

function driftComponent(
  lastTouched: Date | null,
  now: Date,
): { value: number; reason: string | null } {
  if (!lastTouched) return { value: 0.5, reason: null };
  const idle = daysBetween(lastTouched, now);
  const value = Math.min(idle / DRIFT_SATURATION_DAYS, 1);
  // Only call out drift once it's genuinely notable — a 2-day gap is noise.
  const reason = idle >= 7 ? `untouched for ${idle}d` : null;
  return { value, reason };
}

/**
 * Rank a user's open tasks.
 *
 * @param lastTouchedByGoal  Most recent event timestamp per goal id. Drives the
 *   drift boost — goals going quiet rise rather than fade.
 */
export function rankTasks(params: {
  tasks: TaskInput[];
  goals: GoalInput[];
  lastTouchedByGoal: Record<string, string>;
  now?: Date;
}): ScoredTask[] {
  const now = params.now ?? new Date();
  const goalsById = new Map(params.goals.map((g) => [g.id, g]));

  return params.tasks
    .filter((t) => t.status === "open" || t.status === "in_progress")
    .filter((t) => {
      // A task under a paused or abandoned goal shouldn't compete for attention.
      if (!t.goal_id) return true;
      const goal = goalsById.get(t.goal_id);
      return !goal || goal.status === "active";
    })
    .map((task) => {
      const goal = task.goal_id ? goalsById.get(task.goal_id) : undefined;

      const due = dueComponent(task.due_date, now);
      const horizon = horizonComponent(goal?.horizon ?? null);

      // Standalone tasks have no goal history, so fall back to their own age —
      // an old untouched task is drifting just as much as an old goal.
      const touchedRaw = task.goal_id
        ? params.lastTouchedByGoal[task.goal_id]
        : task.created_at;
      const drift = driftComponent(touchedRaw ? new Date(touchedRaw) : null, now);

      const score =
        due.value * W_DUE + horizon.value * W_HORIZON + drift.value * W_DRIFT;

      const reasons = [due.reason, horizon.reason, drift.reason].filter(
        (r): r is string => Boolean(r),
      );
      reasons.push(goal ? `serves "${goal.title}"` : "not linked to a goal");

      return {
        taskId: task.id,
        title: task.title,
        score: Math.round(score * 1000) / 1000,
        reasons,
      };
    })
    .sort((a, b) => b.score - a.score);
}

/** One-paragraph summary for `priority_snapshots.reasoning`. */
export function summariseRanking(ranked: ScoredTask[]): string {
  if (ranked.length === 0) return "No open tasks to rank.";
  const top = ranked.slice(0, 3);
  const lines = top.map(
    (t, i) => `${i + 1}. ${t.title} (${t.score.toFixed(2)}) — ${t.reasons.join(", ")}`,
  );
  return [
    `Rule-based ranking of ${ranked.length} open task(s).`,
    `Weights: due ${W_DUE}, horizon ${W_HORIZON}, drift ${W_DRIFT}.`,
    ...lines,
  ].join("\n");
}
