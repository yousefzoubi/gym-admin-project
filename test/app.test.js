// End-to-end: real server on a throwaway database.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-'));
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.DEMO = '1';
const { db, hashPassword } = require('../db');
const app = require('../app');
const D = require('../dates');
const C = require('../core');
const N = require('../notify');

// Hours that are always open, so check-in tests don't depend on the clock.
db.exec('DELETE FROM hours');
for (const c of ['iron', 'kickboxing']) for (let wd = 0; wd < 7; wd++) db.prepare("INSERT INTO hours VALUES (?, ?, '06:00', '06:00')").run(c, wd);
// 06:00 → 06:00 is a zero-length window by the "close <= open means next day" rule: 24h open. Check:
assert.ok(require('../schedule').current(require('../db').scheduleData(), 'iron', new Date()));

const add = db.prepare('INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, ?, ?)');
add.run('Admin', 'a', hashPassword('pass-admin'), 'admin');
add.run('Desk', 'r', hashPassword('pass-desk'), 'reception');
const coachId = Number(add.run('Coach', 't', hashPassword('pass-coach'), 'trainer').lastInsertRowid);

let base, server;
test.before(() => new Promise((ok) => { server = app.listen(0, () => { base = `http://localhost:${server.address().port}`; ok(); }); }));
test.after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// Like a real form: arrays become repeated fields (weight=70&weight=75...)
const params = (form) => new URLSearchParams(Object.entries(form).flatMap(([k, v]) => [].concat(v).map((x) => [k, x])));
const jar = (cookie) => Object.assign((url, form) => fetch(base + url, {
  method: form ? 'POST' : 'GET', redirect: 'manual', headers: { cookie }, body: form && params(form),
}), { cookie });
async function login(username, password) {
  const r = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ username, password }) });
  assert.equal(r.status, 302, `login ${username}`);
  return jar(r.headers.get('set-cookie').split(';')[0]);
}
const html = (r) => r.text();
const one = (sql, ...a) => db.prepare(sql).get(...a);
const member = { name: 'Test <b>Member</b>', phone: '0791234567', national_id: '9876543210', birth_date: '1998-04-02' };

test('login rejects bad password and guards pages', async () => {
  const r = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ username: 'a', password: 'nope' }) });
  assert.equal(r.status, 401);
  assert.equal((await fetch(`${base}/members`, { redirect: 'manual' })).headers.get('location'), '/login');
  assert.equal((await fetch(`${base}/me`, { redirect: 'manual' })).headers.get('location'), '/login');
});

