const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'ImageSwap.user.js'), 'utf8');
const start = source.indexOf('  function validClock(');
const end = source.indexOf('  function targetsMayIntersect(', start);
assert.ok(start >= 0 && end > start, 'schedule functions must exist');
const context = { ALL_WEEKDAYS: [0, 1, 2, 3, 4, 5, 6] };
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);

const mondayNight = {
  enabled: true, timezone: 'utc', days: [1],
  start: '20:00', end: '06:00', from: '2026-10-12', until: '2026-10-12'
};

test('overnight schedule uses the starting weekday and date', () => {
  assert.equal(context.scheduleMatches(mondayNight, new Date('2026-10-13T02:00:00Z')), true);
  assert.equal(context.scheduleMatches(mondayNight, new Date('2026-10-12T19:59:00Z')), false);
  assert.equal(context.scheduleMatches(mondayNight, new Date('2026-10-13T06:00:00Z')), false);
  assert.equal(context.scheduleMatches(mondayNight, new Date('2026-10-14T02:00:00Z')), false);
});

test('overlap warning respects exclusive end time', () => {
  const nextMorning = { enabled: true, timezone: 'utc', days: [2], start: '06:00', end: '08:00' };
  assert.equal(context.scheduleMayIntersect(mondayNight, nextMorning).overlaps, false);
  assert.equal(context.scheduleMayIntersect(mondayNight, { ...nextMorning, start: '05:00' }).overlaps, true);
});
