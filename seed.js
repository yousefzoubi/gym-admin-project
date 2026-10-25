// Demo data. Run: npm run seed   (add --force to wipe existing data)
const { db, hashPassword, tx } = require('./db');
const D = require('./dates');
const P = require('./programs');

if (db.prepare('SELECT 1 FROM members LIMIT 1').get() && !process.argv.includes('--force')) {
  console.log('Database already has members. Use "npm run seed -- --force" to wipe and reseed.');
  process.exit(1);
}

// Demo logins only. Change these passwords from the staff page before real use.
const STAFF = [
  ['مدير تجريبي', 'admin', 'ironman-admin', 'admin'],
  ['استقبال تجريبي 1', 'reception1', 'ironman-desk', 'reception'],
  ['استقبال تجريبي 2', 'reception2', 'ironman-desk', 'reception'],
  ['مدرب تجريبي 1', 'trainer1', 'ironman-coach', 'trainer'],
  ['مدرب تجريبي 2', 'trainer2', 'ironman-coach', 'trainer'],
  ['مدرب تجريبي 3', 'trainer3', 'ironman-coach', 'trainer'],
  ['عامل نظافة تجريبي', 'cleaner', 'ironman-clean', 'cleaner'],
];
// staff fingerprints on the same device as members (members use 101+)
const STAFF_FP = { reception1: 901, reception2: 902, cleaner: 900 };
const DEMO_MEMBER = { phone: '0790000001', password: 'ironman-member' };
const OTP_MEMBER = { phone: '0790000002', national_id: '9990000002', birth_date: '2000-01-15' };

const NAMES = Array.from({ length: 28 }, (_, i) => `عضو تجريبي ${String(i + 1).padStart(2, '0')}`);

const PRODUCTS = [
  ['واي بروتين 2 كغ', 'supplement', 45, 32, 8, '2027-06-01'], ['كرياتين 300 غ', 'supplement', 18, 11, 2, '2026-11-10'],
  ['BCAA', 'supplement', 22, 14, 6, '2027-03-01'], ['بري وركاوت', 'supplement', 25, 16, 5, '2027-01-15'],
  ['شيكر', 'accessory', 4, 1.5, 20, null], ['قفازات تمرين', 'accessory', 8, 4, 10, null], ['حزام ظهر', 'accessory', 15, 8, 3, null],
  ['قفازات بوكسينج', 'accessory', 20, 12, 6, null], ['ماء 500 مل', 'drink', 0.35, 0.15, 48, null], ['مشروب طاقة', 'drink', 1.25, 0.7, 24, null],
];

let seed = 7;
const rand = (n) => { seed = (seed * 16807) % 2147483647; return seed % n; }; // deterministic demo
const t = D.today();
const hm = (h, m) => `${D.pad(h)}:${D.pad(m)}:00`;