test('staff flow, uniqueness, check-in per section, roles', async () => {
  const admin = await login('a', 'pass-admin');
  const desk = await login('r', 'pass-desk');
  const coach = await login('t', 'pass-coach');

  const iron = one("SELECT id FROM plans WHERE category = 'iron' AND months = 1").id;
  let r = await desk('/members', { ...member, trainer_id: coachId, plan_iron: iron, paid_iron: '20' });
  assert.equal(r.status, 302);
  const id = Number(r.headers.get('location').split('/').pop());
  const page = await html(await desk(`/members/${id}`));
  assert.ok(page.includes('Test &lt;b&gt;Member&lt;/b&gt;'), 'name is escaped');
  assert.ok(page.includes('10 د.أ'), 'balance is 10');
  assert.ok(page.includes('9876543210'), 'reception sees national id');

  // same national id or phone can't register twice (Excel-style phone without 0 too)
  assert.equal((await desk('/members', { ...member, phone: '0799999999' })).status, 400);
  assert.equal((await desk('/members', { ...member, national_id: '1111111111', phone: '791234567' })).status, 400);
  assert.equal((await desk('/members', { ...member, national_id: '123', phone: '0798888888' })).status, 400);

  // early renewal starts after the current one ends
  await desk(`/members/${id}/subscriptions`, { plan_id: iron, paid: '30' });
  const subs = db.prepare('SELECT * FROM subscriptions WHERE member_id = ? ORDER BY start_date').all(id);
  assert.equal(subs[1].start_date, D.addDays(subs[0].end_date, 1));

  // fingerprint only: no fingerprint → denied; 1st punch = in, 2nd = out with duration, 3rd = done for today
  await desk(`/punch/${id}`, {});
  assert.ok((await html(await desk('/checkin'))).includes('لا توجد له بصمة'));
  await desk(`/members/${id}`, { ...member, trainer_id: coachId, fingerprint_id: '55' });
  assert.equal(one('SELECT fingerprint_id FROM members WHERE id = ?', id).fingerprint_id, 55);
  await desk(`/punch/${id}`, {});
  assert.ok((await html(await desk('/checkin'))).includes('result ok'));
  assert.ok(C.openVisit(id), 'timer running');
  await desk(`/punch/${id}`, {});
  assert.ok((await html(await desk('/checkin'))).includes('result out'));
  const v = one('SELECT * FROM attendance WHERE member_id = ?', id);
  assert.ok(v.checked_out_at >= v.checked_at);
  assert.equal(v.gym_day, D.today());
  // iron: can come back the same day as many times as they like
  await desk(`/punch/${id}`, {});
  assert.ok((await html(await desk('/checkin'))).includes('الدخول رقم 2 اليوم'));
  await desk(`/punch/${id}`, {});
  assert.equal(one('SELECT COUNT(*) AS n FROM attendance WHERE member_id = ? AND checked_out_at IS NOT NULL', id).n, 2);
  assert.ok((await html(await desk('/dashboard'))).includes('حديد 1 ·'), 'dashboard counts people, not visits');

  // kickboxing: one class a day
  const kb = one("SELECT id FROM plans WHERE category = 'kickboxing' AND months = 1").id;
  r = await desk('/members', { name: 'Boxer', phone: '0796660000', national_id: '6660000000', birth_date: '2001-01-01', fingerprint_id: '66', plan_kickboxing: kb });
  const boxer = Number(r.headers.get('location').split('/').pop());
  await desk(`/punch/${boxer}`, {}); await desk(`/punch/${boxer}`, {}); await desk(`/punch/${boxer}`, {});
  assert.ok((await html(await desk('/checkin'))).includes('result warn'));
  assert.equal(one('SELECT COUNT(*) AS n FROM attendance WHERE member_id = ?', boxer).n, 1);
  for (const gone of ['/checkin/scan', '/device/punch', `/checkin/${id}`]) assert.equal((await desk(gone, {})).status, 404, gone);
  // a POST with no body at all (Express 5 leaves req.body undefined) must not crash
  const bare = await fetch(`${base}/punch/${id}`, { method: 'POST', redirect: 'manual', headers: { cookie: desk.cookie } });
  assert.equal(bare.status, 302);

  // reception: no revenue, no admin pages, no deletes
  assert.ok(!(await html(await desk('/dashboard'))).includes('اشتراكات هذا الشهر'));
  assert.ok((await html(await admin('/dashboard'))).includes('اشتراكات هذا الشهر'));
  for (const url of ['/payments', '/plans', '/users', '/schedule', '/import', '/shop/products']) assert.equal((await desk(url)).status, 403, url);
  assert.equal((await desk(`/members/${id}/delete`, {})).status, 403);

  // trainer: own members only, no national id, writes program/goals/InBody, no money
  const cpage = await html(await coach(`/members/${id}`));
  assert.ok(!cpage.includes('9876543210'), 'trainer does not see national id');
  assert.equal((await coach('/members')).status, 403);
  assert.equal((await coach(`/members/${id}/payments`, { amount: '5' })).status, 403);
  await coach(`/members/${id}/goals`, { goal_type: 'fat_loss', goal_weight: '80', kcal: '2000', target_days: '5' });
  await coach(`/members/${id}/inbody`, { weight: '90', pbf: '22.5', smm: '38' });
  const m = one('SELECT goal_type, kcal, target_days FROM members WHERE id = ?', id);
  assert.deepEqual({ ...m }, { goal_type: 'fat_loss', kcal: 2000, target_days: 5 });
  assert.equal(one('SELECT weight FROM inbody WHERE member_id = ?', id).weight, 90);
  assert.ok(one("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE '%متدرّب جديد%'", coachId), 'trainer told about new trainee');

  // invalid input
  await desk(`/members/${id}/payments`, { amount: '-5' });
  assert.equal(one('SELECT COUNT(*) AS n FROM payments WHERE amount < 0').n, 0);
});

