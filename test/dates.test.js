const test = require('node:test');
const assert = require('node:assert');
const d = require('../dates');

test('addMonths clamps to month end', () => {
  assert.equal(d.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(d.addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(d.addMonths('2026-11-30', 3), '2027-02-28');
  assert.equal(d.addMonths('2026-10-17', 1), '2026-11-17');
});

test('endDate is inclusive', () => {
  assert.equal(d.endDate('2026-10-17', 1), '2026-11-16');
  assert.equal(d.endDate('2026-12-01', 3), '2027-02-28');
});

test('renewalStart keeps remaining days', () => {
  assert.equal(d.renewalStart('2026-10-20', '2026-10-17'), '2026-10-21');
  assert.equal(d.renewalStart('2026-10-17', '2026-10-17'), '2026-10-18');
  assert.equal(d.renewalStart('2026-10-01', '2026-10-17'), '2026-10-17');
  assert.equal(d.renewalStart(null, '2026-10-17'), '2026-10-17');
});

test('status', () => {
  const now = '2026-10-17';
  assert.equal(d.status(undefined, now), 'none');
  assert.equal(d.status({ start_date: '2026-09-01', end_date: '2026-10-16' }, now), 'expired');
  assert.equal(d.status({ start_date: '2026-10-01', end_date: '2026-10-17' }, now), 'expiring');
  assert.equal(d.status({ start_date: '2026-10-01', end_date: '2026-10-24' }, now), 'expiring');
  assert.equal(d.status({ start_date: '2026-10-01', end_date: '2026-10-25' }, now), 'active');
  assert.equal(d.status({ start_date: '2026-10-18', end_date: '2026-11-17' }, now), 'upcoming');
});
