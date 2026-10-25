const test = require('node:test');
const assert = require('node:assert');
const S = require('../schedule');
const D = require('../dates');

// Real IRON MAN hours. weekday: 0 = Sunday ... 6 = Saturday
const hours = [];
for (const wd of [0, 1, 2, 3, 6]) hours.push({ category: 'iron', weekday: wd, open: '15:30', close: '06:00' });
hours.push({ category: 'iron', weekday: 4, open: '15:30', close: '01:00' });
hours.push({ category: 'iron', weekday: 5, open: '18:00', close: '21:00' });
for (const wd of [0, 2, 4]) hours.push({ category: 'kickboxing', weekday: wd, open: '19:30', close: '21:00' });
const data = { hours, closures: [] };
const t = (s) => new Date(s.replace(' ', 'T'));

// 2026-10-17 is a Saturday
test('gym day rolls over at 6 AM', () => {
  assert.equal(D.gymDay(t('2026-10-17 05:59')), '2026-10-16');
  assert.equal(D.gymDay(t('2026-10-17 06:00')), '2026-10-17');
});

test('iron overnight window', () => {
  assert.ok(S.current(data, 'iron', t('2026-10-17 16:00')));
  assert.ok(S.current(data, 'iron', t('2026-10-18 03:00')), 'Saturday night 3 AM still open');
  assert.equal(S.current(data, 'iron', t('2026-10-18 07:00')), null);
  assert.equal(S.current(data, 'iron', t('2026-10-17 15:00')), null);
});

test('Thursday closes at 1 AM, Friday 6-9 PM', () => {
  assert.ok(S.current(data, 'iron', t('2026-10-23 00:30')), 'Thursday night 00:30');
  assert.equal(S.current(data, 'iron', t('2026-10-23 01:30')), null);
  assert.equal(S.current(data, 'iron', t('2026-10-23 16:00')), null, 'Friday 4 PM closed');
  assert.ok(S.current(data, 'iron', t('2026-10-23 18:30')));
  assert.equal(S.current(data, 'iron', t('2026-10-23 21:00')), null);
});

test('kickboxing class allows 30 min early entry, only on class days', () => {
  assert.ok(S.current(data, 'kickboxing', t('2026-10-18 19:00')), 'Sunday 7:00');
  assert.equal(S.current(data, 'kickboxing', t('2026-10-18 18:59')), null);
  assert.equal(S.current(data, 'kickboxing', t('2026-10-18 21:00')), null);
  assert.equal(S.current(data, 'kickboxing', t('2026-10-19 19:30')), null, 'Monday has no class');
});

test('closures and changed hours', () => {
  const d2 = { hours, closures: [{ day: '2026-10-18', category: null, closed: 1, note: 'صيانة' }, { day: '2026-10-20', category: 'kickboxing', closed: 0, open: '20:00', close: '21:30' }] };
  assert.equal(S.current(d2, 'iron', t('2026-10-18 16:00')), null);
  assert.equal(S.current(d2, 'kickboxing', t('2026-10-18 19:45')), null);
  assert.equal(S.current(d2, 'kickboxing', t('2026-10-20 19:20')), null, 'moved class: 7:20 too early');
  assert.ok(S.current(d2, 'kickboxing', t('2026-10-20 21:15')));
  assert.ok(S.current(d2, 'iron', t('2026-10-20 16:00')), 'kickboxing change does not touch iron');
});

test('labels in both languages', () => {
  const { msg } = require('../i18n');
  const ar = (c, at) => msg('ar', S.label(data, c, t(at)).text), en = (c, at) => msg('en', S.label(data, c, t(at)).text);
  assert.equal(ar('iron', '2026-10-17 16:00'), 'مفتوح الآن، يغلق 6 ص');
  assert.equal(ar('iron', '2026-10-17 10:00'), 'مغلق، يفتح اليوم 3:30 م');
  assert.equal(ar('kickboxing', '2026-10-23 22:00'), 'مغلق، الحصة القادمة يوم الأحد 7:30 م', 'Friday night: next class is Sunday');
  assert.equal(en('kickboxing', '2026-10-23 22:00'), 'Closed, next class Sunday 7:30 PM');
  assert.equal(ar('kickboxing', '2026-10-17 10:00'), 'مغلق، الحصة القادمة غداً 7:30 م');
  assert.equal(en('iron', '2026-10-17 16:00'), 'Open now, closes 6 AM');
  assert.equal(en('kickboxing', '2026-10-17 10:00'), 'Closed, next class tomorrow 7:30 PM');
  assert.equal(en('iron', '2026-10-23 16:00'), 'Closed, opens today 6 PM', 'Friday');
});
