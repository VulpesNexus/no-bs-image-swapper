const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'ImageSwap.user.js'), 'utf8');
const start = source.indexOf('  // * is the only wildcard.');
const end = source.indexOf('  // querySelector() does not accept pseudo-elements', start);
assert.ok(start >= 0 && end > start, 'URL pattern functions must exist');
const context = { URL, document: { baseURI: 'https://page.example/articles/' } };
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);

test('wildcard in a URL hostname survives normalization', () => {
  const pattern = context.normalizedPattern('https://*.cdn.example/logo.png');
  assert.equal(pattern, 'https://*.cdn.example/logo.png');
  const regex = context.globRegex(pattern);
  assert.equal(regex.test(context.normalizedURL('https://eu.cdn.example/logo.png')), true);
  assert.equal(regex.test(context.normalizedURL('https://eu.other.example/logo.png')), false);
});

test('wildcards in paths and relative patterns still resolve', () => {
  assert.equal(context.normalizedPattern('https://cdn.example/*.png'), 'https://cdn.example/*.png');
  assert.equal(context.normalizedPattern('images/*.png'), 'https://page.example/articles/images/*.png');
});
