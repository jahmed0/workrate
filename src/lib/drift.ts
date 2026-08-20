/**
 * Shared "how long has this been neglected" math. Used by priority.ts (the
 * ranking's drift boost) and ProgressScreen (the per-goal drift badge) so the
 * two screens never disagree about what "stale" means.
 *
 * Pure, no I/O — same reasoning as priority.ts.
 */

export function daysBetween(from: Date, to: Date): number {
  const MS_PER_DAY = 86_400_000;
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

export type DriftLevel = "fresh" | "quiet" | "stale";

/** Below MILD, a goal reads as actively worked. Below STRONG, worth a nudge. */
const MILD_THRESHOLD_DAYS = 7;
const STRONG_THRESHOLD_DAYS = 21;

export function driftLevel(idleDays: number): DriftLevel {
  if (idleDays >= STRONG_THRESHOLD_DAYS) return "stale";
  if (idleDays >= MILD_THRESHOLD_DAYS) return "quiet";
  return "fresh";
}

export function humanizeIdle(idleDays: number): string {
  if (idleDays <= 0) return "today";
  if (idleDays === 1) return "yesterday";
  if (idleDays < 7) return `${idleDays}d ago`;
  if (idleDays < 30) return `${Math.round(idleDays / 7)}w ago`;
  return `${Math.round(idleDays / 30)}mo ago`;
}
