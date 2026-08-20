-- ============================================================
-- LIFE OS — Core Schema
-- Event-sourced, append-only history, versioned summaries,
-- soft-deletes, RLS-ready for multi-user from day one.
-- ============================================================

create extension if not exists "uuid-ossp";

-- ------------------------------------------------------------
-- USERS (extends Supabase auth.users)
-- ------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  persona_instructions text default '', -- user-authored tone/boundary rules
  timezone text default 'Europe/London',
  created_at timestamptz default now()
);

-- ------------------------------------------------------------
-- GOALS (soft-delete only, never hard-deleted)
-- ------------------------------------------------------------
create table public.goals (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  why_it_matters text,
  life_area text,          -- e.g. 'health','faith','career' — AI-assigned, editable
  horizon text,             -- e.g. 'life','year','quarter' — AI-assigned, editable
  parent_goal_id uuid references public.goals(id),
  status text default 'active', -- active | paused | achieved | abandoned
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted_at timestamptz
);

-- ------------------------------------------------------------
-- TASKS (soft-delete only)
-- ------------------------------------------------------------
create table public.tasks (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  goal_id uuid references public.goals(id),
  title text not null,
  status text default 'open', -- open | in_progress | done | abandoned
  priority_score numeric,      -- latest AI-derived score, cheap to update
  due_date date,
  source text default 'manual', -- manual | ai_extracted
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted_at timestamptz
);

-- ------------------------------------------------------------
-- EVENTS — append-only, immutable source of truth
-- ------------------------------------------------------------
create table public.events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null, -- task_completed | goal_added | priority_shifted | task_abandoned | deadline_missed | goal_added | checkin_submitted ...
  entity_type text,          -- 'goal' | 'task' | null
  entity_id uuid,
  payload jsonb default '{}',
  created_at timestamptz default now()
);
-- events are NEVER updated or deleted by the app. Enforce with a rule/trigger if you want to be strict:
-- UPDATE is forbidden unconditionally — history can never be rewritten.
-- DELETE is forbidden too, except inside erase_user() below, which sets a
-- transaction-local flag. Tampering stays impossible; whole-account erasure
-- gets exactly one auditable door.
create or replace function public.prevent_event_mutation()
returns trigger as $$
begin
  if tg_op = 'DELETE'
     and current_setting('workrate.allow_event_erasure', true) = 'on' then
    return old;
  end if;
  raise exception 'events table is append-only';
end;
$$ language plpgsql;

-- Account erasure (GDPR "right to be forgotten", or just deleting a test user).
-- SECURITY DEFINER so it runs as the owner; EXECUTE is revoked from anon and
-- authenticated below, so this capability is unreachable from a signed-in
-- client. The FK cascades from auth.users clear profiles/goals/tasks/events.
create or replace function public.erase_user(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  -- The third arg (is_local) scopes this to the current transaction, so it
  -- reverts on commit OR rollback. There is no window where the flag is left
  -- on, and no way to forget to turn it off.
  perform set_config('workrate.allow_event_erasure', 'on', true);
  delete from auth.users where id = target_user_id;
end;
$$;

-- Postgres grants EXECUTE to PUBLIC by default — revoking is what makes this safe.
revoke all on function public.erase_user(uuid) from public;
revoke all on function public.erase_user(uuid) from anon, authenticated;

create trigger no_update_events before update on public.events
  for each row execute function public.prevent_event_mutation();
create trigger no_delete_events before delete on public.events
  for each row execute function public.prevent_event_mutation();

-- ------------------------------------------------------------
-- PROPOSED EVENTS — AI writes here, never directly to events.
-- Must be confirmed (by user or a validated rule) before promotion.
-- ------------------------------------------------------------
create table public.proposed_events (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  entity_type text,
  entity_id uuid,
  payload jsonb default '{}',
  confidence numeric,          -- AI's confidence 0-1
  status text default 'pending', -- pending | confirmed | rejected
  reasoning text,               -- why the AI proposed this
  created_at timestamptz default now(),
  resolved_at timestamptz
);

-- ------------------------------------------------------------
-- CONTEXT SUMMARIES — versioned, append-only, regenerated not overwritten
-- ------------------------------------------------------------
create table public.context_summaries (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  version int not null,
  content text not null,        -- the cold-tier summary, capped ~300 tokens
  source_event_start bigint,    -- range of events.id this was generated from
  source_event_end bigint,
  model_used text,
  previous_version_id uuid references public.context_summaries(id),
  generated_at timestamptz default now()
);

-- ------------------------------------------------------------
-- MONTHLY ROLLUPS — warm tier
-- ------------------------------------------------------------
create table public.monthly_rollups (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  month date not null, -- first day of month
  content text not null,
  source_event_start bigint,
  source_event_end bigint,
  generated_at timestamptz default now(),
  unique(user_id, month)
);

-- ------------------------------------------------------------
-- PRIORITY SNAPSHOTS — versioned, append-only, with visible reasoning
-- ------------------------------------------------------------
create table public.priority_snapshots (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ranked_task_ids uuid[] not null,
  reasoning text,
  trigger_event_id bigint references public.events(id),
  generated_at timestamptz default now()
);

-- ------------------------------------------------------------
-- CHECK-INS
-- ------------------------------------------------------------
create table public.checkins (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text default 'daily', -- daily | weekly
  content text,
  mood int, -- optional 1-5
  created_at timestamptz default now()
);

-- ------------------------------------------------------------
-- CONVERSATIONS
-- ------------------------------------------------------------
create table public.conversations (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null, -- user | assistant
  content text not null,
  created_at timestamptz default now()
);

-- ------------------------------------------------------------
-- INDEXES
-- ------------------------------------------------------------
create index idx_goals_user on public.goals(user_id) where deleted_at is null;
create index idx_tasks_user on public.tasks(user_id) where deleted_at is null;
create index idx_tasks_goal on public.tasks(goal_id);
create index idx_events_user_time on public.events(user_id, created_at desc);
create index idx_proposed_events_pending on public.proposed_events(user_id, status) where status = 'pending';
create index idx_context_summaries_latest on public.context_summaries(user_id, version desc);

-- ------------------------------------------------------------
-- ROW LEVEL SECURITY — every table scoped to the owning user
-- ------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.goals enable row level security;
alter table public.tasks enable row level security;
alter table public.events enable row level security;
alter table public.proposed_events enable row level security;
alter table public.context_summaries enable row level security;
alter table public.monthly_rollups enable row level security;
alter table public.priority_snapshots enable row level security;
alter table public.checkins enable row level security;
alter table public.conversations enable row level security;

create policy "own profile" on public.profiles for all using (auth.uid() = id);
create policy "own goals" on public.goals for all using (auth.uid() = user_id);
create policy "own tasks" on public.tasks for all using (auth.uid() = user_id);
create policy "own events read" on public.events for select using (auth.uid() = user_id);
create policy "own events insert" on public.events for insert with check (auth.uid() = user_id);
create policy "own proposed_events" on public.proposed_events for all using (auth.uid() = user_id);
create policy "own context_summaries" on public.context_summaries for all using (auth.uid() = user_id);
create policy "own monthly_rollups" on public.monthly_rollups for all using (auth.uid() = user_id);
create policy "own priority_snapshots" on public.priority_snapshots for all using (auth.uid() = user_id);
create policy "own checkins" on public.checkins for all using (auth.uid() = user_id);
create policy "own conversations" on public.conversations for all using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- Auto-create profile row on signup
-- ------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
