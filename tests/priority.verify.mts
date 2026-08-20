// Temporary verification of the ranking rules. Run: node verify-priority.mts
import { rankTasks, summariseRanking } from "../src/lib/priority.ts";

const NOW = new Date(2026, 7, 19); // 2026-08-19, matching today
const iso = (y: number, m: number, d: number) => new Date(y, m - 1, d).toISOString();

const goals = [
  { id: "g-quarter", title: "Get fit", horizon: "quarter", status: "active" },
  { id: "g-life", title: "Read more", horizon: "life", status: "active" },
  { id: "g-paused", title: "Learn piano", horizon: "year", status: "paused" },
];

const tasks = [
  { id: "t-overdue", title: "Overdue thing", goal_id: "g-life", status: "open",
    due_date: "2026-08-10", created_at: iso(2026, 8, 1) },
  { id: "t-today", title: "Due today", goal_id: "g-quarter", status: "open",
    due_date: "2026-08-19", created_at: iso(2026, 8, 1) },
  { id: "t-far", title: "Due far off", goal_id: "g-quarter", status: "open",
    due_date: "2026-12-01", created_at: iso(2026, 8, 1) },
  { id: "t-drifted", title: "On a neglected goal", goal_id: "g-life", status: "open",
    due_date: null, created_at: iso(2026, 6, 1) },
  { id: "t-fresh", title: "On an active goal", goal_id: "g-quarter", status: "open",
    due_date: null, created_at: iso(2026, 8, 18) },
  { id: "t-done", title: "Already finished", goal_id: "g-quarter", status: "done",
    due_date: "2026-08-19", created_at: iso(2026, 8, 1) },
  { id: "t-paused", title: "Under a paused goal", goal_id: "g-paused", status: "open",
    due_date: "2026-08-19", created_at: iso(2026, 8, 1) },
];

const lastTouchedByGoal = {
  "g-quarter": iso(2026, 8, 18), // touched yesterday
  "g-life": iso(2026, 6, 20),    // untouched ~60 days
  "g-paused": iso(2026, 8, 18),
};

const ranked = rankTasks({ tasks, goals, lastTouchedByGoal, now: NOW });
const ids = ranked.map((r) => r.taskId);

let failures = 0;
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

check("completed task excluded", !ids.includes("t-done"));
check("task under paused goal excluded", !ids.includes("t-paused"));
check("overdue outranks due-today", ids.indexOf("t-overdue") < ids.indexOf("t-today"));
check("due-today outranks due-far-off", ids.indexOf("t-today") < ids.indexOf("t-far"));
check(
  "drifted goal outranks fresh goal (both undated)",
  ids.indexOf("t-drifted") < ids.indexOf("t-fresh"),
);
// Regression: an undated task must never outrank a dated one, all else equal.
// A stated deadline is a commitment; no deadline is a maybe.
const pair = rankTasks({
  goals: [],
  lastTouchedByGoal: {},
  now: NOW,
  tasks: [
    { id: "t-undated", title: "Undated", goal_id: null, status: "open",
      due_date: null, created_at: iso(2026, 8, 19) },
    { id: "t-distant", title: "Distant deadline", goal_id: null, status: "open",
      due_date: "2026-12-01", created_at: iso(2026, 8, 19) },
  ],
}).map((r) => r.taskId);
check("distant deadline outranks no deadline", pair[0] === "t-distant");

check("all scores within 0..1", ranked.every((r) => r.score >= 0 && r.score <= 1));
check("every task has reasoning", ranked.every((r) => r.reasons.length > 0));

console.log("\n--- ranking ---");
for (const [i, r] of ranked.entries()) {
  console.log(`${i + 1}. ${r.title.padEnd(24)} ${r.score.toFixed(3)}  ${r.reasons.join(", ")}`);
}
console.log("\n--- snapshot reasoning ---");
console.log(summariseRanking(ranked));

process.exitCode = failures === 0 ? 0 : 1;
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
