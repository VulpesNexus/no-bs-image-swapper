// Runs tests/browser-ui.html in headless Chromium at two window sizes, then in
// fixed-width frames below the 500 px headless window minimum.
// Usage: CHROME_PATH=<Chromium or Chrome executable> node tests/run-browser-ui.js
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const browser = process.env.CHROME_PATH;
if (!browser || !fs.existsSync(browser)) {
  console.error('Set CHROME_PATH to a Chromium or Chrome executable.');
  process.exit(2);
}
const runs = [['browser-ui.html', '1000,900'], ['browser-ui.html', '500,700'],
  ['browser-ui-widths.html', '1000,900'], ['browser-svg-xlink.html', '1000,900'],
  ['browser-asset-deletion.html', '1000,900'], ['browser-privacy.html', '1000,900'],
  ['browser-srcset-picture.html', '1000,900'],
  ['browser-appearance.html', '1000,900'],
  ['browser-host-background.html', '1000,900']];

function run(page, windowSize) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'no-bs-image-swapper-browser-'));
  try {
    const args = ['--headless=new', '--disable-gpu', '--disable-background-networking',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--no-proxy-server', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--window-size=' + windowSize, '--virtual-time-budget=30000', '--dump-dom',
      '--user-data-dir=' + profile];
    // Chromium refuses to run as root, as in containers, without this flag.
    if (process.getuid?.() === 0) args.push('--no-sandbox');
    args.push(pathToFileURL(path.join(__dirname, page)).href);
    const result = spawnSync(browser, args, { encoding: 'utf8', timeout: 90000,
      shell: false, windowsHide: true });
    const dom = result.stdout || '';
    const acceptance = /<body[^>]*data-acceptance="([^"]*)"/.exec(dom)?.[1] || '';
    const error = /<body[^>]*data-error="([^"]*)"/.exec(dom)?.[1] || '';
    const frames = /<body[^>]*data-results="([^"]*)"/.exec(dom)?.[1];
    console.log(page + ' in ' + windowSize + ' window: browser exit ' + result.status + ', UI ' +
      (acceptance || 'NO RESULT') + (frames ? ' (' + frames + ')' : ''));
    if (error) console.log('Assertion: ' + error);
    if (result.status !== 0 || acceptance !== 'PASS') {
      if (result.error) console.error('Launch error: ' + result.error.message);
      if (result.signal) console.error('Browser signal: ' + result.signal);
      if (result.stderr) console.error('Browser stderr: ' + result.stderr);
      if (!acceptance && dom) console.error('Browser stdout: ' + dom);
      process.exitCode = 1;
    }
  } finally {
    const tempRoot = fs.realpathSync(os.tmpdir());
    const resolvedProfile = fs.realpathSync(profile);
    if (!resolvedProfile.startsWith(tempRoot + path.sep)) {
      throw new Error('Unsafe browser profile cleanup target');
    }
    fs.rmSync(resolvedProfile, { recursive: true, force: true });
  }
}

for (const [page, size] of runs) run(page, size);
