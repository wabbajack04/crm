begin;

create type public.crm_role as enum ('manager', 'worker');
create type public.task_status as enum ('new', 'in_progress', 'review', 'accepted', 'revision');

create table public.profiles (
  id uuid primary key references auth.users(id),
  full_name text not null check (char_length(btrim(full_name)) between 1 and 120),
  role public.crm_role not null,
  unique (id, role)
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 160),
  address text not null check (char_length(btrim(address)) between 1 and 300)
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 160),
  description text not null check (char_length(btrim(description)) between 1 and 5000),
  assignee_id uuid not null,
  author_id uuid not null default auth.uid(),
  assignee_role public.crm_role generated always as ('worker'::public.crm_role) stored,
  author_role public.crm_role generated always as ('manager'::public.crm_role) stored,
  foreign key (assignee_id, assignee_role) references public.profiles(id, role),
  foreign key (author_id, author_role) references public.profiles(id, role),
  status public.task_status not null default 'new',
  created_at timestamptz not null default now()
);

create table public.task_history (
  id bigint generated always as identity primary key,
  task_id uuid not null references public.tasks(id) on delete cascade,
  actor_id uuid not null references public.profiles(id),
  from_status public.task_status,
  to_status public.task_status not null,
  comment text check (comment is null or char_length(comment) <= 2000),
  created_at timestamptz not null default clock_timestamp()
);

create index tasks_project_idx on public.tasks(project_id);
create index tasks_assignee_idx on public.tasks(assignee_id);
create index tasks_author_idx on public.tasks(author_id);
create index task_history_task_idx on public.task_history(task_id, id);

create schema crm_private;
revoke all on schema crm_private from public;
grant usage on schema crm_private to authenticated;

create function crm_private.is_manager()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'manager'
  );
$$;

revoke all on function crm_private.is_manager() from public;
grant execute on function crm_private.is_manager() to authenticated;

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.tasks enable row level security;
alter table public.task_history enable row level security;

revoke all on public.profiles, public.projects, public.tasks, public.task_history
  from public, anon, authenticated;
revoke all on sequence public.task_history_id_seq from public, anon, authenticated;
grant select on public.profiles, public.projects, public.tasks, public.task_history to authenticated;
grant insert (name, address), update (name, address), delete on public.projects to authenticated;
grant insert (project_id, title, description, assignee_id),
  update (project_id, title, description, assignee_id), delete on public.tasks to authenticated;

create policy profiles_read on public.profiles for select to authenticated
  using (
    id = (select auth.uid()) or (select crm_private.is_manager())
    or exists (
      select 1 from public.tasks t
      where t.author_id = profiles.id and t.assignee_id = (select auth.uid())
    )
  );

create policy projects_read on public.projects for select to authenticated
  using (
    (select crm_private.is_manager()) or exists (
      select 1 from public.tasks t where t.project_id = projects.id
        and t.assignee_id = (select auth.uid())
    )
  );
create policy projects_insert on public.projects for insert to authenticated
  with check ((select crm_private.is_manager()));
create policy projects_update on public.projects for update to authenticated
  using ((select crm_private.is_manager())) with check ((select crm_private.is_manager()));
create policy projects_delete on public.projects for delete to authenticated
  using ((select crm_private.is_manager()));

create policy tasks_read on public.tasks for select to authenticated
  using ((select crm_private.is_manager()) or assignee_id = (select auth.uid()));
create policy tasks_insert on public.tasks for insert to authenticated
  with check ((select crm_private.is_manager()) and author_id = (select auth.uid()) and status = 'new');
create policy tasks_update on public.tasks for update to authenticated
  using ((select crm_private.is_manager()) and author_id = (select auth.uid()) and status = 'new')
  with check ((select crm_private.is_manager()) and author_id = (select auth.uid()) and status = 'new');
create policy tasks_delete on public.tasks for delete to authenticated
  using ((select crm_private.is_manager()) and author_id = (select auth.uid()));

create policy history_read on public.task_history for select to authenticated
  using (exists (select 1 from public.tasks t where t.id = task_history.task_id));

create function crm_private.log_task_creation()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.task_history (task_id, actor_id, to_status)
  values (new.id, new.author_id, new.status);
  return new;
end;
$$;

revoke all on function crm_private.log_task_creation() from public, anon, authenticated;
create trigger task_created after insert on public.tasks
  for each row execute function crm_private.log_task_creation();

create function public.transition_task(
  p_task_id uuid,
  p_to public.task_status,
  p_comment text default null
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  task public.tasks%rowtype;
  note text := nullif(regexp_replace(p_comment, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
begin
  if actor is null then
    raise exception 'Требуется вход' using errcode = '42501';
  end if;

  select * into task from public.tasks
  where id = p_task_id and (assignee_id = actor or author_id = actor)
  for update;

  if not found then
    raise exception 'Задача недоступна' using errcode = '42501';
  end if;

  if not coalesce(
    (task.assignee_id = actor and (
      (task.status in ('new', 'revision') and p_to = 'in_progress')
      or (task.status = 'in_progress' and p_to = 'review')
    )) or (
      task.author_id = actor and task.status = 'review' and p_to in ('accepted', 'revision')
    ), false
  ) then
    raise exception 'Этот переход статуса недоступен' using errcode = '42501';
  end if;

  if p_to = 'revision' and note is null then
    raise exception 'Укажите причину возврата на доработку' using errcode = '22023';
  end if;
  if char_length(note) > 2000 then
    raise exception 'Комментарий должен содержать не более 2000 символов' using errcode = '22023';
  end if;

  update public.tasks set status = p_to where id = task.id;
  insert into public.task_history (task_id, actor_id, from_status, to_status, comment)
  values (task.id, actor, task.status, p_to, note);
end;
$$;

revoke all on function public.transition_task(uuid, public.task_status, text)
  from public, anon, authenticated;
grant execute on function public.transition_task(uuid, public.task_status, text) to authenticated;

commit;