test('shop: stock, account sales add to balance, cancel restocks', async () => {
  const admin = await login('a', 'pass-admin');
  const desk = await login('r', 'pass-desk');
  await admin('/shop/products', { name: 'Whey', type: 'supplement', price: '45', cost: '30', stock: '2' });
  const p = one("SELECT * FROM products WHERE name = 'Whey'");
  const id = one('SELECT id FROM members LIMIT 1').id;
  const before = one(`SELECT ${C.balanceSql} AS b FROM members m WHERE id = ?`, id).b;

  await desk('/shop/sell', { [`qty_${p.id}`]: '3', method: 'cash' });
  assert.equal(one('SELECT stock FROM products WHERE id = ?', p.id).stock, 2, 'cannot oversell');
  await desk('/shop/sell', { [`qty_${p.id}`]: '1', method: 'account' });
  assert.equal(one('SELECT COUNT(*) AS n FROM sales').n, 0, 'account sale needs a member');

  await desk('/shop/sell', { [`qty_${p.id}`]: '2', method: 'account', member: `${id} - x` });
  assert.equal(one('SELECT stock FROM products WHERE id = ?', p.id).stock, 0);
  assert.equal(one(`SELECT ${C.balanceSql} AS b FROM members m WHERE id = ?`, id).b, before + 90);

  const sale = one('SELECT id FROM sales');
  assert.equal((await desk(`/shop/sales/${sale.id}/delete`, {})).status, 403);
  await admin(`/shop/sales/${sale.id}/delete`, {});
  assert.equal(one('SELECT stock FROM products WHERE id = ?', p.id).stock, 2);
});

const post = (url, form, opts = {}) => fetch(base + url, { method: 'POST', body: new URLSearchParams(form), ...opts });
const codeIn = async (r) => (await r.text()).match(/الرمز: <b class="num"[^>]*>([0-9]{6})</)[1];

