-- Run once in the SQL Editor after creating the three confirmed Auth users.
-- Change these email values if the demo accounts use different addresses.
begin;

do $$
declare
  manager uuid := (select id from auth.users where lower(email) = 'manager@crm.example.com');
  worker1 uuid := (select id from auth.users where lower(email) = 'worker1@crm.example.com');
  worker2 uuid := (select id from auth.users where lower(email) = 'worker2@crm.example.com');
  north constant uuid := '10000000-0000-4000-8000-000000000001';
  center constant uuid := '10000000-0000-4000-8000-000000000002';
  depot constant uuid := '10000000-0000-4000-8000-000000000003';
  task record;
begin
  if manager is null or worker1 is null or worker2 is null then
    raise exception 'Сначала создайте три тестовые учётные записи в Authentication → Users';
  end if;

  insert into public.profiles(id, full_name, role) values
    (manager, 'Марина Орлова', 'manager'),
    (worker1, 'Алексей Волков', 'worker'),
    (worker2, 'Ирина Белова', 'worker');

  insert into public.projects(id, name, address) values
    (north, 'ЖК Северный', 'Москва, ул. Берёзовая, 12'),
    (center, 'Деловой центр Маяк', 'Москва, ул. Набережная, 8'),
    (depot, 'Склад Восточный', 'Балашиха, ш. Энтузиастов, 45');

  for task in
    insert into public.tasks(project_id, title, description, assignee_id, author_id) values
      (north, 'Проверить ограждение площадки', 'Проверить крепления и проход у временных ворот.', worker1, manager),
      (north, 'Принять арматуру', 'Сверить объём поставки с накладной и сообщить о расхождениях.', worker2, manager),
      (center, 'Проверить отметки перекрытия', 'Сверить отметки второго этажа с рабочими чертежами.', worker1, manager),
      (center, 'Подготовить акт по электрике', 'Заполнить акт по результатам осмотра щитовой.', worker2, manager),
      (depot, 'Сверить схему движения техники', 'Проверить маршруты погрузчиков на площадке.', worker2, manager)
    returning id, title, assignee_id
  loop
    if task.title = 'Проверить ограждение площадки' then
      continue;
    end if;
    perform set_config('request.jwt.claim.sub', task.assignee_id::text, true);
    perform public.transition_task(task.id, 'in_progress');
    if task.title = 'Принять арматуру' then
      continue;
    end if;
    perform public.transition_task(task.id, 'review');
    perform set_config('request.jwt.claim.sub', manager::text, true);
    if task.title = 'Подготовить акт по электрике' then
      perform public.transition_task(task.id, 'revision', 'Добавьте дату осмотра и номер щита.');
    elsif task.title = 'Сверить схему движения техники' then
      perform public.transition_task(task.id, 'accepted');
    end if;
  end loop;
end;
$$;

commit;
