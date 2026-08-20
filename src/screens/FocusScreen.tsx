import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { supabase } from "../lib/supabase";
import { rankTasks, summariseRanking, type ScoredTask } from "../lib/priority";

export default function FocusScreen() {
  const [ranked, setRanked] = useState<ScoredTask[]>([]);
  const [lastSnapshot, setLastSnapshot] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in");

      const [g, t, e, snap] = await Promise.all([
        supabase
          .from("goals")
          .select("id,title,horizon,status")
          .is("deleted_at", null),
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
        supabase
          .from("priority_snapshots")
          .select("generated_at")
          .order("generated_at", { ascending: false })
          .limit(1),
      ]);
      if (g.error) throw g.error;
      if (t.error) throw t.error;
      if (e.error) throw e.error;
      if (snap.error) throw snap.error;

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

      setRanked(
        rankTasks({ tasks, goals: g.data ?? [], lastTouchedByGoal }),
      );
      setLastSnapshot(snap.data?.[0]?.generated_at ?? null);
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

  const saveSnapshot = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      if (ranked.length === 0) throw new Error("Nothing to snapshot.");

      // Read the user here rather than trusting component state — if the
      // session refreshed (or a load failed) since mount, `userId` can be
      // stale or null, and a silent early return looks like a dead button.
      const {
        data: { user },
        error: userErr,
      } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      if (!user) throw new Error("Session expired — sign out and back in.");

      const { error: snapErr } = await supabase.from("priority_snapshots").insert({
        user_id: user.id,
        ranked_task_ids: ranked.map((r) => r.taskId),
        reasoning: summariseRanking(ranked),
      });
      if (snapErr) throw snapErr;

      // tasks.priority_score is the cheap denormalised copy, per the schema
      // comment — the snapshot above is the durable versioned record. Issued
      // concurrently so this doesn't become N serial round trips.
      const updates = await Promise.all(
        ranked.map((item) =>
          supabase
            .from("tasks")
            .update({ priority_score: item.score })
            .eq("id", item.taskId),
        ),
      );
      const failed = updates.find((u) => u.error);
      if (failed?.error) throw failed.error;

      setNotice(`Snapshot saved — ${ranked.length} task(s) ranked.`);
      await load();
    } catch (err: any) {
      setError(err.message ?? "Could not save snapshot");
    } finally {
      setSaving(false);
    }
  };

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

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.error}>{error}</Text>
          <Pressable onPress={load} hitSlop={6}>
            <Text style={styles.retry}>Retry</Text>
          </Pressable>
        </View>
      )}
      {notice && <Text style={styles.notice}>{notice}</Text>}

      {ranked.length === 0 ? (
        // Only claim there's nothing here when the load actually succeeded.
        // On failure this would otherwise read as "you have no tasks", which
        // is a different and much more alarming statement than "load failed".
        !error && (
          <Text style={styles.empty}>
            No open tasks to rank. Add some in Brain Dump, or reopen something you've
            ticked off.
          </Text>
        )
      ) : (
        <>
          {ranked.map((item, i) => (
            <View key={item.taskId} style={styles.row}>
              <Text style={styles.rank}>{i + 1}</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>{item.title}</Text>
                <Text style={styles.reasons}>{item.reasons.join(" · ")}</Text>
              </View>
              <Text style={styles.score}>{item.score.toFixed(2)}</Text>
            </View>
          ))}

          <Pressable
            style={[styles.button, saving && styles.buttonDisabled]}
            onPress={saveSnapshot}
            disabled={saving}
          >
            <Text style={styles.buttonText}>
              {saving ? "Saving..." : "Save this ranking as a snapshot"}
            </Text>
          </Pressable>
          <Text style={styles.meta}>
            {lastSnapshot
              ? `Last snapshot: ${new Date(lastSnapshot).toLocaleString()}`
              : "No snapshot saved yet."}
          </Text>
        </>
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
  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#fdf2f2",
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  retry: { color: "#3060d0", fontWeight: "700", fontSize: 13 },
  notice: { color: "#2c6e49", marginBottom: 12 },
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
  button: {
    backgroundColor: "#3060d0",
    borderRadius: 8,
    paddingVertical: 13,
    alignItems: "center",
    marginTop: 22,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  meta: { fontSize: 12, color: "#999", marginTop: 10, textAlign: "center" },
});