test('member: activation with ID + birth date, phone-only reset, own data only', async () => {
  const id = one('SELECT id FROM members WHERE phone = ?', member.phone).id;
  const reg = { phone: member.phone, national_id: member.national_id, birth_date: member.birth_date };
  assert.equal((await post('/activate', { ...reg, birth_date: '1998-04-03' })).status, 400, 'wrong birth date');
  assert.equal((await post('/activate', { ...reg, national_id: '0000000000' })).status, 400, 'wrong national id');
  let code = await codeIn(await post('/activate', reg));
  const wrong = code === '111111' ? '222222' : '111111';
  assert.equal((await post('/activate/verify', { phone: member.phone, mode: 'new', code: wrong, password: 'member-pass', password2: 'member-pass' })).status, 400);
  let r = await post('/activate/verify', { phone: member.phone, mode: 'new', code, password: 'member-pass', password2: 'member-pass' }, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(one('SELECT COUNT(*) AS n FROM otps').n, 0, 'code is single use');

  // already activated: /activate refuses, /forgot needs only the phone
  assert.equal((await post('/activate', reg)).status, 400);
  db.prepare('DELETE FROM otps').run();
  code = await codeIn(await post('/forgot', { phone: member.phone }));
  r = await post('/activate/verify', { phone: member.phone, mode: 'forgot', code, password: 'member-pass2', password2: 'member-pass2' }, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.ok(!(await (await post('/forgot', { phone: '0790009999' })).text()).includes('الرمز:'), 'unknown phone gets no code');

  const me = await login(member.phone, 'member-pass2');
  assert.ok((await html(await me('/me'))).includes('اشتراك حديد'));
  // phone keyboards: Arabic-Indic digits in the phone, a trailing space after an autofilled password
  const arabicDigits = member.phone.replace(/[0-9]/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]);
  await login(arabicDigits, 'member-pass2 ');
  // invisible direction mark in the phone field, a look-alike dash in the password (keyboards on an RTL page)
  const LRM = String.fromCharCode(0x200e), DASH = String.fromCharCode(0x2010);
  await login(LRM + member.phone, 'member' + DASH + 'pass2');
  // a mangled password is a second chance only: a genuinely wrong one still fails
  const bad = await fetch(base + '/login', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ username: member.phone, password: 'member-pass3' }) });
  assert.equal(bad.status, 401);
  // activation page accepts the national ID in Arabic-Indic digits too (checked before activation is refused as already done)
  const arabicNid = member.national_id.replace(/[0-9]/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]);
  const act = await (await post('/activate', { phone: member.phone, national_id: arabicNid, birth_date: member.birth_date })).text();
  assert.ok(act.includes('حسابك مفعّل مسبقاً'), 'found the member from Arabic digits');
  assert.equal((await me('/me/progress')).status, 200);
  for (const url of ['/dashboard', '/members', `/members/${id}`, '/checkin', '/shop']) assert.equal((await me(url)).status, 403, url);
  assert.equal((await me('/me/qr')).status, 404);

  // demo button in the member app = fingerprint
  db.prepare('UPDATE attendance SET checked_out_at = checked_at WHERE member_id = ? AND checked_out_at IS NULL').run(id); // earlier tests left one open
  const before = one('SELECT COUNT(*) AS n FROM attendance WHERE member_id = ?', id).n;
  await me('/me/punch', {});
  assert.ok(C.openVisit(id), 'member started their own timer');
  assert.ok((await html(await me('/me'))).includes('data-since'));
  await me('/me/punch', {});
  assert.ok(!C.openVisit(id));
  assert.equal(one('SELECT COUNT(*) AS n FROM attendance WHERE member_id = ?', id).n, before + 1);

  await me('/me/log', { nutrition: 'yes', water: '8', weight: '89.5' });
  assert.deepEqual({ ...one('SELECT nutrition, water, weight FROM daily_logs WHERE member_id = ?', id) }, { nutrition: 'yes', water: 8, weight: 89.5 });
});

