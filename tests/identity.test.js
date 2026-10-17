const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'No-BS-Image-Swapper.user.js'), 'utf8');
const header = source.slice(0, source.indexOf('// ==/UserScript=='));

test('published metadata names the product and its actual repository', () => {
  assert.match(header, /^\/\/ @name\s+No-BS Image Swapper$/m);
  assert.match(header, /^\/\/ @namespace\s+https:\/\/github\.com\/VulpesNexus\/no-bs-image-swapper$/m);
  assert.match(header, /^\/\/ @homepageURL\s+https:\/\/github\.com\/VulpesNexus\/no-bs-image-swapper$/m);
  const rawScript = 'https://raw.githubusercontent.com/VulpesNexus/no-bs-image-swapper/main/No-BS-Image-Swapper.user.js';
  assert.equal(header.match(/^\/\/ @updateURL\s+(\S+)$/m)?.[1], rawScript);
  assert.equal(header.match(/^\/\/ @downloadURL\s+(\S+)$/m)?.[1], rawScript);
  assert.match(header, /^\/\/ @version\s+\d+\.\d+\.\d+$/m);
  assert.match(header, /^\/\/ @author\s+VulpesNexus$/m);
  assert.match(source, /const STORAGE_KEY = 'image-swap-settings-v1'/);
  assert.match(source, /const ASSET_PREFIX = 'image-swap-upload-v1:'/);
});
