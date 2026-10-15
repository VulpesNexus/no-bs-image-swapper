const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'ImageSwap.user.js'), 'utf8');
const header = source.slice(0, source.indexOf('// ==/UserScript=='));

test('script identity stays compatible with versions 1.1.0 through 1.4.0', () => {
  assert.match(header, /^\/\/ @name\s+Image Swap$/m);
  assert.match(header, /^\/\/ @namespace\s+https:\/\/example\.invalid\/image-swap$/m);
});
