import assert from 'node:assert/strict'
import fs from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
const db = new PGlite()
const [manager, worker1, worker2, manager2] = Array.from({length:4}, (_,i) => '20000000-0000-4000-8000-00000000000' + (i+1))
await db.exec(`
create role anon;
create role authenticated;
create schema auth;
create table auth.users(id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as
\$\$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid \$\$;
grant usage on schema auth to authenticated;
insert into auth.users values
 ('${manager}','manager@crm.example.com'), ('${worker1}','worker1@crm.example.com'),
 ('${worker2}','worker2@crm.example.com'), ('${manager2}','manager2@crm.example.com');
`)
for (const file of fs.readdirSync('supabase/migrations').sort()) {
  await db.exec(fs.readFileSync('supabase/migrations/' + file, 'utf8'))
}
await db.exec(fs.readFileSync('supabase/demo.sql','utf8'))
await db.query("insert into public.profiles values ($1, 'Второй постановщик', 'manager')", [manager2])
const query = async (sql, args = []) => (await db.query(sql, args)).rows
const as = async (id) => {
  await db.exec('reset role')
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id ?? ''])
  await db.exec(id ? 'set role authenticated' : 'set role anon')
}
const all = await query('select * from tasks')
assert.equal(all.length, 5)
assert.equal(new Set(all.map(t => t.status)).size, 5)
const own = all.find(t => t.status === 'new')
const other = all.find(t => t.status === 'in_progress')
const review = all.find(t => t.status === 'review')
const transition = async (id, status, note = null, version) => {
  const expected = version ?? (await query('select status_version from tasks where id=$1', [id]))[0]?.status_version ?? 0
  return query('select transition_task($1,$2,$3,$4)', [id, status, expected, note])
}
const denied = (fn) => assert.rejects(fn, {code:'42501'})
await as(null)
await denied(() => query('select * from tasks'))
await denied(() => transition(own.id, 'in_progress', null, 0))
await as(worker1)
assert.equal((await query('select * from tasks')).length, 2)
assert.equal((await query('select * from projects')).length, 2)
assert.equal((await query('select * from task_history where task_id=$1', [other.id])).length, 0)
await denied(() => transition(other.id, 'review'))
await denied(() => transition(own.id, 'review'))
assert.equal((await query("update tasks set assignee_id=$2 where id=$1 returning id", [own.id, worker2])).length, 0)
assert.equal((await query("update projects set name='Fake' returning id")).length, 0)
await denied(() => query("update tasks set status='accepted' where id=$1", [own.id]))
await denied(() => query("insert into task_history(task_id,actor_id,to_status) values ($1,$2,'accepted')", [own.id, worker1]))
await denied(() => query("update task_history set comment='Fake'"))
await denied(() => query("delete from task_history"))
await denied(() => query("update profiles set role='manager' where id=$1", [worker1]))
await as(manager2)
assert.equal((await query('select * from tasks')).length, 5)
assert.equal((await query("update tasks set title='Fake' where id=$1 returning id", [own.id])).length, 0)
assert.equal((await query("delete from tasks where id=$1 returning id", [own.id])).length, 0)
await denied(() => transition(review.id, 'accepted'))
await as(manager)
await denied(() => query("insert into tasks(project_id,title,description,assignee_id,author_id) values ($1,'Fake','Fake',$2,$3)", [own.project_id,worker1,manager2]))
await assert.rejects(() => query("insert into tasks(project_id,title,description,assignee_id) values ($1,'Fake','Fake',$2)", [own.project_id,manager2]), {code:'23503'})
const [created] = await query("insert into tasks(project_id,title,description,assignee_id) values ($1,'Demo','Demo',$2) returning id,author_id,status", [own.project_id,worker1])
assert.equal(created.author_id, manager)
assert.equal(created.status, 'new')
assert.equal((await query("update tasks set title='Edited' where id=$1 returning id", [created.id])).length, 1)
await as(worker1)
await transition(created.id, 'in_progress')
await transition(created.id, 'review')
await as(manager)
assert.equal((await query("update tasks set title='Fake' where id=$1 returning id", [created.id])).length, 0)
await assert.rejects(() => transition(created.id, 'revision', '\n \t'), {code:'22023'})
const [firstReview] = await query('select status_version from tasks where id=$1', [created.id])
await transition(created.id, 'revision', ' Проверить размеры ')
await as(worker1)
await transition(created.id, 'in_progress')
await transition(created.id, 'review')
await as(manager)
await assert.rejects(() => transition(created.id, 'accepted', null, firstReview.status_version), { code: 'PT409' })
await transition(created.id, 'accepted')
await denied(() => transition(created.id, 'revision', 'repeat'))
const history = await query('select * from task_history where task_id=$1 order by id', [created.id])
assert.deepEqual(history.map(e => e.to_status), ['new','in_progress','review','revision','in_progress','review','accepted'])
assert.equal(history[3].comment, 'Проверить размеры')
assert.equal(history[3].actor_id, manager)
assert.equal(history[1].actor_id, worker1)
await query('delete from tasks where id=$1', [created.id])
await query('delete from projects where id=$1', [own.project_id])
await db.exec('reset role')
assert.equal((await query('select * from tasks where project_id=$1', [own.project_id])).length, 0)
assert.equal((await query('select * from task_history where task_id in ($1,$2,$3)', [created.id,own.id,other.id])).length, 0)
console.log('PASS: migration, demo, CRUD, role isolation, all transitions, audit protection, cascade deletes')
await db.close()
