-- ============================================================================
-- LearnSphere AI - Supabase schema (Firebase identity, Supabase data)
-- ----------------------------------------------------------------------------
-- Identity comes from Firebase Authentication. This schema stores application
-- data only; it does not use Supabase Auth and has no auth.users dependency.
--
-- Apply with:  supabase db push   (or paste into the SQL editor)
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- records
--   One row per application entity. `collection` names the entity type, which
--   is how the server's existing, tested storage layer addresses it:
--     users | auth-sessions | password-resets
--     materials | sessions | quizzes | attempts
--     flashcard-decks | flashcard-reviews | studio-visuals
--     learning-paths | study-plans
--   `owner_id` is the application account id (a Firebase UID for accounts
--   created through Firebase). Rows in the account collections have no owner.
--   `data` holds the entity exactly as the API produces it, so the response
--   contract is unchanged.
-- ---------------------------------------------------------------------------
create table if not exists public.records (
  collection  text        not null,
  id          text        not null,
  owner_id    text,
  data        jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint records_pkey primary key (collection, id)
);

create index if not exists records_collection_idx
  on public.records (collection);
create index if not exists records_owner_idx
  on public.records (owner_id);
create index if not exists records_collection_owner_idx
  on public.records (collection, owner_id);
create index if not exists records_updated_idx
  on public.records (collection, updated_at desc);
create index if not exists records_data_gin
  on public.records using gin (data jsonb_path_ops);

-- One Firebase UID may back at most one account record.
create unique index if not exists records_firebase_uid_idx
  on public.records ((data ->> 'firebaseUid'))
  where collection = 'users' and (data ->> 'firebaseUid') is not null;

-- One account per email address, case-insensitively.
create unique index if not exists records_user_email_idx
  on public.records (lower(data ->> 'emailKey'))
  where collection = 'users' and (data ->> 'emailKey') is not null;

-- ---------------------------------------------------------------------------
-- material_passages
--   Extracted, citable passages per uploaded material. Kept out of `records`
--   because one document produces hundreds of them and retrieval reads them by
--   material, in page order.
-- ---------------------------------------------------------------------------
create table if not exists public.material_passages (
  material_id text        not null,
  position    integer     not null,
  data        jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  constraint material_passages_pkey primary key (material_id, position)
);

create index if not exists material_passages_material_idx
  on public.material_passages (material_id, position);

-- ---------------------------------------------------------------------------
-- profiles - a read-only view over the account records, for reporting and for
-- reviewing who has access without reading JSON by hand.
--
-- security_invoker makes the view run with the caller's privileges instead of
-- the owner's. Without it a view on a table that has RLS enabled and no read
-- policies is an RLS bypass: anyone granted access to the view would read every
-- account. Client roles are also revoked below, so access is service-role only.
-- ---------------------------------------------------------------------------
create or replace view public.profiles
  with (security_invoker = true) as
select
  r.id                                              as user_id,
  r.data ->> 'firebaseUid'                          as firebase_uid,
  r.data ->> 'email'                                as email,
  r.data ->> 'displayName'                          as display_name,
  (r.data ->> 'emailVerified')::boolean             as email_verified,
  coalesce(r.data ->> 'authProvider', 'password')    as auth_provider,
  r.data -> 'profile'                               as profile,
  coalesce((r.data ->> 'onboardingCompleted')::boolean, false) as onboarding_completed,
  r.created_at,
  r.updated_at
from public.records r
where r.collection = 'users';

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists records_touch_updated_at on public.records;
create trigger records_touch_updated_at
  before update on public.records
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- The backend talks to Postgres with the service-role key, which BYPASSES RLS;
-- ownership is therefore enforced in the API (the account id always comes from
-- a verified Firebase ID token, never from the request body). RLS is still
-- enabled and all client roles are denied, so a leaked anon key cannot read a
-- single row.
--
-- Deliberately no permissive policy is defined for `anon` or `authenticated`.
-- Supabase auth.jwt() belongs to Supabase Auth; a Firebase ID token never
-- populates it, so a policy keyed on a `firebase_uid` claim would be dead code
-- and only invite the false belief that client access is supported. Only
-- deny rules are declared here, so the tables stay closed to client roles.
-- ---------------------------------------------------------------------------
alter table public.records           enable row level security;
alter table public.material_passages enable row level security;

revoke all on public.records           from anon, authenticated;
revoke all on public.material_passages from anon, authenticated;
revoke all on public.profiles          from anon, authenticated;

-- The backend connects as `service_role`. It bypasses RLS, but it still needs
-- table privileges: a table created by another role does not automatically
-- grant them, and until they exist every API request fails with
--   403 permission denied for table records
-- even though the service-role key is correct. Grant exactly what the store
-- reads and writes, and nothing more.
grant usage on schema public to service_role;
grant select, insert, update, delete on public.records           to service_role;
grant select, insert, update, delete on public.material_passages to service_role;
grant select on public.profiles to service_role;

-- Records are service-role only; drop the old claim-based policies so a
-- re-run of this migration on an existing database removes them.
drop policy if exists records_owner_select on public.records;
drop policy if exists records_owner_write  on public.records;

-- Passages inherit ownership through their material: the API is the only
-- writer (service role), and no client role may read another account's text.
drop policy if exists material_passages_deny_all on public.material_passages;
create policy material_passages_deny_all on public.material_passages
  for all to authenticated
  using (false)
  with check (false);

-- ---------------------------------------------------------------------------
-- Storage: private bucket for the uploaded originals
-- ---------------------------------------------------------------------------
-- `do update` forces the bucket back to private if it already exists and was
-- created public: a public bucket serves originals to anyone with the URL and
-- bypasses every RLS policy below.
insert into storage.buckets (id, name, public, file_size_limit)
values ('materials', 'materials', false, 20971520)
on conflict (id) do update
  set public          = false,
      file_size_limit = excluded.file_size_limit;

-- Deny-only policy. The previous variant used `bucket_id <> 'materials'`,
-- which granted client roles access to every *other* bucket and denied
-- nothing. A policy with `using (false)` only ever removes access.
drop policy if exists materials_no_client_access on storage.objects;
drop policy if exists materials_client_deny    on storage.objects;
create policy materials_client_deny on storage.objects
  for all to authenticated
  using (bucket_id = 'materials' and false)
  with check (bucket_id = 'materials' and false);