test('templates from Excel; assign on registration; both sides edit the member copy', async () => {
  const admin = await login('a', 'pass-admin');
  const desk = await login('r', 'pass-desk');
  const coach = await login('t', 'pass-coach');
  assert.equal(one('SELECT COUNT(*) AS n FROM templates').n, 8, 'the 8 Excel tables');
  const ppl = one("SELECT id FROM templates WHERE name LIKE 'PPL - 3%'").id;
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM program_days WHERE template_id = ?').get(ppl).n, 3);
  for (const who of [admin, desk, coach]) assert.equal((await who('/templates')).status, 200);

  // reception registers a member with a template → member gets their own copy
  let r = await desk('/members', { name: 'Program Member', phone: '0795550000', national_id: '5550000000', birth_date: '1995-05-05', trainer_id: coachId, template_id: ppl });
  const mid = Number(r.headers.get('location').split('/').pop());
  const days = db.prepare('SELECT * FROM program_days WHERE member_id = ? ORDER BY day_no').all(mid);
  assert.equal(days.length, 3);
  const push = days[0];
  const tplFirst = one('SELECT e.exercise FROM program_exercises e JOIN program_days d ON d.id = e.day_id WHERE d.template_id = ? AND d.day_no = 1 ORDER BY e.sort', ppl).exercise;

  // trainer edits the member's day: the template stays as it was
  await coach(`/program-days/${push.id}`, { title: 'PUSH', note: '', exercise: ['Incline press', ''], muscle: ['Chest', ''], sets: ['4', '3'], reps: ['6-8', '8-12'] });
  assert.deepEqual(db.prepare('SELECT exercise, sets, reps FROM program_exercises WHERE day_id = ?').all(push.id).map((x) => ({ ...x })), [{ exercise: 'Incline press', sets: 4, reps: '6-8' }]);
  assert.equal(one('SELECT e.exercise FROM program_exercises e JOIN program_days d ON d.id = e.day_id WHERE d.template_id = ? AND d.day_no = 1 ORDER BY e.sort', ppl).exercise, tplFirst);
  assert.ok(one("SELECT 1 FROM notifications WHERE member_id = ? AND title LIKE '%عدّل المدرّب جدولك%'", mid), 'member told');

  // reception can assign but not edit days; another member can't touch it
  assert.equal((await desk(`/program-days/${push.id}`, { exercise: ['x'] })).status, 403);
  const other = await login(member.phone, 'member-pass2');
  assert.equal((await other(`/program-days/${push.id}`, { exercise: ['x'] })).status, 403);
  assert.equal((await other(`/members/${mid}/program`)).status, 403);

  // the member edits their own copy and the trainer is told
  db.prepare("UPDATE members SET password_hash = (SELECT password_hash FROM members WHERE phone = ?) WHERE id = ?").run(member.phone, mid);
  const pm = await login('0795550000', 'member-pass2');
  assert.ok((await html(await pm('/me/program'))).includes('Incline press'));
  await pm(`/program-days/${push.id}`, { title: 'PUSH', exercise: ['Incline press', 'Dips'], muscle: ['Chest', 'Triceps'], sets: ['4', '3'], reps: ['6-8', '10'] });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM program_exercises WHERE day_id = ?').get(push.id).n, 2);
  assert.ok(one("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE '%جدوله (اليوم%'", coachId), 'trainer told');

  // workout page shows today's program day with the right number of set inputs
  const page = await html(await pm('/me/workout?day=1'));
  assert.ok(page.includes('Incline press') && page.includes('Dips'));
  assert.equal((page.match(/name="weight"/g) || []).length, 4 + 3 + 4, '4 + 3 sets, plus the optional extra form');
  await pm('/me/workout', { exercise: 'Incline press', day_no: '1', weight: ['40', '45', '50', '50'], reps: '8' });
  assert.equal(one('SELECT COUNT(*) AS n FROM workout_sets WHERE member_id = ? AND exercise = ?', mid, 'Incline press').n, 4, 'name kept intact (no lost letters)');
  assert.equal(one('SELECT last_day_no FROM members WHERE id = ?', mid).last_day_no, 1);
  assert.ok((await html(await pm('/me/workout'))).includes('1/2 مكتمل'), 'stays on the day being trained');

  // swapping templates replaces the copy
  const arnold = one("SELECT id FROM templates WHERE name = 'أرنولد سبليت'").id;
  await coach(`/members/${mid}/assign`, { template_id: arnold });
  assert.equal(one('SELECT COUNT(*) AS n FROM program_days WHERE member_id = ?', mid).n, 5);
  assert.equal(one('SELECT template_id FROM members WHERE id = ?', mid).template_id, arnold);
});

