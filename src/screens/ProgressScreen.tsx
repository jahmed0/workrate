import React, { useCallback, useMemo, useState } from "react";
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, RefreshControl } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { supabase } from "../lib/supabase";
import { daysBetween, driftLevel, humanizeIdle, type DriftLevel } from "../lib/drift";

/**
 * "How am I doing" — distinct from Focus's "what should I do now". Fully
 * automatic: no button, no manual snapshot. Everything here is recomputed
 * live from goals/tasks/events on every visit, the same pattern the other
 * screens use, so drift detection needs no separate job or infrastructure.
 */

type Goal = {
  id: string;
  title: string;
  life_area: string | null;
  status: string;
};

type Task = {
  id: string;
  goal_id: string | null;
  status: string;
};

type GoalRow = {
  id: string;
  title: string;
  idleDays: number | null;
  level: DriftLevel;
  doneCount: number;
  openCount: number;
};

type AreaBin = {
  key: string;
  label: string;
  goals: GoalRow[];
  worstLevel: DriftLevel;
};

const LEVEL_RANK: Record<DriftLevel, number> = { stale: 2, quiet: 1, fresh: 0 };
const LEVEL_LABEL: Record<DriftLevel, string> = {
  stale: "Stale",
  quiet: "Quiet",
  fresh: "Active",
};
const LEVEL_COLOR: Record<DriftLevel, string> = {
  stale: "#c0392b",
  quiet: "#b8860b",
  fresh: "#2c6e49",
};

