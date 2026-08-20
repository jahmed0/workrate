# Workrate — MVP Slice 1: Brain Dump → Structured Goals/Tasks

This is the first working piece: capture → AI extraction → human review → confirmed save.
Nothing gets written to the database until you explicitly confirm it (see the design notes below).

## Setup

### 1. Prerequisites

Node.js LTS. Everything else is a project-local dependency — no global installs needed
(the Supabase CLI is a devDependency, run via `npx supabase`).

```bash
npm install
```

### 2. Supabase project

1. Create a project at [supabase.com/dashboard](https://supabase.com/dashboard)
2. **Project Settings → API Keys** — copy the **Project URL** and the **publishable key**
   (`sb_publishable_…`, the replacement for the old anon key)
3. **Authentication → Sign In / Providers → Email** — turn **off** "Confirm email"
   for personal use. Left on, sign-up succeeds but returns no session, and the app
   waits for a confirmation link before it will let you in.
4. Run `supabase/schema.sql` against the project — either paste it into the SQL Editor,
   or link the CLI and push it.

### 3. Environment variables

```bash
cp .env.example .env
```

Fill in all three values. `.env` is gitignored.

- `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` are inlined into
  the app bundle at build time. That's expected — the publishable key is designed to be
  public, and Row Level Security is what actually protects the data.
- `ANTHROPIC_API_KEY` is **server-side only**. It's used to push the secret to Supabase
  and lives in the Edge Function runtime. It never reaches the app bundle. Do not add
  an `EXPO_PUBLIC_` prefix to it.

Env vars are read at dev-server startup — restart `npx expo start` after editing `.env`.

### 4. Deploy the extraction Edge Function

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase functions deploy extract-goals
npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-your-key-here
```

Your Claude API key stays server-side in the Edge Function — it's never in the app bundle.
The function requires a valid Supabase JWT by default, so only signed-in users can invoke it.

### 5. Run the app

```bash
npx expo start
```

Scan the QR code with Expo Go on your phone, or press `w` for web.

## Project layout

| Path | What it is |
|---|---|
| `App.tsx` | Auth gate + bottom-tab navigation (Focus / Progress / Goals / Brain Dump) |
| `src/screens/SignInScreen.tsx` | Email/password sign-in and sign-up |
| `src/screens/BrainDumpScreen.tsx` | Capture → extract → review → confirmed save |
| `src/screens/GoalsScreen.tsx` | Goal/task list with complete, edit, and soft-delete |
| `src/screens/FocusScreen.tsx` | "What should I do now" — live ranked task list |
| `src/screens/ProgressScreen.tsx` | "How am I doing" — life-area bins, per-goal drift, 7-day momentum |
| `src/lib/supabase.ts` | Supabase client, configured from `.env` |
| `src/lib/events.ts` | `logEvent()` — the one way user actions reach `events` |
| `src/lib/priority.ts` | Rule-based ranking for Focus. Pure functions, no I/O |
| `src/lib/drift.ts` | Shared "days since touched" math for Focus and Progress |
| `tests/priority.verify.mts` | Ranking checks — `npm run verify:priority` |
| `supabase/schema.sql` | Full DB schema, RLS policies, and the append-only triggers |
| `supabase/functions/extract-goals/` | Deno Edge Function that calls Claude |

## What this slice does

1. You type/paste a messy brain dump of goals and tasks
2. It's sent to the `extract-goals` Edge Function, which calls Claude to structure it into
   goals (with inferred life_area and horizon) and tasks
3. You review the proposed structure — toggle off anything wrong — before anything touches
   the database
4. On confirm, goals and tasks are inserted, and matching `events` rows are logged
   (append-only, source of truth for everything downstream)

The Edge Function uses structured outputs (`output_config.format`), so the API validates
Claude's response against a JSON schema before it's returned. There's no markdown-fence
stripping or best-effort parsing in the path.

## Design notes carried over from our schema discussion

- **`events` is append-only and immutable** (enforced by a DB trigger) — it's the permanent
  record everything else is derived from.
- **AI never writes directly to `events`.** In this slice, the events written are the *user's
  own confirmed action* (saving a goal), not an AI inference — that distinction matters. Once
  we build progress-tracking/chat, AI-inferred events (e.g. "sounds like you finished X") will
  go into `proposed_events` and need your confirmation before promotion.
- **`goals`/`tasks` are soft-delete only** (`deleted_at`) — nothing is ever truly lost.
- **Account erasure goes through `select public.erase_user('<uuid>')`.** A plain
  `delete from auth.users` fails: the FK cascade tries to delete from `events`, which the
  append-only trigger blocks. `erase_user()` sets a transaction-local flag that the trigger
  honours for DELETE only — UPDATE stays forbidden unconditionally, so history can never be
  rewritten, only erased wholesale. The function is `SECURITY DEFINER` with EXECUTE revoked
  from `anon`/`authenticated`, so it is unreachable from a signed-in client. Any new
  user-owned table should cascade from `auth.users` so erasure stays complete.
- **RLS is on for every table**, scoped to `auth.uid()` — the multi-user path is already live,
  it's just that only you have an account right now.

## Next slices (in order)

1. ~~Auth screens (sign up / sign in)~~ — done
2. ~~Basic goal/task list view + manual CRUD (edit/complete/delete what got extracted)~~ — done
3. Priority engine — **rule-based pass done** (`src/lib/priority.ts`). **AI reasoning layer
   still to do** — it should adjust and explain on top of the rules, never replace them, so the
   app keeps working when the API is slow or down.
4. ~~Daily focus screen~~ — done (`FocusScreen.tsx`). Fully live: recomputed on every visit
   from `goals`/`tasks`/`events`, no manual save step.
5. ~~Drift detection~~ — done, as an **in-app automatic view** rather than a scheduled job or
   push notification (`ProgressScreen.tsx`). Goals are grouped into life-area bins, each goal
   shows days since its last event and a fresh/quiet/stale badge (`src/lib/drift.ts`), and a
   7-day completion count gives a momentum signal. No infrastructure beyond what already
   exists — reopens the push-notification path later if that turns out to matter.
6. Chat/decision-support — retrieval-grounded, using `context_summaries` + filtered goals/tasks
7. Context summary generation job (the tiered summarization from our earlier discussion)