tx(() => {
  for (const table of ['cleaning_done', 'staff_shifts', 'notifications', 'otps', 'sale_items', 'sales', 'products', 'workout_sets', 'daily_logs', 'inbody', 'attendance', 'payments', 'subscriptions', 'members', 'users', 'closures']) db.exec(`DELETE FROM ${table}`);
  const addUser = db.prepare('INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, ?, ?)');
  const ids = STAFF.map(([name, u, pw, role]) => Number(addUser.run(name, u, hashPassword(pw), role).lastInsertRowid));
  const desk = ids[1];
  const trainerIds = ids.slice(3, 6);
  const cleanerId = ids[6];
  STAFF.forEach(([, u], k) => { if (STAFF_FP[u]) db.prepare('UPDATE users SET fingerprint_id = ? WHERE id = ?').run(STAFF_FP[u], ids[k]); });
  const plans = db.prepare('SELECT * FROM plans WHERE active = 1').all();

  const addMember = db.prepare(`INSERT INTO members (name, phone, national_id, birth_date, notes, trainer_id, password_hash, fingerprint_id,
    goal_type, goal_weight, goal_pbf, goal_date, target_days, kcal, protein, carbs, fat, water, created_at) VALUES (${Array(19).fill('?').join(', ')})`);
  const addSub = db.prepare('INSERT INTO subscriptions (member_id, plan_name, category, start_date, end_date, price, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const addPay = db.prepare('INSERT INTO payments (member_id, amount, note, paid_at, created_by) VALUES (?, ?, ?, ?, ?)');
  const addVisit = db.prepare('INSERT OR IGNORE INTO attendance (member_id, category, gym_day, checked_at, checked_out_at, created_by) VALUES (?, ?, ?, ?, ?, ?)');
  // in at "day h:m", out after mins (null = still inside)
  const visit = (id, cat, day, h, m, mins) => {
    const inAt = new Date(`${D.addDays(day, Math.floor(h / 24))}T${D.pad(h % 24)}:${D.pad(m)}:00`);
    const out = mins == null ? null : D.stamp(new Date(inAt.getTime() + mins * 60000));
    if (out && new Date(out.replace(' ', 'T')) > new Date()) return addVisit.run(id, cat, day, D.stamp(inAt), null, null);
    addVisit.run(id, cat, day, D.stamp(inAt), out, null);
  };
  const addInbody = db.prepare('INSERT INTO inbody (member_id, day, weight, smm, bfm, pbf, bmi, visceral, bmr, tbw, score, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const addLog = db.prepare('INSERT OR IGNORE INTO daily_logs (member_id, day, nutrition, water, weight) VALUES (?, ?, ?, ?, ?)');
  const addSet = db.prepare('INSERT INTO workout_sets (member_id, day, exercise, set_no, weight, reps, is_pr) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const templates = db.prepare('SELECT id FROM templates ORDER BY id').all().map((x) => x.id);
  // starting weight per exercise: stable per name, heavier for legs
  const baseWeight = (ex, muscle) => { let h = 0; for (const ch of ex) h = (h * 31 + ch.charCodeAt(0)) % 997; return (/رجلين|Legs/.test(muscle) ? 40 : 10) + (h % 9) * 5; };
  const OLD_PROGRAM ='السبت: صدر + تراي\nبنش بريس 4×10، تفتيح دامبل 3×12، ديبس 3×10\n\nالاثنين: ظهر + باي\nسحب أمامي 4×10، بار رو 4×8، باي بار 3×12\n\nالأربعاء: أرجل + أكتاف\nسكوات 5×5، ليغ بريس 4×12، شولدر بريس 4×10';

  NAMES.forEach((name, i) => {
    const start = D.addDays(t, -(20 + rand(120)));
    const coached = i % 3 === 0;
    const trainer = coached ? trainerIds[(i / 3) % trainerIds.length] : null;
    const phone = i < 2 ? [DEMO_MEMBER.phone, OTP_MEMBER.phone][i] : `07${7 + (i % 3)}${String(1000000 + i * 271828).slice(-7)}`;
    const nid = i === 1 ? OTP_MEMBER.national_id : String(9900000000 + i * 1234567).slice(0, 10);
    const weight = 70 + rand(35);
    const id = Number(addMember.run(name, phone, nid, i === 1 ? OTP_MEMBER.birth_date : `${1985 + rand(20)}-${D.pad(1 + rand(12))}-${D.pad(1 + rand(28))}`,
      i % 7 === 0 ? 'إصابة قديمة بالركبة' : '', trainer,
      i === 0 ? hashPassword(DEMO_MEMBER.password) : null, i === NAMES.length - 1 ? null : 101 + i,
      coached ? (i % 2 ? 'muscle' : 'fat_loss') : '', coached ? weight + (i % 2 ? 4 : -8) : null, coached ? 15 : null, coached ? D.addDays(t, 90) : null,
      4, coached ? 2200 : null, coached ? 160 : null, coached ? 220 : null, coached ? 70 : null, coached ? 3 : null, start).lastInsertRowid);

    const cats = i % 4 === 0 ? ['iron', 'kickboxing'] : [i % 5 === 0 ? 'kickboxing' : 'iron'];
    for (const cat of cats) {
      const ps = plans.filter((p) => p.category === cat);
      let s = start;
      while (s <= t) {
        const p = ps[rand(ps.length)];
        const end = D.endDate(s, p.months);
        addSub.run(id, p.name, cat, s, end, p.price, desk);
        addPay.run(id, rand(6) === 0 ? p.price - 10 : p.price, p.name, s, desk); // some members still owe money
        s = D.addDays(end, 1);
        if (i % 6 === 5 && rand(2) === 0) break; // some members stopped renewing
      }
    }

    // Coached members (and the demo member) get a template from the gym's Excel tables
    const hasProgram = coached || i < 3;
    if (hasProgram) P.assign(id, templates[i % templates.length]);
    const days = hasProgram ? P.load({ memberId: id }) : [];

    // Visits that respect the real hours: iron evenings/nights, kickboxing class days at 7:20 PM
    const best = {};
    let session = 0;
    for (let d = 45; d >= 0; d--) {
      const day = D.addDays(t, -d);
      if (day < start) continue;
      const wd = D.parse(day).getDay();
      const nowH = new Date().getHours() + (new Date().getHours() < 6 ? 24 : 0);
      if (cats.includes('iron') && rand(10) < 4) {
        let h = wd === 5 ? 18 + rand(2) : 16 + rand(9);
        if (d === 0) { if (nowH <= 16) continue; h = 16 + rand(nowH - 16); }
        visit(id, 'iron', day, h, rand(60), 45 + rand(60));
        // trained and logged: weight per set, reps only on the last set; weights creep up over time
        if (days.length && d > 0) {
          const pd = days[session++ % days.length];
          for (const e of pd.exercises) {
            const top = Math.round((baseWeight(e.exercise, e.muscle) + (45 - d) * 0.2 + rand(3) * 2.5) / 2.5) * 2.5;
            const ws = Array.from({ length: e.sets }, (_, k) => Math.max(2.5, top - (e.sets - 1 - k) * 5));
            ws.forEach((w, k) => {
              const pr = best[e.exercise] != null && w > best[e.exercise];
              if (best[e.exercise] == null || w > best[e.exercise]) best[e.exercise] = w;
              addSet.run(id, day, e.exercise, k + 1, w, k === ws.length - 1 ? 6 + rand(6) : null, pr ? 1 : 0);
            });
          }
          db.prepare('UPDATE members SET last_day_no = ? WHERE id = ?').run(pd.day_no, id);
        }
      }
      if (cats.includes('kickboxing') && [0, 2, 4].includes(wd) && rand(10) < 7) visit(id, 'kickboxing', day, 19, 10 + rand(25), 95 + rand(20));
      if (coached && d > 0 && rand(10) < 6) addLog.run(id, day, ['yes', 'yes', 'partial', 'no'][rand(4)], 4 + rand(8), d % 7 === 0 ? weight - (45 - d) * 0.05 : null);
    }

    if (coached || i < 3) {
      for (let k = 3; k >= 0; k--) {
        const w = Math.round((weight + k * (i % 2 ? -0.6 : 1.1)) * 10) / 10;
        const pbf = Math.round((24 - i % 5 + k * 1.2) * 10) / 10;
        addInbody.run(id, D.addDays(t, -k * 30 - 3), w, Math.round((w * 0.45 - k * 0.3) * 10) / 10, Math.round(w * pbf) / 100, pbf,
          Math.round(w / 3.1 * 10) / 10, 6 + (k > 1 ? 2 : 0), 1600 + rand(300), Math.round(w * 0.55 * 10) / 10, 70 + (3 - k) * 2, trainer || desk);
      }
    }
  });

  const addProduct = db.prepare('INSERT INTO products (name, type, price, cost, stock, expiry_date) VALUES (?, ?, ?, ?, ?, ?)');
  const pids = PRODUCTS.map((p) => Number(addProduct.run(...p).lastInsertRowid));
  const addSale = db.prepare('INSERT INTO sales (member_id, total, method, gym_day, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const addItem = db.prepare('INSERT INTO sale_items (sale_id, product_id, name, qty, price, cost) VALUES (?, ?, ?, ?, ?, ?)');
  for (let k = 0; k < 40; k++) {
    const p = PRODUCTS[rand(PRODUCTS.length)];
    const qty = 1 + rand(2);
    const day = D.addDays(t, -rand(30));
    const member = rand(3) ? 1 + rand(NAMES.length) : null;
    const method = member && rand(4) === 0 ? 'account' : 'cash';
    const sid = Number(addSale.run(member, p[2] * qty, method, day, desk, `${day} ${hm(17 + rand(5), rand(60))}`).lastInsertRowid);
    addItem.run(sid, pids[PRODUCTS.indexOf(p)], p[0], qty, p[2], p[3]);
  }

  // Cleaner: a shift most days 2 PM → 10 PM, and the checklist mostly done
  const tasks = db.prepare('SELECT id FROM cleaning_tasks WHERE active = 1').all();
  for (let d = 14; d >= 0; d--) {
    const day = D.addDays(t, -d);
    if (d && rand(7) === 0) continue; // day off
    const start = `${day} ${hm(14, rand(20))}`;
    const end = d ? `${day} ${hm(22, rand(30))}` : null;
    db.prepare('INSERT INTO staff_shifts (user_id, clock_in, clock_out) VALUES (?, ?, ?)').run(cleanerId, start, end);
    tasks.forEach((task, k) => {
      if (d === 0 ? k < 3 : rand(10) < 9) db.prepare('INSERT INTO cleaning_done (task_id, day, done_at, user_id) VALUES (?, ?, ?, ?)').run(task.id, day, `${day} ${hm(15 + k, rand(60))}`, cleanerId);
    });
  }

  db.prepare('INSERT INTO closures (day, category, closed, note) VALUES (?, ?, 1, ?)').run(D.addDays(t, 6), 'kickboxing', 'المدرّب مسافر للمشاركة في بطولة');
});

require('./notify').run(new Date(new Date().setHours(19, 0, 0, 0)));

console.log('Seeded. Logins (username or phone / password):');
for (const [, u, pw, role] of STAFF) console.log(`  ${role.padEnd(10)} ${u} / ${pw}`);
console.log(`  member     ${DEMO_MEMBER.phone} / ${DEMO_MEMBER.password}`);
console.log(`  new member phone ${OTP_MEMBER.phone}, national ID ${OTP_MEMBER.national_id}, born ${OTP_MEMBER.birth_date} on /activate`);
