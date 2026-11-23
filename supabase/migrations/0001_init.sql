-- DRC CS 허브 — Phase 1 기본 스키마
-- Supabase 대시보드 → SQL Editor에 통째로 붙여넣고 [Run] 하면 됩니다. (여러 번 실행해도 안전)

-- ───────────────────────── 역할·담당자 ─────────────────────────
do $$ begin
  create type public.app_role as enum ('admin', 'approver', 'agent');
exception when duplicate_object then null; end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  role public.app_role not null default 'agent',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 로그인 계정이 생기면 담당자 프로필 자동 생성 (처음엔 '담당자' 권한)
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, split_part(new.email, '@', 1))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- 권한 확인 함수 (RLS에서 사용)
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active);
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and role = 'admin');
$$;

-- ───────────────────────── 문의 ─────────────────────────
create table if not exists public.inquiries (
  id bigint generated always as identity primary key,
  channel text not null check (channel in ('smartstore', 'coupang')),
  kind text not null check (kind in ('product_qna', 'order_inquiry', 'callcenter')),
  external_id text not null,
  product_id text,
  product_name text,
  order_id text,
  customer_masked text,
  title text,
  body_masked text not null,
  pii_detected boolean not null default false,
  received_at timestamptz not null,
  deadline_at timestamptz,
  platform_answered boolean not null default false,
  platform_answer text,
  platform_status text,
  can_reply boolean not null default true,
  meta jsonb not null default '{}'::jsonb,
  status text not null default 'new' check (status in ('new', 'answered_on_platform', 'closed')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- 같은 문의는 한 번만 저장 (중복 방지 기준)
  unique (channel, kind, external_id)
);
create index if not exists inquiries_received_idx on public.inquiries (received_at desc);
create index if not exists inquiries_status_idx on public.inquiries (status);
create index if not exists inquiries_deadline_idx on public.inquiries (deadline_at) where deadline_at is not null;

-- ───────────────────────── 휴일·설정·작업기 상태·기록 ─────────────────────────
create table if not exists public.holidays (
  date date primary key,
  name text not null,
  source text not null check (source in ('builtin', 'api', 'company')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

insert into public.settings (key, value) values
  ('operating', '{"start":"09:00","end":"18:00","weekdays":[1,2,3,4,5]}'),
  ('collect_interval_min', '10'),
  ('auto_post_enabled', 'false')
on conflict (key) do nothing;

create table if not exists public.worker_heartbeat (
  worker_id text primary key,
  beat_at timestamptz not null,
  mode text not null,          -- 'operating' | 'idle'
  version text,
  detail jsonb not null default '{}'::jsonb
);

create table if not exists public.collect_runs (
  id bigint generated always as identity primary key,
  channel text not null,
  kind text not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  window_from timestamptz,
  window_to timestamptz,
  fetched int not null default 0,
  inserted int not null default 0,
  ok boolean,
  error text
);
create index if not exists collect_runs_lookup_idx on public.collect_runs (channel, kind, started_at desc);

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid references auth.users(id),
  actor_label text,            -- 'worker' 등
  action text not null,
  target text,
  detail jsonb not null default '{}'::jsonb
);

-- ───────────────────────── 행 단위 보안(RLS) ─────────────────────────
-- 작업기는 service role 키를 쓰므로 RLS를 우회합니다. 아래는 웹(로그인한 담당자)용 규칙입니다.
alter table public.profiles enable row level security;
alter table public.inquiries enable row level security;
alter table public.holidays enable row level security;
alter table public.settings enable row level security;
alter table public.worker_heartbeat enable row level security;
alter table public.collect_runs enable row level security;
alter table public.audit_log enable row level security;

drop policy if exists "staff read profiles" on public.profiles;
create policy "staff read profiles" on public.profiles for select to authenticated using (public.is_staff() or id = auth.uid());
drop policy if exists "admin update profiles" on public.profiles;
create policy "admin update profiles" on public.profiles for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "staff read inquiries" on public.inquiries;
create policy "staff read inquiries" on public.inquiries for select to authenticated using (public.is_staff());

drop policy if exists "staff read holidays" on public.holidays;
create policy "staff read holidays" on public.holidays for select to authenticated using (public.is_staff());
drop policy if exists "admin add company holidays" on public.holidays;
create policy "admin add company holidays" on public.holidays for insert to authenticated with check (public.is_admin() and source = 'company');
drop policy if exists "admin delete company holidays" on public.holidays;
create policy "admin delete company holidays" on public.holidays for delete to authenticated using (public.is_admin() and source = 'company');

drop policy if exists "staff read settings" on public.settings;
create policy "staff read settings" on public.settings for select to authenticated using (public.is_staff());
drop policy if exists "admin update settings" on public.settings;
create policy "admin update settings" on public.settings for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "staff read heartbeat" on public.worker_heartbeat;
create policy "staff read heartbeat" on public.worker_heartbeat for select to authenticated using (public.is_staff());

drop policy if exists "staff read collect runs" on public.collect_runs;
create policy "staff read collect runs" on public.collect_runs for select to authenticated using (public.is_staff());

drop policy if exists "admin read audit" on public.audit_log;
create policy "admin read audit" on public.audit_log for select to authenticated using (public.is_admin());

-- 관리자가 담당자 역할을 바꾸면 기록 남기기
create or replace function public.log_profile_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role or new.active is distinct from old.active then
    insert into public.audit_log (actor, action, target, detail)
    values (auth.uid(), 'profile.update', new.email,
            jsonb_build_object('role_from', old.role, 'role_to', new.role, 'active_from', old.active, 'active_to', new.active));
  end if;
  return new;
end $$;
drop trigger if exists on_profile_change on public.profiles;
create trigger on_profile_change after update on public.profiles
  for each row execute function public.log_profile_change();

-- 관리자는 자기 자신의 관리자 권한을 해제할 수 없음 (관리자 0명 사고 방지)
create or replace function public.guard_self_demote() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.id = auth.uid() and old.role = 'admin' and (new.role <> 'admin' or not new.active) then
    raise exception '자기 자신의 관리자 권한은 해제할 수 없습니다.';
  end if;
  return new;
end $$;
drop trigger if exists guard_self_demote on public.profiles;
create trigger guard_self_demote before update on public.profiles
  for each row execute function public.guard_self_demote();
