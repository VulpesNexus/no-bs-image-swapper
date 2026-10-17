const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'No-BS-Image-Swapper.user.js'), 'utf8');
const start = source.indexOf('  function candidatesFromSrcset(');
const end = source.indexOf('  function imageURLs(', start);
assert.ok(start >= 0 && end > start, 'srcset parser must exist');
const context = {};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);
const candidates = value => Array.from(context.candidatesFromSrcset(value));

test('CDN commas remain inside each image URL', () => {
  assert.deepEqual(candidates('https://cdn.example/w_100,h_100/photo.png 1x, ' +
    'https://cdn.example/w_200,h_200/photo.png 2x'), [
    'https://cdn.example/w_100,h_100/photo.png',
    'https://cdn.example/w_200,h_200/photo.png'
  ]);
});

test('data URL commas and later candidates are both retained', () => {
  assert.deepEqual(candidates('data:image/png;base64,AAAA 1x, https://cdn.example/large.png 2x'), [
    'data:image/png;base64,AAAA', 'https://cdn.example/large.png'
  ]);
});

test('trailing candidate commas and descriptor spacing are handled', () => {
  assert.deepEqual(candidates(' https://cdn.example/a.png,  https://cdn.example/b.png 2x,'), [
    'https://cdn.example/a.png', 'https://cdn.example/b.png'
  ]);
});
