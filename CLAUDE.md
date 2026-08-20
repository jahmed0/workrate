# CLAUDE.md — Workrate project handoff

## What this is
A cross-platform (iOS/Android/web) personal AI assistant for tracking goals and tasks,
prioritizing them, and helping decision-making — built to counter "drift" and help the
user stay in control of their life direction. Personal use first, architected for
multi-user later (RLS is already in place).

## Stack
- **Frontend:** React Native + Expo
- **Backend:** Supabase (Postgres, Auth, Edge Functions, Row Level Security)
- **AI:** Claude API (Anthropic) — Sonnet for extraction/reasoning, Haiku planned later for cheap classification tasks

## What's already built (in this folder)
- `supabase/schema.sql` — full DB schema: goals, tasks, append-only `events` table
  (source of truth, immutable via trigger), `proposed_events` (AI writes proposals here,
  never directly to `events`), versioned `context_summaries`, `monthly_rollups`,
  `priority_snapshots`, `checkins`, `conversations`. RLS enabled on every table.
- `supabase/functions/extract-goals/index.ts` — Edge Function that takes a raw brain-dump
  string, calls Claude, returns structured goals/tasks as JSON. Does NOT write to DB —
  extraction is propose-only, client handles confirm/save.
- `src/lib/supabase.ts` — Supabase client stub, needs real URL/anon key filled in.
- `src/screens/BrainDumpScreen.tsx` — working screen: text input → calls extract-goals →
  shows toggleable review list → confirmed items get saved + logged as events.
- `README.md` — original setup steps (manual version, superseded by this handoff).

## What you need to do
1. Set up the Expo project properly (this folder has loose source files, not a full
   Expo scaffold yet — run `npx create-expo-app` and merge these files in, or init in place).
2. Ask the user for: Supabase project URL + anon key, and their Anthropic API key.
   Do NOT ask them to run CLI commands themselves — you have terminal access, use it.
3. Run the schema against their Supabase project (via `supabase` CLI or have them paste
   it into the SQL Editor if CLI auth is awkward — your call).
4. Deploy the `extract-goals` Edge Function and set the `ANTHROPIC_API_KEY` secret.
5. Wire up basic auth (email sign-in is fine for MVP) — this doesn't exist yet and is
   required before BrainDumpScreen works, since it needs `supabase.auth.getUser()`.
6. Get `npx expo start` running and confirm the brain-dump flow works end to end.

## Design principles to preserve (don't simplify these away)
- **`events` is append-only and immutable** — enforced by DB trigger. This is the
  permanent record everything else derives from.
- **AI never writes directly to `events`.** AI-inferred progress (e.g. "sounds like you
  finished X" from a chat) must go into `proposed_events` and get user-confirmed before
  promotion to `events`. This is a hard rule — it's the main defense against hallucinated
  progress/ghost events.
- **`goals`/`tasks` are soft-delete only** (`deleted_at` column) — nothing is ever
  hard-deleted, so history stays reconstructable.
- **Context sent to Claude must stay bounded regardless of how long the user has used
  the app.** Tiered approach: cold `context_summaries` (versioned, regenerated not
  overwritten, capped ~300 tokens) + warm `monthly_rollups` + hot recent raw `events`
  (last ~2 weeks). Never dump the full event history into a prompt.
- **Tone/persona is user-authored**, not hardcoded — `profiles.persona_instructions` is
  a free-text field the user writes themselves for how direct/challenging the assistant
  should be. Don't bake a fixed personality into the system prompt; pull from this field.

## Build order after handoff (don't jump ahead)
1. Auth screens (sign up / sign in)
2. Goal/task list view + manual CRUD (edit/complete/delete)
3. Priority engine — start rule-based (due date + horizon + recency), layer AI reasoning
   on top, write results to `priority_snapshots` with visible reasoning text
4. Daily focus screen pulling from latest priority snapshot
5. Drift detection — scheduled job scanning `events` for goals untouched >N days,
   triggers a push notification
6. Chat / decision-support — retrieval-grounded (SQL filtering first, not a vector DB
   at this scale), using `context_summaries` + relevant goals/tasks in the prompt
7. Context summary regeneration job (the tiered summarization described above)

Ask the user clarifying questions if any of the above is ambiguous rather than guessing —
they've been deliberate about these architecture choices in prior planning.
