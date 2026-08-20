import { supabase } from "./supabase";

/**
 * Every user-confirmed state change must land in `events` — it's the append-only
 * record the priority engine, drift detection, and summaries all derive from.
 * A mutation that silently skips its event leaves history unreconstructable.
 *
 * This throws on failure rather than returning an error, so a caller that
 * forgets to check can't quietly lose the record.
 *
 * NOTE: this is for direct user actions only. AI-inferred progress must go to
 * `proposed_events` and be confirmed before promotion — never through here.
 */
export type EventType =
  | "goal_added"
  | "goal_edited"
  | "goal_achieved"
  | "goal_reopened"
  | "goal_abandoned"
  | "task_added"
  | "task_edited"
  | "task_completed"
  | "task_reopened"
  | "task_abandoned";

export async function logEvent(params: {
  userId: string;
  eventType: EventType;
  entityType: "goal" | "task";
  entityId: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await supabase.from("events").insert({
    user_id: params.userId,
    event_type: params.eventType,
    entity_type: params.entityType,
    entity_id: params.entityId,
    payload: params.payload ?? {},
  });
  if (error) throw error;
}