test('workout: weight per set, reps on last set only, PR celebration', async () => {
  const id = one('SELECT id FROM members WHERE phone = ?', member.phone).id;
  const me = await login(member.phone, 'member-pass2');
  // a previous session
  db.prepare("INSERT INTO workout_sets (member_id, day, exercise, set_no, weight, reps) VALUES (?, ?, 'Bench', 1, 70, NULL), (?, ?, 'Bench', 2, 80, 6)").run(id, D.addDays(D.today(), -3), id, D.addDays(D.today(), -3));

  // an exercise outside the program ("extra"), compared against its own history
  let page;
  await me('/me/workout', { exercise: 'Bench', weight: ['70', '75', '80', '80'], reps: '9' });
  const sets = db.prepare("SELECT set_no, weight, reps, is_pr FROM workout_sets WHERE member_id = ? AND day = ? ORDER BY set_no").all(id, D.today()).map((x) => ({ ...x }));
  assert.deepEqual(sets, [
    { set_no: 1, weight: 70, reps: null, is_pr: 0 }, { set_no: 2, weight: 75, reps: null, is_pr: 0 },
    { set_no: 3, weight: 80, reps: null, is_pr: 0 }, { set_no: 4, weight: 80, reps: 9, is_pr: 0 },
  ]);
  assert.ok((await html(await me('/me/workout'))).includes('تكرارات أكثر من المرة السابقة'));

  await me('/me/workout', { exercise: 'Bench', weight: ['85', '85', '90'], reps: '4' });
  page = await html(await me('/me/workout'));
  assert.ok(page.includes('وزن جديد'), 'PR celebrated');
  assert.equal(one("SELECT COUNT(*) AS n FROM workout_sets WHERE member_id = ? AND is_pr = 1", id).n, 2, '85 and 90 beat the old best');
  assert.ok(page.includes('🔥'));

  assert.equal((await me('/me/workout', { exercise: 'Bench', weight: ['80'], reps: '0' })).status, 302);
  assert.equal(one("SELECT COUNT(*) AS n FROM workout_sets WHERE member_id = ? AND day = ?", id, D.today()).n, 7, 'reps required on last set');
  assert.equal(C.adherence(id).workouts, 2);
  await me('/me/workout/delete', { exercise: 'Bench' });
  assert.equal(one("SELECT COUNT(*) AS n FROM workout_sets WHERE member_id = ? AND day = ?", id, D.today()).n, 0);
});

test('cleaner: tasks, shift by fingerprint, access', async () => {
  add.run('Cleaner', 'c', hashPassword('pass-clean'), 'cleaner');
  const cid = one("SELECT id FROM users WHERE username = 'c'").id;
  const admin = await login('a', 'pass-admin');
  const desk = await login('r', 'pass-desk');
  const cleaner = await login('c', 'pass-clean');

  // fingerprint numbers are shared with members: 55 is taken by the test member
  await admin(`/users/${cid}/fingerprint`, { fingerprint_id: '55' });
  assert.equal(one('SELECT fingerprint_id FROM users WHERE id = ?', cid).fingerprint_id, null);
  await admin(`/users/${cid}/fingerprint`, { fingerprint_id: '900' });
  assert.equal(one('SELECT fingerprint_id FROM users WHERE id = ?', cid).fingerprint_id, 900);

  await desk(`/punch-staff/${cid}`, {});
  assert.ok(C.openShift(cid), 'shift started');
  assert.ok((await html(await cleaner('/clean'))).includes('data-since'), 'cleaner sees shift timer');
  await desk(`/punch-staff/${cid}`, {});
  assert.ok(one('SELECT clock_out FROM staff_shifts WHERE user_id = ?', cid).clock_out, 'shift ended');

  const tasks = db.prepare('SELECT id FROM cleaning_tasks WHERE active = 1').all();
  for (const x of tasks) await cleaner(`/clean/${x.id}`, {});
  assert.equal(one('SELECT COUNT(*) AS n FROM cleaning_done WHERE day = ?', D.today()).n, tasks.length);
  assert.ok(one("SELECT 1 FROM notifications WHERE dedupe_key LIKE 'clean:%'"), 'admin told when all done');
  await cleaner(`/clean/${tasks[0].id}`, {});
  assert.equal(one('SELECT COUNT(*) AS n FROM cleaning_done WHERE day = ?', D.today()).n, tasks.length - 1, 'tap again to undo');

  assert.equal((await cleaner('/clean/tasks', { name: 'x' })).status, 403, 'only admin edits tasks');
  for (const url of ['/dashboard', '/members', '/checkin', '/shop', '/me']) assert.equal((await cleaner(url)).status, 403, url);
  assert.equal((await desk('/clean')).status, 403);
  assert.equal((await cleaner('/')).headers.get('location'), '/clean');
});

