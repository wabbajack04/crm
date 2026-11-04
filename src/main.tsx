import { StrictMode, useEffect, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { createClient, type Session } from '@supabase/supabase-js'
import { Workspace } from './workspace'
import './style.css'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
const db = url && key ? createClient(url, key) : null

function App() {
  const [session, setSession] = useState<Session | null | undefined>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!db) return
    const { data } = db.auth.onAuthStateChange((_, next) => setSession(next))
    return () => data.subscription.unsubscribe()
  }, [])

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!db) return
    const form = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    try {
      const { error } = await db.auth.signInWithPassword({
        email: String(form.get('email')).trim(),
        password: String(form.get('password')),
      })
      if (error) setError(error.code === 'invalid_credentials' ? 'Проверьте email и пароль.' : error.message)
    } catch {
      setError('Не удалось подключиться. Попробуйте ещё раз.')
    } finally {
      setBusy(false)
    }
  }

  if (db && session) return <Workspace key={session.user.id} db={db} userId={session.user.id} />

  return <main className="login">
    <section className="login-card">
      <div className="brand"><span className="mark">СК</span> СтройКонтур</div>
      <h1>Объекты и задачи</h1>
      {!db ? <p role="alert">Укажите адрес проекта и публичный ключ Supabase по инструкции в README.</p>
        : session === undefined ? <p role="status">Проверяем сеанс…</p>
        : <form onSubmit={signIn}>
          <p className="muted">Войдите в рабочее пространство.</p>
          <label>Email<input name="email" type="email" autoComplete="username" required /></label>
          <label>Пароль<input name="password" type="password" autoComplete="current-password" required /></label>
          {error && <p role="alert" className="error">{error}</p>}
          <button className="primary" disabled={busy}>{busy ? 'Входим…' : 'Войти'}</button>
        </form>}
    </section>
  </main>
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
