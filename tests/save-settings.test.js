const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'ImageSwap.user.js'), 'utf8');
const start = source.indexOf('  function saveSettings() {');
const end = source.indexOf('\n  function newId()', start);
assert.ok(start >= 0 && end > start, 'saveSettings function must exist');
const saveSource = source.slice(start, end);

function harness(write) {
  const calls = [];
  const saved = { enabled: true, rules: [] };
  const context = {
    STORAGE_KEY: 'test-settings', settings: { enabled: false, rules: [] },
    GM_setValue: write,
    loadSettings: () => saved,
    alert: message => calls.push(['alert', message]),
    refreshRules: () => calls.push(['refresh']),
    armScheduleTimer: () => calls.push(['timer']),
    requestFullScan: () => calls.push(['scan']),
    render: () => calls.push(['render'])
  };
  vm.createContext(context);
  vm.runInContext(saveSource, context);
  return { context, calls, saved };
}

test('successful storage write reports success and refreshes the page', () => {
  let stored;
  const { context, calls } = harness((key, value) => { stored = [key, value]; });
  assert.equal(context.saveSettings(), true);
  assert.equal(stored[0], 'test-settings');
  assert.equal(JSON.parse(stored[1]).enabled, false);
  assert.deepEqual(calls.map(call => call[0]), ['refresh', 'timer', 'scan', 'render']);
});

test('failed storage write restores persisted settings and reports failure', () => {
  const { context, calls, saved } = harness(() => { throw new Error('quota exceeded'); });
  assert.equal(context.saveSettings(), false);
  assert.equal(context.settings, saved);
  assert.match(calls[0][1], /quota exceeded/);
  assert.deepEqual(calls.map(call => call[0]), ['alert', 'refresh', 'scan', 'render']);
});