test('reminders are created once', () => {
  const id = one('SELECT id FROM members WHERE phone = ?', member.phone).id;
  db.prepare('DELETE FROM subscriptions WHERE member_id = ? AND id NOT IN (SELECT MIN(id) FROM subscriptions WHERE member_id = ?)').run(id, id);
  db.prepare("UPDATE subscriptions SET end_date = date(?, '+3 days') WHERE member_id = ?").run(D.today(), id);
  const noon = new Date(); noon.setHours(13, 0, 0, 0);
  N.run(noon); N.run(noon);
  assert.equal(one("SELECT COUNT(*) AS n FROM notifications WHERE member_id = ? AND dedupe_key LIKE 'exp3:%'", id).n, 1);
});

test('adherence score', () => {
  assert.equal(C.scoreWeek({ visits: 4, workouts: 4, nutrition: Array(7).fill('yes'), targetDays: 4 }).score, 100);
  assert.equal(C.scoreWeek({ visits: 2, workouts: 0, nutrition: ['partial', 'partial'], targetDays: 4 }).score, 24);
  assert.equal(C.scoreWeek({ visits: 9, workouts: 9, nutrition: [], targetDays: 4 }).score, 70);
});

test('CSV import parser', () => {
  const { parseCsv } = require('../routes/staff');
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
});

test('English: every page renders with no missing translations or leftover placeholders', async () => {
  const I = require('../i18n');
  I.missing.clear();
  add.run('Cleaner EN', 'c2', hashPassword('pass-clean'), 'cleaner');
  const en = async (username, password) => {
    const r = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { cookie: 'lang=en' }, body: new URLSearchParams({ username, password }) });
    const cookie = `${r.headers.get('set-cookie').split(';')[0]}; lang=en`;
    return (url) => fetch(base + url, { headers: { cookie } });
  };
  const member1 = one('SELECT id FROM members ORDER BY id LIMIT 1').id;
  const tpl = one('SELECT id FROM templates ORDER BY id LIMIT 1').id;
  const pages = {
    a: ['/dashboard', '/checkin', '/checkin?q=a', '/members', '/members/new', `/members/${member1}`, `/members/${member1}/edit`, `/members/${member1}/program`, '/templates', `/templates/${tpl}`,
      '/shop', '/shop/products', '/payments', '/schedule', '/plans', '/clean', '/users', '/import', '/notifications', '/nope'],
    r: ['/dashboard', '/checkin', '/members'],
    t: ['/trainer', '/templates'],
    c2: ['/clean'],
  };
  const pw = { a: 'pass-admin', r: 'pass-desk', t: 'pass-coach', c2: 'pass-clean' };
  const check = async (get, url) => {
    const r = await get(url);
    const body = (await r.text()).replace(/<script[\s\S]*?<\/script>/g, '');
    assert.ok([200, 404].includes(r.status), `${url} → ${r.status}`);
    assert.ok(body.includes('lang="en" dir="ltr"'), `${url} is LTR English`);
    assert.ok(!/\{[a-z]+\}/.test(body), `${url} has an unfilled {placeholder}`);
    assert.ok(!body.includes('[object'), `${url} printed an object`);
  };
  for (const [u, urls] of Object.entries(pages)) { const get = await en(u, pw[u]); for (const url of urls) await check(get, url); }
  const me = await en(member.phone, 'member-pass2');
  for (const url of ['/me', '/me/workout', '/me/progress', '/me/program', '/me/shop', '/me/notifications', '/me/account']) await check(me, url);
  for (const url of ['/login', '/activate', '/forgot']) await check((x) => fetch(base + x, { headers: { cookie: 'lang=en' } }), url);
  assert.deepEqual([...I.missing], [], 'Arabic keys with no English');
  // and the switch itself
  const sw = await fetch(`${base}/lang/en`, { redirect: 'manual' });
  assert.match(sw.headers.get('set-cookie'), /lang=en/);
});

test('cross-site POST is rejected', async () => {
  const r = await fetch(`${base}/login`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: new URLSearchParams({ username: 'a', password: 'pass-admin' }) });
  assert.equal(r.status, 403);
});