function titleCase(s: string): string {
  return s.replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

export default function ProgressScreen() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [lastTouchedByGoal, setLastTouchedByGoal] = useState<Record<string, string>>({});
  const [completedThisWeek, setCompletedThisWeek] = useState(0);
  const [completedPriorWeek, setCompletedPriorWeek] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in");

      const [g, t, e] = await Promise.all([
        supabase
          .from("goals")
          .select("id,title,life_area,status")
          .is("deleted_at", null)
          .eq("status", "active"),
        supabase.from("tasks").select("id,goal_id,status").is("deleted_at", null),
        // Same 1000-row cap as FocusScreen — cheap at personal scale, revisit
        // if history ever grows large enough to matter.
        supabase
          .from("events")
          .select("event_type,entity_type,entity_id,created_at")
          .order("created_at", { ascending: false })
          .limit(1000),
      ]);
      if (g.error) throw g.error;
      if (t.error) throw t.error;
      if (e.error) throw e.error;

      const taskRows = t.data ?? [];
      const goalIdByTask = new Map(taskRows.map((x) => [x.id, x.goal_id]));
      const events = e.data ?? [];

      const touched: Record<string, string> = {};
      for (const ev of events) {
        const goalId =
          ev.entity_type === "goal"
            ? ev.entity_id
            : ev.entity_type === "task"
              ? (goalIdByTask.get(ev.entity_id) ?? null)
              : null;
        if (!goalId) continue;
        if (!touched[goalId]) touched[goalId] = ev.created_at; // newest-first
      }

      // Momentum: completions in the last 7 days vs the 7 days before that.
      // Uses the append-only event log directly — no separate history table
      // needed for a trend this simple.
      const now = new Date();
      let thisWeek = 0;
      let priorWeek = 0;
      for (const ev of events) {
        if (ev.event_type !== "task_completed" && ev.event_type !== "goal_achieved") continue;
        const age = daysBetween(new Date(ev.created_at), now);
        if (age < 7) thisWeek++;
        else if (age < 14) priorWeek++;
      }

      setGoals(g.data ?? []);
      setTasks(taskRows);
      setLastTouchedByGoal(touched);
      setCompletedThisWeek(thisWeek);
      setCompletedPriorWeek(priorWeek);
    } catch (err: any) {
      setError(err.message ?? "Failed to load");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const bins = useMemo<AreaBin[]>(() => {
    const now = new Date();
    const byArea = new Map<string, AreaBin>();

    for (const goal of goals) {
      const key = goal.life_area?.trim() || "uncategorized";
      const label = goal.life_area?.trim() ? titleCase(goal.life_area) : "Uncategorized";

      const touchedAt = lastTouchedByGoal[goal.id];
      const idleDays = touchedAt ? daysBetween(new Date(touchedAt), now) : null;
      // A goal with no event history yet is new, not neglected — don't flag it.
      const level: DriftLevel = idleDays === null ? "fresh" : driftLevel(idleDays);

      const goalTasks = tasks.filter((t) => t.goal_id === goal.id);
      const doneCount = goalTasks.filter((t) => t.status === "done").length;
      const openCount = goalTasks.filter((t) => t.status !== "done").length;

      const row: GoalRow = { id: goal.id, title: goal.title, idleDays, level, doneCount, openCount };

      const bin = byArea.get(key) ?? { key, label, goals: [], worstLevel: "fresh" as DriftLevel };
      bin.goals.push(row);
      if (LEVEL_RANK[level] > LEVEL_RANK[bin.worstLevel]) bin.worstLevel = level;
      byArea.set(key, bin);
    }

    for (const bin of byArea.values()) {
      bin.goals.sort((a, b) => (b.idleDays ?? -1) - (a.idleDays ?? -1));
    }

    // Bins needing attention float to the top — same anti-drift ordering as
    // the priority engine: what's stalling should be the first thing you see.
    return [...byArea.values()].sort((a, b) => LEVEL_RANK[b.worstLevel] - LEVEL_RANK[a.worstLevel]);
  }, [goals, tasks, lastTouchedByGoal]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }

  const momentumDelta = completedThisWeek - completedPriorWeek;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ padding: 20, paddingBottom: 60 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            load();
          }}
        />
      }
    >
      <Text style={styles.heading}>Progress</Text>
      <Text style={styles.subtext}>
        Grouped by life area. Recomputed automatically — nothing here needs saving.
      </Text>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.error}>{error}</Text>
        </View>
      )}

      {!error && (
        <View style={styles.momentumCard}>
          <Text style={styles.momentumNumber}>{completedThisWeek}</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.momentumLabel}>completed in the last 7 days</Text>
            {completedPriorWeek > 0 && (
              <Text style={styles.momentumTrend}>
                {momentumDelta > 0
                  ? `↑ ${momentumDelta} more than the week before`
                  : momentumDelta < 0
                    ? `↓ ${Math.abs(momentumDelta)} fewer than the week before`
                    : "same as the week before"}
              </Text>
            )}
          </View>
        </View>
      )}

      {!error && bins.length === 0 && (
        <Text style={styles.empty}>
          No active goals yet. Add some in Brain Dump to see progress by area.
        </Text>
      )}

      {bins.map((bin) => (
        <View key={bin.key} style={styles.binCard}>
          <View style={styles.binHeader}>
            <Text style={styles.binLabel}>{bin.label}</Text>
            <View style={[styles.badge, { backgroundColor: LEVEL_COLOR[bin.worstLevel] }]}>
              <Text style={styles.badgeText}>{LEVEL_LABEL[bin.worstLevel]}</Text>
            </View>
          </View>

          {bin.goals.map((row) => (
            <View key={row.id} style={styles.goalRow}>
              <View style={[styles.dot, { backgroundColor: LEVEL_COLOR[row.level] }]} />
              <View style={{ flex: 1 }}>
                <Text style={styles.goalTitle}>{row.title}</Text>
                <Text style={styles.goalMeta}>
                  {row.doneCount + row.openCount === 0
                    ? "no tasks yet"
                    : `${row.doneCount}/${row.doneCount + row.openCount} tasks done`}
                  {" · "}
                  {row.idleDays === null ? "not touched yet" : `last touched ${humanizeIdle(row.idleDays)}`}
                </Text>
              </View>
            </View>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  heading: { fontSize: 24, fontWeight: "700" },
  subtext: { color: "#666", marginTop: 6, marginBottom: 18, lineHeight: 19 },
  empty: { color: "#888", lineHeight: 21 },
  error: { color: "#c0392b" },
  errorBox: { backgroundColor: "#fdf2f2", borderRadius: 8, padding: 12, marginBottom: 12 },
  momentumCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: "#f4f7fd",
    borderRadius: 10,
    padding: 16,
    marginBottom: 18,
  },
  momentumNumber: { fontSize: 32, fontWeight: "800", color: "#3060d0", width: 52 },
  momentumLabel: { fontSize: 13, color: "#444", fontWeight: "600" },
  momentumTrend: { fontSize: 12, color: "#888", marginTop: 2 },
  binCard: {
    borderWidth: 1,
    borderColor: "#eee",
    borderRadius: 10,
    padding: 14,
    marginBottom: 14,
  },
  binHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
  binLabel: { fontSize: 16, fontWeight: "700" },
  badge: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 12 },
  badgeText: { color: "#fff", fontSize: 11, fontWeight: "700" },
  goalRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: "#f5f5f5",
  },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
  goalTitle: { fontSize: 14, fontWeight: "600" },
  goalMeta: { fontSize: 12, color: "#888", marginTop: 2 },
});
