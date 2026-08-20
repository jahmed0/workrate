import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Button,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Switch,
} from "react-native";
import { supabase } from "../lib/supabase";

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

export default function BrainDumpScreen() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [goals, setGoals] = useState<ProposedGoal[]>([]);
  const [tasks, setTasks] = useState<ProposedTask[]>([]);
  const [selectedGoals, setSelectedGoals] = useState<Record<string, boolean>>({});
  const [selectedTasks, setSelectedTasks] = useState<Record<number, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runExtraction = async () => {
    setError(null);
    setLoading(true);
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
      setLoading(false);
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

        // log the event — this is the one place events ARE written
        // directly, because it's a direct user-confirmed action, not
        // an AI inference. AI-inferred progress must go through
        // proposed_events instead.
        const { error: goalEventErr } = await supabase.from("events").insert({
          user_id: user.id,
          event_type: "goal_added",
          entity_type: "goal",
          entity_id: inserted.id,
          payload: { source: "brain_dump" },
        });
        // events is the source of truth everything downstream derives from —
        // a silent failure here leaves a goal with no history.
        if (goalEventErr) throw goalEventErr;
      }

      for (const t of tasksToSave) {
        const goalId = t.goal_ref ? tempToRealId[t.goal_ref] ?? null : null;
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

        const { error: taskEventErr } = await supabase.from("events").insert({
          user_id: user.id,
          event_type: "task_added",
          entity_type: "task",
          entity_id: inserted.id,
          payload: { source: "brain_dump" },
        });
        if (taskEventErr) throw taskEventErr;
      }

      setGoals([]);
      setTasks([]);
      setText("");
    } catch (e: any) {
      setError(e.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const hasResults = goals.length > 0 || tasks.length > 0;

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 60 }}>
      <Text style={styles.heading}>Brain Dump</Text>
      <Text style={styles.subtext}>
        Dump everything — goals, half-formed ideas, to-dos. Don't organize it, just get it out.
      </Text>

      <TextInput
        style={styles.textArea}
        multiline
        placeholder="e.g. I want to get fit again, been slacking for months. Need to finish the tax return by end of month. Long term I want to..."
        value={text}
        onChangeText={setText}
        editable={!loading}
      />

      <Button title={loading ? "Thinking..." : "Structure this"} onPress={runExtraction} disabled={loading || !text.trim()} />
      {loading && <ActivityIndicator style={{ marginTop: 12 }} />}
      {error && <Text style={styles.error}>{error}</Text>}

      {hasResults && (
        <View style={styles.results}>
          <Text style={styles.sectionHeading}>Goals ({goals.length})</Text>
          <Text style={styles.reviewNote}>Review before saving — nothing is written until you confirm.</Text>
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

          <Text style={styles.sectionHeading}>Tasks ({tasks.length})</Text>
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

          <Button title={saving ? "Saving..." : "Confirm & Save"} onPress={confirmAndSave} disabled={saving} />
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: "#fff" },
  heading: { fontSize: 24, fontWeight: "700", marginTop: 20 },
  subtext: { color: "#666", marginTop: 4, marginBottom: 16 },
  textArea: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    padding: 12,
    minHeight: 140,
    textAlignVertical: "top",
    marginBottom: 12,
  },
  error: { color: "#c0392b", marginTop: 10 },
  results: { marginTop: 24 },
  sectionHeading: { fontSize: 18, fontWeight: "700", marginTop: 20, marginBottom: 4 },
  reviewNote: { color: "#888", fontSize: 12, marginBottom: 10 },
  reviewRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  itemTitle: { fontSize: 15, fontWeight: "600" },
  itemMeta: { fontSize: 12, color: "#888", marginTop: 2 },
  itemWhy: { fontSize: 13, color: "#555", marginTop: 4, fontStyle: "italic" },
});
