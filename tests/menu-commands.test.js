const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'ImageSwap.user.js'), 'utf8');
const start = source.indexOf('  const MENU_COMMANDS = [');
const end = source.indexOf('  let dragState = null;', start);
assert.ok(start >= 0 && end > start, 'menu command code must exist');
const ORDER = ['New rule from right-clicked image', 'Pick an image', 'Manage local images',
  'Manage image replacements', 'Toggle image replacements', 'Toggle floating button'];

// The manager's menu, in display order. Like Tampermonkey, ids differ from labels.
function harness({ unregister = true } = {}) {
  const menu = [];
  const log = [];
  let nextId = 1;
  const context = {
    console, target: null,
    pickContextTarget() {}, startPicker() {}, openPanel() {}, saveSettings() {}, $: () => ({}),
    settings: {},
    currentContextTarget: () => context.target,
    GM_registerMenuCommand(label, callback, options) {
      const id = 'cmd-' + nextId++;
      menu.push({ id, label, options });
      log.push('+' + label);
      return id;
    }
  };
  if (unregister) {
    context.GM_unregisterMenuCommand = id => {
      const index = menu.findIndex(item => item.id === id);
      assert.ok(index >= 0, 'unregisters a registered id');
      log.push('-' + menu[index].label);
      menu.splice(index, 1);
    };
  }
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return { context, labels: () => menu.map(item => item.label), menu, log };
}

test('without a right-clicked target the command is not listed', () => {
  const { context, labels } = harness();
  context.syncMenuCommands();
  assert.deepEqual(labels(), ORDER.slice(1));
});

test('a valid target lists the command first, then removing it keeps the order', () => {
  const { context, labels, menu } = harness();
  context.syncMenuCommands();
  context.target = {};
  context.syncMenuCommands();
  assert.deepEqual(labels(), ORDER);
  assert.match(menu[0].options.title, /last right-clicked/);
  context.target = null;
  context.syncMenuCommands();
  assert.deepEqual(labels(), ORDER.slice(1));
  context.target = {};
  context.syncMenuCommands();
  assert.deepEqual(labels(), ORDER);
});

test('the menu changes only when the target state flips', () => {
  const { context, log } = harness();
  context.syncMenuCommands();
  context.target = {};
  context.syncMenuCommands();
  const count = log.length;
  context.syncMenuCommands();
  context.syncMenuCommands();
  assert.equal(log.length, count);
  context.target = null;
  context.syncMenuCommands();
  assert.deepEqual(log.slice(count), ['-New rule from right-clicked image']);
});

test('without GM_unregisterMenuCommand every command stays listed in order', () => {
  const { context, labels, log } = harness({ unregister: false });
  context.syncMenuCommands();
  context.target = {};
  context.syncMenuCommands();
  context.target = null;
  context.syncMenuCommands();
  assert.deepEqual(labels(), ORDER);
  assert.equal(log.length, ORDER.length);
});
