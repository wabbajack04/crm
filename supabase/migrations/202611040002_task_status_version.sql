begin;

alter table public.tasks add column status_version bigint not null default 0;
drop function public.transition_task(uuid, public.task_status, text);

create function public.transition_task(
  p_task_id uuid,
  p_to public.task_status,
  p_expected_version bigint,
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

  if task.status_version is distinct from p_expected_version then
    raise exception 'Статус задачи изменился. Проверьте актуальную историю и повторите действие.'
      using errcode = 'PT409';
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

  update public.tasks set status = p_to, status_version = status_version + 1 where id = task.id;
  insert into public.task_history (task_id, actor_id, from_status, to_status, comment)
  values (task.id, actor, task.status, p_to, note);
end;
$$;

revoke all on function public.transition_task(uuid, public.task_status, bigint, text)
  from public, anon, authenticated;
grant execute on function public.transition_task(uuid, public.task_status, bigint, text) to authenticated;

commit;
