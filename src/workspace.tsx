import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'

type Status = 'new' | 'in_progress' | 'review' | 'accepted' | 'revision'
type Profile = { id: string; full_name: string; role: 'manager' | 'worker' }
type Project = { id: string; name: string; address: string }
type Task = {
  id: string; project_id: string; title: string; description: string; assignee_id: string
  author_id: string; status: Status; created_at: string
}
type History = {
  id: number; task_id: string; actor_id: string; from_status: Status | null
  to_status: Status; comment: string | null; created_at: string
}
type Data = { me: Profile; profiles: Profile[]; projects: Project[]; tasks: Task[] }
type Editor = { type: 'project'; value?: Project } | { type: 'task'; value?: Task; projectId: string }
type Result<T> = { data: T[] | null; error: { message: string } | null }

const labels: Record<Status, string> = {
  new: 'Новая', in_progress: 'В работе', review: 'На проверке', accepted: 'Принята', revision: 'На доработке',
}
const date = new Intl.DateTimeFormat('ru', { dateStyle: 'medium', timeStyle: 'short' })
const taskColumns = 'id,project_id,title,description,assignee_id,author_id,status,created_at'

async function allRows<T>(read: (from: number, to: number) => PromiseLike<Result<T>>) {
  const rows: T[] = []
  const size = 200
  for (let from = 0; ; from += size) {
    const { data, error } = await read(from, from + size - 1)
    if (error) throw error
    rows.push(...(data ?? []))
    if (!data || data.length < size) return rows
  }
}

function readWorkspace(db: SupabaseClient, userId: string): Promise<Data> {
  return Promise.all([
    allRows<Profile>((from, to) => db.from('profiles').select('id,full_name,role').order('id').range(from, to)),
    allRows<Project>((from, to) => db.from('projects').select('id,name,address').order('name').order('id').range(from, to)),
    allRows<Task>((from, to) => db.from('tasks').select(taskColumns)
      .order('created_at', { ascending: false }).order('id').range(from, to)),
  ]).then(([profiles, projects, tasks]) => {
    const me = profiles.find(profile => profile.id === userId)
    if (!me) throw new Error('Для вашей учётной записи ещё не назначена роль. Обратитесь к администратору.')
    return { me, profiles, projects, tasks }
  })
}

function errorText(error: unknown) {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return 'Не удалось выполнить запрос.'
}

function Badge({ status }: { status: Status }) {
  return <span className={'badge ' + status}>{labels[status]}</span>
}

function TaskList({ tasks, detail }: { tasks: Task[]; detail: (task: Task) => string }) {
  if (!tasks.length) return <div className="empty">Здесь пока нет задач.</div>
  return <ul className="records">{tasks.map(task =>
    <li key={task.id}><a className="record" href={'#/task/' + task.id}>
      <span><strong>{task.title}</strong><small>{detail(task)}</small></span>
      <Badge status={task.status} />
    </a></li>,
  )}</ul>
}

