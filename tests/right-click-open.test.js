const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'No-BS-Image-Swapper.user.js'), 'utf8');
const start = source.indexOf('  function openRuleForTarget(');
const end = source.indexOf('  // A menu command receives only', start);
assert.ok(start >= 0 && end > start, 'right-click rule opener exists');

function open(target, existing) {
  const calls = [];
  const context = {
    pickerActive: false,
    location: { hostname: 'example.com' },
    isImageNode: () => true,
    ruleForTarget: () => existing,
    originalImageURL: () => 'https://example.com/original.png',
    uniqueSelector: () => '#picture',
    openPanel: () => calls.push('panel'),
    showEditor: (rule, suggested) => calls.push({ rule, suggested })
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  context.openRuleForTarget(target);
  return calls;
}

test('right-clicking an active replacement edits its saved rule', () => {
  const target = { id: 'picture' };
  const rule = { id: 'saved-rule', selector: '#picture' };
  const calls = open(target, rule);
  assert.equal(calls[0], 'panel');
  assert.equal(calls[1].rule, rule);
  assert.equal(calls[1].suggested.targetElement, target);
  assert.equal(calls[1].suggested.targetKind, 'image');
});

test('right-clicking an unmodified image proposes a new rule', () => {
  const target = { id: 'picture' };
  const calls = open(target, null);
  assert.equal(calls[0], 'panel');
  assert.equal(calls[1].rule, null);
  assert.equal(calls[1].suggested.pattern, 'https://example.com/original.png');
  assert.equal(calls[1].suggested.targetElement, target);
});
