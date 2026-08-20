import React, { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator, Switch } from "react-native";
import { supabase } from "../lib/supabase";
import { logEvent } from "../lib/events";

/**
 * Capture + extract + review, embedded inline at the top of Focus rather than
 * its own screen. Compact at rest — a single-line-height input — so it never
 * pushes the ranked list (the thing you actually opened the app to see) below
 * the fold. Expands in place once there's something to review.
 */

type ProposedGoal = {
  temp_id: string;
  title: string;
  why_it_matters: string;
  life_area: string;
  horizon: string;
};

type ProposedTask = {
  title: string;
  goal_ref: string | null;
  due_date: string | null;
};

export default function QuickCapture({ onSaved }: { onSaved: () => void }) {
  const [text, setText] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [goals, setGoals] = useState<ProposedGoal[]>([]);
  const [tasks, setTasks] = useState<ProposedTask[]>([]);
  const [selectedGoals, setSelectedGoals] = useState<Record<string, boolean>>({});
  const [selectedTasks, setSelectedTasks] = useState<Record<number, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runExtraction = async () => {
    setError(null);
    setExtracting(true);
    setGoals([]);
    setTasks([]);
    try {
      const { data, error: fnError } = await supabase.functions.invoke("extract-goals", {
        body: { brain_dump_text: text },
      });
      if (fnError) throw fnError;

      const proposedGoals: ProposedGoal[] = data.goals ?? [];
      const proposedTasks: ProposedTask[] = data.tasks ?? [];

      setGoals(proposedGoals);
      setTasks(proposedTasks);
      // default everything selected — user deselects what's wrong
      setSelectedGoals(Object.fromEntries(proposedGoals.map((g) => [g.temp_id, true])));
      setSelectedTasks(Object.fromEntries(proposedTasks.map((_, i) => [i, true])));
    } catch (e: any) {
      setError(e.message ?? "Extraction failed");
    } finally {
      setExtracting(false);
    }
  };

  const confirmAndSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in");

      const goalsToSave = goals.filter((g) => selectedGoals[g.temp_id]);
      const tasksToSave = tasks.filter((_, i) => selectedTasks[i]);

      // Insert goals first, capture real IDs, map temp_id -> real id
      const tempToRealId: Record<string, string> = {};
      for (const g of goalsToSave) {
        const { data: inserted, error: insertErr } = await supabase
          .from("goals")
          .insert({
            user_id: user.id,
            title: g.title,
            why_it_matters: g.why_it_matters,
            life_area: g.life_area,
            horizon: g.horizon,
            status: "active",
          })
          .select()
          .single();
        if (insertErr) throw insertErr;
        tempToRealId[g.temp_id] = inserted.id;

        // This is the one place events ARE written directly — it's a
        // direct user-confirmed action, not an AI inference. AI-inferred
        // progress must go through proposed_events instead.
        await logEvent({
          userId: user.id,
          eventType: "goal_added",
          entityType: "goal",
          entityId: inserted.id,
          payload: { source: "brain_dump" },
        });
      }

      for (const t of tasksToSave) {
        const goalId = t.goal_ref ? (tempToRealId[t.goal_ref] ?? null) : null;
        const { data: inserted, error: insertErr } = await supabase
          .from("tasks")
          .insert({
            user_id: user.id,
            goal_id: goalId,
            title: t.title,
            due_date: t.due_date,
            source: "ai_extracted",
            status: "open",
          })
          .select()
          .single();
        if (insertErr) throw insertErr;

        await logEvent({
          userId: user.id,
          eventType: "task_added",
          entityType: "task",
          entityId: inserted.id,
          payload: { source: "brain_dump" },
        });
      }

      setGoals([]);
      setTasks([]);
      setText("");
      onSaved();
    } catch (e: any) {
      setError(e.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const hasResults = goals.length > 0 || tasks.length > 0;

  return (
    <View style={styles.card}>
      <TextInput
        style={styles.input}
        multiline
        placeholder="Add a task, or dump what's on your mind — I'll sort it out."
        value={text}
        onChangeText={setText}
        editable={!extracting}
      />

      {!!text.trim() && !hasResults && (
        <Pressable
          style={[styles.button, extracting && styles.buttonDisabled]}
          onPress={runExtraction}
          disabled={extracting}
        >
          <Text style={styles.buttonText}>{extracting ? "Thinking..." : "Structure this"}</Text>
        </Pressable>
      )}
      {extracting && <ActivityIndicator style={{ marginTop: 10 }} />}
      {error && <Text style={styles.error}>{error}</Text>}

      {hasResults && (
        <View style={styles.results}>
          <Text style={styles.reviewNote}>Review before saving — nothing is written until you confirm.</Text>

          {goals.length > 0 && <Text style={styles.sectionHeading}>Goals ({goals.length})</Text>}
          {goals.map((g) => (
            <View key={g.temp_id} style={styles.reviewRow}>
              <Switch
                value={!!selectedGoals[g.temp_id]}
                onValueChange={(v) => setSelectedGoals((s) => ({ ...s, [g.temp_id]: v }))}
              />
              <View style={{ flex: 1, marginLeft: 10 }}>
                <Text style={styles.itemTitle}>{g.title}</Text>
                <Text style={styles.itemMeta}>
                  {g.life_area} · {g.horizon}
                </Text>
                {!!g.why_it_matters && <Text style={styles.itemWhy}>{g.why_it_matters}</Text>}
              </View>
            </View>
          ))}

          {tasks.length > 0 && <Text style={styles.sectionHeading}>Tasks ({tasks.length})</Text>}
          {tasks.map((t, i) => (
            <View key={i} style={styles.reviewRow}>
              <Switch
                value={!!selectedTasks[i]}
                onValueChange={(v) => setSelectedTasks((s) => ({ ...s, [i]: v }))}
              />
              <View style={{ flex: 1, marginLeft: 10 }}>
                <Text style={styles.itemTitle}>{t.title}</Text>
                {!!t.due_date && <Text style={styles.itemMeta}>Due {t.due_date}</Text>}
              </View>
            </View>
          ))}

          <Pressable
            style={[styles.button, saving && styles.buttonDisabled]}
            onPress={confirmAndSave}
            disabled={saving}
          >
            <Text style={styles.buttonText}>{saving ? "Saving..." : "Confirm & Save"}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: "#eee",
    borderRadius: 10,
    padding: 12,
    marginBottom: 20,
  },
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    padding: 10,
    minHeight: 44,
    maxHeight: 140,
    textAlignVertical: "top",
    fontSize: 14,
  },
  button: {
    backgroundColor: "#3060d0",
    borderRadius: 8,
    paddingVertical: 11,
    alignItems: "center",
    marginTop: 10,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  error: { color: "#c0392b", marginTop: 8, fontSize: 13 },
  results: { marginTop: 14 },
  sectionHeading: { fontSize: 15, fontWeight: "700", marginTop: 12, marginBottom: 2 },
  reviewNote: { color: "#888", fontSize: 12, marginBottom: 6 },
  reviewRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#f2f2f2",
  },
  itemTitle: { fontSize: 14, fontWeight: "600" },
  itemMeta: { fontSize: 12, color: "#888", marginTop: 2 },
  itemWhy: { fontSize: 12, color: "#555", marginTop: 3, fontStyle: "italic" },
});
