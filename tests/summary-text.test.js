const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'ImageSwap.user.js'), 'utf8');
const slice = (from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, from + ' must exist');
  return source.slice(start, end);
};
const context = { ALL_WEEKDAYS: [0, 1, 2, 3, 4, 5, 6] };
vm.createContext(context);
vm.runInContext(slice('  function bytesText(', '  const XLINK_NS'), context);
vm.runInContext(slice('  function ruleLabel(', '  function numericSetting('), context);
vm.runInContext(slice('  function validClock(', '  // This is deliberately conservative'), context);

test('clock text uses 12-hour time with AM and PM', () => {
  assert.equal(context.clockText('00:00'), '12:00 AM');
  assert.equal(context.clockText('00:05'), '12:05 AM');
  assert.equal(context.clockText('09:30'), '9:30 AM');
  assert.equal(context.clockText('12:00'), '12:00 PM');
  assert.equal(context.clockText('17:00'), '5:00 PM');
  assert.equal(context.clockText('23:59'), '11:59 PM');
});

test('schedule summary keeps hours, time zone, days, and dates', () => {
  const base = { enabled: true, start: '17:00', end: '05:00', timezone: 'utc', days: [0, 1, 2, 3, 4, 5, 6] };
  assert.equal(context.scheduleText(base), '5:00 PM–5:00 AM (UTC)');
  assert.equal(context.scheduleText({ ...base, timezone: 'local' }), '5:00 PM–5:00 AM (local time)');
  assert.equal(context.scheduleText({ ...base, start: '08:00', end: '08:00' }), 'All day (UTC)');
  assert.equal(context.scheduleText({ ...base, days: [0, 1, 5] }), '5:00 PM–5:00 AM (UTC) · Mon, Fri, Sun');
  assert.equal(context.scheduleText({ ...base, days: [] }), '5:00 PM–5:00 AM (UTC) · No days');
  assert.equal(context.scheduleText({ ...base, from: '2026-10-12', until: '2026-10-19' }),
    '5:00 PM–5:00 AM (UTC) · 2026-10-12 to 2026-10-19');
  assert.equal(context.scheduleText({ ...base, until: '2026-10-19' }), '5:00 PM–5:00 AM (UTC) · Until 2026-10-19');
});

test('unnamed URL rules show a file name instead of the full URL', () => {
  const rule = { name: '', mode: 'url', selector: '' };
  assert.equal(context.ruleTitle({ ...rule, pattern: 'https://cdn.example/a/b/logo%20big.png?v=1#x' }), 'logo big.png');
  assert.equal(context.ruleTitle({ ...rule, pattern: 'https://*.cdn.example/img/*.webp' }), '*.webp');
  assert.equal(context.ruleTitle({ ...rule, pattern: 'https://cdn.example/' }), 'Image');
  assert.equal(context.ruleTitle({ ...rule, pattern: 'https://cdn.example?variant=large' }), 'Image');
  assert.equal(context.ruleTitle({ ...rule, pattern: 'data:image/png;base64,AAAA' }), 'Embedded image (image/png)');
  assert.equal(context.ruleTitle({ ...rule, pattern: 'https://cdn.example/%E0%A4%A.png' }), '%E0%A4%A.png');
  assert.equal(context.ruleTitle({ ...rule, name: ' Logo ', pattern: 'https://cdn.example/x.png' }), 'Logo');
  assert.equal(context.ruleTitle({ ...rule, mode: 'selector', selector: '#logo' }), '#logo');
});

test('upload caps print without a trailing .0', () => {
  assert.equal(context.bytesText(10 * 1024 * 1024), '10 MiB');
  assert.equal(context.bytesText(1.5 * 1024 * 1024), '1.5 MiB');
  assert.equal(context.bytesText(2048), '2 KiB');
});
