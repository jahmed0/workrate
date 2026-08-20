import React, { useCallback, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { supabase } from "../lib/supabase";
import { logEvent } from "../lib/events";

type Goal = {
  id: string;
  title: string;
  why_it_matters: string | null;
  life_area: string | null;
  horizon: string | null;
  status: string;
};

type Task = {
  id: string;
  goal_id: string | null;
  title: string;
  status: string;
  due_date: string | null;
};

export default function GoalsScreen() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in");
      setUserId(user.id);

      // deleted_at filters are what make soft-delete actually behave like a
      // delete in the UI — the rows stay in the table for reconstructability.
      const [g, t] = await Promise.all([
        supabase
          .from("goals")
          .select("id,title,why_it_matters,life_area,horizon,status")
          .is("deleted_at", null)
          .order("created_at", { ascending: true }),
        supabase
          .from("tasks")
          .select("id,goal_id,title,status,due_date")
          .is("deleted_at", null)
          .order("created_at", { ascending: true }),
      ]);
      if (g.error) throw g.error;
      if (t.error) throw t.error;
      setGoals(g.data ?? []);
      setTasks(t.data ?? []);
    } catch (e: any) {
      setError(e.message ?? "Failed to load");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Tab screens stay mounted, so a plain useEffect would only ever fire once —
  // items saved in Brain Dump wouldn't show up on switching back here.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const mutate = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e: any) {
      setError(e.message ?? "Action failed");
    }
  };

  const toggleTask = (task: Task) =>
    mutate(async () => {
      if (!userId) return;
      const done = task.status === "done";
      const next = done ? "open" : "done";
      const { error: err } = await supabase
        .from("tasks")
        .update({ status: next, updated_at: new Date().toISOString() })
        .eq("id", task.id);
      if (err) throw err;
      await logEvent({
        userId,
        eventType: done ? "task_reopened" : "task_completed",
        entityType: "task",
        entityId: task.id,
        payload: { title: task.title },
      });
    });

  const softDelete = (kind: "goal" | "task", id: string, title: string) =>
    mutate(async () => {
      if (!userId) return;
      const { error: err } = await supabase
        .from(kind === "goal" ? "goals" : "tasks")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id);
      if (err) throw err;
      await logEvent({
        userId,
        eventType: kind === "goal" ? "goal_abandoned" : "task_abandoned",
        entityType: kind,
        entityId: id,
        payload: { title },
      });
    });

  const saveTitle = (kind: "goal" | "task", id: string, previous: string) =>
    mutate(async () => {
      if (!userId) return;
      const next = draft.trim();
      setEditingId(null);
      if (!next || next === previous) return;
      const { error: err } = await supabase
        .from(kind === "goal" ? "goals" : "tasks")
        .update({ title: next, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (err) throw err;
      // Keep the old value in the payload — the event log should be enough to
      // reconstruct what changed without diffing table snapshots.
      await logEvent({
        userId,
        eventType: kind === "goal" ? "goal_edited" : "task_edited",
        entityType: kind,
        entityId: id,
        payload: { from: previous, to: next },
      });
    });

  const toggleGoalAchieved = (goal: Goal) =>
    mutate(async () => {
      if (!userId) return;
      const achieved = goal.status === "achieved";
      const next = achieved ? "active" : "achieved";
      const { error: err } = await supabase
        .from("goals")
        .update({ status: next, updated_at: new Date().toISOString() })
        .eq("id", goal.id);
      if (err) throw err;
      await logEvent({
        userId,
        eventType: achieved ? "goal_reopened" : "goal_achieved",
        entityType: "goal",
        entityId: goal.id,
        payload: { title: goal.title },
      });
    });

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }

  const unlinked = tasks.filter((t) => !t.goal_id);

  const renderTask = (task: Task) => (
    <View key={task.id} style={styles.taskRow}>
      <Pressable onPress={() => toggleTask(task)} hitSlop={6} style={styles.check}>
        <Text style={styles.checkMark}>{task.status === "done" ? "☑" : "☐"}</Text>
      </Pressable>
      <View style={{ flex: 1 }}>
        {editingId === task.id ? (
          <TextInput
            style={styles.editInput}
            value={draft}
            onChangeText={setDraft}
            autoFocus
            onSubmitEditing={() => saveTitle("task", task.id, task.title)}
            onBlur={() => saveTitle("task", task.id, task.title)}
          />
        ) : (
          <Text style={[styles.taskTitle, task.status === "done" && styles.done]}>
            {task.title}
          </Text>
        )}
        {!!task.due_date && <Text style={styles.meta}>Due {task.due_date}</Text>}
      </View>
      <Pressable
        onPress={() => {
          setEditingId(task.id);
          setDraft(task.title);
        }}
        hitSlop={6}
      >
        <Text style={styles.action}>Edit</Text>
      </Pressable>
      <Pressable onPress={() => softDelete("task", task.id, task.title)} hitSlop={6}>
        <Text style={[styles.action, styles.danger]}>Delete</Text>
      </Pressable>
    </View>
  );

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
      <Text style={styles.heading}>Goals & Tasks</Text>
      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.error}>{error}</Text>
          <Pressable onPress={load} hitSlop={6}>
            <Text style={styles.retry}>Retry</Text>
          </Pressable>
        </View>
      )}

      {/* Only when the load succeeded — otherwise a failed fetch reads as
          "your account is empty", which is alarming and untrue. */}
      {!error && goals.length === 0 && tasks.length === 0 && (
        <Text style={styles.empty}>
          Nothing here yet. Head to Brain Dump, get it all out, and confirm what's worth
          keeping.
        </Text>
      )}

      {goals.map((goal) => (
        <View key={goal.id} style={styles.goalCard}>
          <View style={styles.goalHeader}>
            <View style={{ flex: 1 }}>
              {editingId === goal.id ? (
                <TextInput
                  style={styles.editInput}
                  value={draft}
                  onChangeText={setDraft}
                  autoFocus
                  onSubmitEditing={() => saveTitle("goal", goal.id, goal.title)}
                  onBlur={() => saveTitle("goal", goal.id, goal.title)}
                />
              ) : (
                <Text
                  style={[
                    styles.goalTitle,
                    goal.status === "achieved" && styles.done,
                  ]}
                >
                  {goal.title}
                </Text>
              )}
              <Text style={styles.meta}>
                {[goal.life_area, goal.horizon].filter(Boolean).join(" · ")}
                {goal.status !== "active" ? ` · ${goal.status}` : ""}
              </Text>
              {!!goal.why_it_matters && (
                <Text style={styles.why}>{goal.why_it_matters}</Text>
              )}
            </View>
          </View>

          <View style={styles.goalActions}>
            <Pressable onPress={() => toggleGoalAchieved(goal)} hitSlop={6}>
              <Text style={styles.action}>
                {goal.status === "achieved" ? "Reopen" : "Mark achieved"}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setEditingId(goal.id);
                setDraft(goal.title);
              }}
              hitSlop={6}
            >
              <Text style={styles.action}>Edit</Text>
            </Pressable>
            <Pressable onPress={() => softDelete("goal", goal.id, goal.title)} hitSlop={6}>
              <Text style={[styles.action, styles.danger]}>Delete</Text>
            </Pressable>
          </View>

          {tasks.filter((t) => t.goal_id === goal.id).map(renderTask)}
        </View>
      ))}

      {unlinked.length > 0 && (
        <View style={styles.goalCard}>
          <Text style={styles.goalTitle}>Unlinked tasks</Text>
          <Text style={styles.meta}>Not tied to a goal</Text>
          <View style={{ marginTop: 8 }}>{unlinked.map(renderTask)}</View>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  heading: { fontSize: 24, fontWeight: "700", marginBottom: 16 },
  empty: { color: "#888", lineHeight: 21, marginTop: 8 },
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
  goalCard: {
    borderWidth: 1,
    borderColor: "#eee",
    borderRadius: 10,
    padding: 14,
    marginBottom: 14,
  },
  goalHeader: { flexDirection: "row", alignItems: "flex-start" },
  goalTitle: { fontSize: 16, fontWeight: "700" },
  why: { fontSize: 13, color: "#555", fontStyle: "italic", marginTop: 4 },
  meta: { fontSize: 12, color: "#888", marginTop: 2 },
  goalActions: {
    flexDirection: "row",
    gap: 16,
    marginTop: 10,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#f2f2f2",
  },
  action: { fontSize: 13, color: "#3060d0", fontWeight: "600" },
  danger: { color: "#c0392b" },
  taskRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: "#f7f7f7",
  },
  check: { width: 22 },
  checkMark: { fontSize: 17 },
  taskTitle: { fontSize: 15 },
  done: { textDecorationLine: "line-through", color: "#999" },
  editInput: {
    borderWidth: 1,
    borderColor: "#ccd",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
    fontSize: 15,
  },
});
