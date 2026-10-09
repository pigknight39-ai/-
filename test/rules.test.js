const { test } = require('node:test');
const assert = require('node:assert/strict');
const { entitlement } = require('../rules');

test('台灣特休年資級距', () => {
  const cases = [
    ['2024-06-30', 0],
    ['2024-07-01', 3],
    ['2025-01-01', 7],
    ['2026-01-01', 10],
    ['2027-01-01', 14],
    ['2029-01-01', 15],
    ['2034-01-01', 16],
    ['2048-01-01', 30]
  ];

  for (const [date, days] of cases) {
    assert.equal(entitlement('2024-01-01', date), days);
  }
});

test('閏年、月底到職與未到職日期', () => {
  assert.equal(entitlement('2024-02-29', '2025-02-28'), 7);
  assert.equal(entitlement('2024-08-31', '2025-02-27'), 0);
  assert.equal(entitlement('2024-08-31', '2025-02-28'), 3);
  assert.equal(entitlement('2027-01-01', '2026-01-01'), 0);
});
