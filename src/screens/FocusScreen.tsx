import React, { useCallback, useState } from "react";
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, RefreshControl } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { supabase } from "../lib/supabase";
import { rankTasks, type ScoredTask } from "../lib/priority";
import QuickCapture from "../components/QuickCapture";

// Purely a live view — no persistence. Ranking is recomputed on every visit
// from goals/tasks/events, same pattern GoalsScreen uses. There is
// deliberately nothing to save here: a snapshot nobody reads back is just
// unused writes. If a history view is ever built, it reads `events`
// directly rather than a separately-maintained snapshot table.
export default function FocusScreen() {
  const [ranked, setRanked] = useState<ScoredTask[]>([]);
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
        supabase.from("goals").select("id,title,horizon,status").is("deleted_at", null),
        supabase
          .from("tasks")
          .select("id,title,goal_id,status,due_date,created_at")
          .is("deleted_at", null),
        // Recent events drive the drift signal. Capped because at personal
        // scale this is cheap — revisit if the history ever gets long.
        supabase
          .from("events")
          .select("entity_type,entity_id,created_at")
          .order("created_at", { ascending: false })
          .limit(1000),
      ]);
      if (g.error) throw g.error;
      if (t.error) throw t.error;
      if (e.error) throw e.error;

      const tasks = t.data ?? [];
      const goalIdByTask = new Map(tasks.map((x) => [x.id, x.goal_id]));

      // A task event counts as touching its parent goal — otherwise ticking
      // tasks off would leave the goal looking neglected.
      const lastTouchedByGoal: Record<string, string> = {};
      for (const ev of e.data ?? []) {
        const goalId =
          ev.entity_type === "goal"
            ? ev.entity_id
            : ev.entity_type === "task"
              ? (goalIdByTask.get(ev.entity_id) ?? null)
              : null;
        if (!goalId) continue;
        // Events arrive newest-first, so the first hit per goal is the latest.
        if (!lastTouchedByGoal[goalId]) lastTouchedByGoal[goalId] = ev.created_at;
      }

      setRanked(rankTasks({ tasks, goals: g.data ?? [], lastTouchedByGoal }));
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

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }

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
      <Text style={styles.heading}>Today's Focus</Text>
      <Text style={styles.subtext}>
        Ranked by deadline, goal horizon, and how long it's been neglected. Every score
        shows its reasoning — argue with it.
      </Text>

      <QuickCapture onSaved={load} />

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.error}>{error}</Text>
        </View>
      )}

      {ranked.length === 0 ? (
        !error && (
          <Text style={styles.empty}>
            No open tasks to rank. Add one above, or reopen something you've
            ticked off.
          </Text>
        )
      ) : (
        ranked.map((item, i) => (
          <View key={item.taskId} style={styles.row}>
            <Text style={styles.rank}>{i + 1}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>{item.title}</Text>
              <Text style={styles.reasons}>{item.reasons.join(" · ")}</Text>
            </View>
            <Text style={styles.score}>{item.score.toFixed(2)}</Text>
          </View>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  heading: { fontSize: 24, fontWeight: "700" },
  subtext: { color: "#666", marginTop: 6, marginBottom: 18, lineHeight: 19 },
  empty: { color: "#888", lineHeight: 21 },
  error: { color: "#c0392b", flex: 1 },
  errorBox: { backgroundColor: "#fdf2f2", borderRadius: 8, padding: 12, marginBottom: 12 },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
  },
  rank: { fontSize: 15, fontWeight: "700", color: "#3060d0", width: 20 },
  title: { fontSize: 15, fontWeight: "600" },
  reasons: { fontSize: 12, color: "#888", marginTop: 3, lineHeight: 17 },
  score: { fontSize: 13, color: "#aaa", fontVariant: ["tabular-nums"] },
});