export function Workspace({ db, userId }: { db: SupabaseClient; userId: string }) {
  const [route, setRoute] = useState(window.location.hash)
  const [data, setData] = useState<Data | null>(null)
  const [history, setHistory] = useState<History[] | null>(null)
  const [historyError, setHistoryError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [revision, setRevision] = useState(false)
  const [, page, id] = route.replace(/^#/, '').split('/')
  const taskId = page === 'task' ? id : undefined

  useEffect(() => {
    function navigate() {
      setRoute(window.location.hash)
      setEditor(null)
      setRevision(false)
      setError('')
      setHistory(null)
      setHistoryError('')
    }
    window.addEventListener('hashchange', navigate)
    return () => window.removeEventListener('hashchange', navigate)
  }, [])

  useEffect(() => {
    let current = true
    readWorkspace(db, userId).then(next => {
      if (current) setData(next)
    }).catch(error => {
      if (current) setError(errorText(error))
    })
    return () => { current = false }
  }, [db, userId, refresh])

  useEffect(() => {
    if (!taskId) return
    let current = true
    allRows<History>((from, to) => db.from('task_history')
      .select('id,task_id,actor_id,from_status,to_status,comment,created_at')
      .eq('task_id', taskId).order('id', { ascending: false }).range(from, to))
      .then(rows => { if (current) setHistory(rows) })
      .catch(error => { if (current) setHistoryError(errorText(error)) })
    return () => { current = false }
  }, [db, taskId, refresh])

  async function run(action: () => PromiseLike<{ error: unknown; data?: unknown }>, done?: () => void) {
    setBusy(true)
    setError('')
    try {
      const { error, data } = await action()
      if (error) throw error
      if (Array.isArray(data) && !data.length) throw new Error('Запись изменилась или больше недоступна.')
      done?.()
    } catch (error) {
      setError(errorText(error))
    } finally {
      setRefresh(value => value + 1)
      setBusy(false)
    }
  }

  const manager = data?.me.role === 'manager'
  const workers = data?.profiles.filter(profile => profile.role === 'worker') ?? []
  const project = data?.projects.find(project => project.id === id)
  const task = data?.tasks.find(task => task.id === taskId)
  const taskProject = data?.projects.find(project => project.id === task?.project_id)
  const name = (personId: string) => data?.profiles.find(profile => profile.id === personId)?.full_name ?? 'Пользователь'
  const projectName = (projectId: string) => data?.projects.find(project => project.id === projectId)?.name ?? 'Объект'

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editor) return
    const fields = new FormData(event.currentTarget)
    const field = (name: string) => String(fields.get(name) ?? '').trim()
    if (editor.type === 'project') {
      const payload = { name: field('name'), address: field('address') }
      const record = editor.value
      void run(() => (record ? db.from('projects').update(payload).eq('id', record.id)
        : db.from('projects').insert(payload)).select('id'), () => setEditor(null))
    } else {
      const payload = {
        title: field('title'), description: field('description'),
        project_id: field('project_id'), assignee_id: field('assignee_id'),
      }
      const record = editor.value
      void run(() => (record ? db.from('tasks').update(payload).eq('id', record.id)
        : db.from('tasks').insert(payload)).select('id'), () => setEditor(null))
    }
  }

  function transition(task: Task, status: Status, comment?: string) {
    void run(() => db.rpc('transition_task', { p_task_id: task.id, p_to: status, p_comment: comment }),
      () => setRevision(false))
  }

  let screen: ReactNode = <p role="status">Загружаем рабочее пространство…</p>
  if (!data && error) screen = <button onClick={() => { setError(''); setRefresh(value => value + 1) }}>Повторить загрузку</button>

  if (data && editor) {
    const projectForm = editor.type === 'project' ? editor : null
    const taskForm = editor.type === 'task' ? editor : null
    screen = <section className="panel form-panel">
      <h1>{editor.value ? 'Редактирование' : editor.type === 'project' ? 'Новый объект' : 'Новая задача'}</h1>
      <form onSubmit={save}>
        {projectForm && <>
          <label>Название<input name="name" defaultValue={projectForm.value?.name} maxLength={160} required /></label>
          <label>Адрес<input name="address" defaultValue={projectForm.value?.address} maxLength={300} required /></label>
        </>}
        {taskForm && <>
          <label>Название<input name="title" defaultValue={taskForm.value?.title} maxLength={160} required /></label>
          <label>Описание<textarea name="description" defaultValue={taskForm.value?.description} maxLength={5000} required /></label>
          <label>Объект<select name="project_id" defaultValue={taskForm.projectId} required>
            {data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select></label>
          <label>Исполнитель<select name="assignee_id" defaultValue={taskForm.value?.assignee_id ?? ''} required>
            <option value="" disabled>Выберите исполнителя</option>
            {workers.map(worker => <option key={worker.id} value={worker.id}>{worker.full_name}</option>)}
          </select></label>
        </>}
        <div className="actions">
          <button className="primary" disabled={busy}>Сохранить</button>
          <button type="button" disabled={busy} onClick={() => { setEditor(null); setError('') }}>Отмена</button>
        </div>
      </form>
    </section>
  } else if (data && page === 'project' && project) {
    screen = <>
      <a className="back" href="#/projects">← Все объекты</a>
      <header className="page-head">
        <div><h1>{project.name}</h1><p className="muted">{project.address}</p></div>
        {manager && <div className="actions">
          <button disabled={busy} onClick={() => setEditor({ type: 'project', value: project })}>Редактировать</button>
          <button className="danger" disabled={busy} onClick={() => {
            if (confirm('Удалить объект, все его задачи и их историю?'))
              void run(() => db.from('projects').delete().eq('id', project.id).select('id'),
                () => { window.location.hash = '/projects' })
          }}>Удалить</button>
        </div>}
      </header>
      <section className="panel">
        <div className="section-head"><h2>Задачи объекта</h2>
          {manager && <button className="primary" disabled={busy || !workers.length}
            onClick={() => setEditor({ type: 'task', projectId: project.id })}>+ Новая задача</button>}
        </div>
        {manager && !workers.length && <p className="muted">Для назначения задачи добавьте профиль исполнителя в Supabase.</p>}
        <TaskList tasks={data.tasks.filter(task => task.project_id === project.id)} detail={task => name(task.assignee_id)} />
      </section>
    </>
  } else if (data && page === 'task' && task) {
    const own = manager && task.author_id === userId
    const assigned = !manager && task.assignee_id === userId
    const canStart = assigned && (task.status === 'new' || task.status === 'revision')
    const canReview = assigned && task.status === 'in_progress'
    const canDecide = own && task.status === 'review'
    screen = <>
      <a className="back" href={'#/project/' + task.project_id}>← {taskProject?.name ?? 'Объект'}</a>
      <section className="panel task-card">
        <div className="section-head"><h1>{task.title}</h1><Badge status={task.status} /></div>
        <p className="description">{task.description}</p>
        <dl className="facts">
          <div><dt>Исполнитель</dt><dd>{name(task.assignee_id)}</dd></div>
          <div><dt>Постановщик</dt><dd>{name(task.author_id)}</dd></div>
          <div><dt>Создана</dt><dd>{date.format(new Date(task.created_at))}</dd></div>
        </dl>
        {(own || canStart || canReview) && <div className="actions">
          {canStart && <button className="primary" disabled={busy} onClick={() => transition(task, 'in_progress')}>Взять в работу</button>}
          {canReview && <button className="primary" disabled={busy} onClick={() => transition(task, 'review')}>Отправить на проверку</button>}
          {canDecide && <>
            <button className="primary" disabled={busy} onClick={() => transition(task, 'accepted')}>Принять</button>
            <button disabled={busy || revision} onClick={() => setRevision(true)}>Вернуть на доработку</button>
          </>}
          {own && task.status === 'new' && <button disabled={busy}
            onClick={() => setEditor({ type: 'task', value: task, projectId: task.project_id })}>Редактировать</button>}
          {own && <button className="danger" disabled={busy} onClick={() => {
            if (confirm('Удалить задачу и её историю?'))
              void run(() => db.from('tasks').delete().eq('id', task.id).select('id'),
                () => { window.location.hash = '/project/' + task.project_id })
          }}>Удалить</button>}
        </div>}
        {revision && canDecide && <form className="revision-form" onSubmit={event => {
          event.preventDefault()
          const note = String(new FormData(event.currentTarget).get('note') ?? '').trim()
          if (!note) { setError('Укажите причину возврата.'); return }
          transition(task, 'revision', note)
        }}>
          <label>Причина возврата<textarea name="note" maxLength={2000} required autoFocus /></label>
          <div className="actions">
            <button className="primary" disabled={busy}>Подтвердить возврат</button>
            <button type="button" disabled={busy} onClick={() => { setRevision(false); setError('') }}>Отмена</button>
          </div>
        </form>}
      </section>
      <section className="panel">
        <h2>История статусов</h2>
        {historyError ? <p className="error" role="alert">{historyError}</p>
          : history === null ? <p role="status">Загружаем историю…</p>
          : !history.length ? <p className="muted">История пуста.</p>
          : <ol className="timeline">{history.map(entry => <li key={entry.id}>
            <strong>{entry.from_status ? labels[entry.from_status] + ' → ' : 'Создание · '}{labels[entry.to_status]}</strong>
            <small>{name(entry.actor_id)} · {date.format(new Date(entry.created_at))}</small>
            {entry.comment && <p className="description">{entry.comment}</p>}
          </li>)}</ol>}
      </section>
    </>
  } else if (data && page === 'mine' && !manager) {
    screen = <><header className="page-head"><h1>Мои задачи</h1></header>
      <section className="panel"><TaskList tasks={data.tasks} detail={task => projectName(task.project_id)} /></section></>
  } else if (data && (page === 'task' || page === 'project')) {
    screen = <section className="panel"><h1>Запись недоступна</h1><a href="#/projects">К списку объектов</a></section>
  } else if (data) {
    screen = <>
      <header className="page-head"><div><h1>Объекты</h1><p className="muted">Строительные площадки и задачи по ним</p></div>
        {manager && <button className="primary" disabled={busy} onClick={() => setEditor({ type: 'project' })}>+ Новый объект</button>}
      </header>
      {data.projects.length ? <ul className="project-grid">{data.projects.map(project =>
        <li key={project.id}><a className="panel project-tile" href={'#/project/' + project.id}>
          <span className="tile-mark" aria-hidden="true">▤</span><strong>{project.name}</strong><span className="muted">{project.address}</span>
          <small>Задач: {data.tasks.filter(task => task.project_id === project.id).length}</small>
        </a></li>,
      )}</ul> : <div className="panel empty">Доступных объектов пока нет.</div>}
    </>
  }

  return <>
    <header className="top">
      <div className="top-inner">
        <a className="brand" href="#/projects"><span className="mark">СК</span> СтройКонтур</a>
        <nav aria-label="Разделы">
          <a href="#/projects" aria-current={page !== 'mine' ? 'page' : undefined}>Объекты</a>
          {data && !manager && <a href="#/mine" aria-current={page === 'mine' ? 'page' : undefined}>Мои задачи</a>}
        </nav>
        <div className="identity">
          {data && <span><strong>{data.me.full_name}</strong><small>{manager ? 'Постановщик' : 'Исполнитель'}</small></span>}
          <button disabled={busy} onClick={() => void run(() => db.auth.signOut())}>Выйти</button>
        </div>
      </div>
    </header>
    <main className="shell" aria-busy={busy}>
      {error && <p className="error" role="alert">{error}</p>}
      {screen}
    </main>
  </>
}
