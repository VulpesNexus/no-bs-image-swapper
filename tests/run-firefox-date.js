// Targeted native date-control check in a disposable headless Firefox profile.
// FIREFOX_PATH=<firefox.exe> GECKODRIVER_PATH=<geckodriver.exe> node tests/run-firefox-date.js
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const firefox = process.env.FIREFOX_PATH;
const geckodriver = process.env.GECKODRIVER_PATH;
if (!firefox || !fs.existsSync(firefox) || !geckodriver || !fs.existsSync(geckodriver)) {
  console.error('Set FIREFOX_PATH and GECKODRIVER_PATH to local executables.');
  process.exit(2);
}

const workRoot = path.resolve(__dirname, '../work/firefox-test');
fs.mkdirSync(workRoot, { recursive: true });
const profileRoot = fs.mkdtempSync(path.join(workRoot, 'profile-'));
const screenshot = path.join(workRoot, 'calendar-firefox.png');
let driver;
let log = '';
let sessionId;
let driverPort;

function portNumber() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function request(port, method, endpoint, payload, timeout = 30000) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(timeout)
  });
  const data = await response.json();
  if (!response.ok || data.value?.error) {
    throw Error(`${method} ${endpoint}: ${data.value?.message || response.status}`);
  }
  return data.value;
}

async function waitForDriver(port) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (driver.exitCode !== null) throw Error(`geckodriver exited ${driver.exitCode}: ${log.slice(-2000)}`);
    try {
      const status = await request(port, 'GET', '/status', undefined, 1000);
      if (status.ready) return;
    } catch { /* It is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw Error(`geckodriver did not become ready: ${log.slice(-2000)}`);
}

async function execute(port, script) {
  return request(port, 'POST', `/session/${sessionId}/execute/sync`, { script, args: [] });
}

const prepareScript = `
  const ui = window.nbsisTestRoot;
  if (!ui) return { ready: false };
  window.openNbsisTestPanel();
  ui.querySelector('#add').click();
  ui.querySelector('#advancedOptions').open = true;
  const mode = ui.querySelector('#conditionMode');
  mode.value = 'scheduled';
  mode.dispatchEvent(new Event('change', { bubbles: true }));
  ui.querySelector('#scheduleFrom').scrollIntoView({ block: 'center' });
  return { ready: true };
`;

const inspectScript = `
  const ui = window.nbsisTestRoot;
  const text = ui.querySelector('#scheduleFrom');
  const picker = ui.querySelector('#scheduleFromPicker');
  const button = ui.querySelector('#scheduleFromCalendar');
  const a = text.getBoundingClientRect();
  const b = button.getBoundingClientRect();
  const style = getComputedStyle(picker);
  picker.value = '2026-10-18';
  picker.dispatchEvent(new Event('change', { bubbles: true }));
  const calendarToText = text.value === '18/10/2026';
  text.value = '19/10/2026';
  text.dispatchEvent(new Event('input', { bubbles: true }));
  const textToCalendar = picker.value === '2026-10-19';
  button.focus();
  button.scrollIntoView({ block: 'center' });
  return {
    viewportWidth: innerWidth,
    supportsWebkitIndicator: CSS.supports('selector(input::-webkit-calendar-picker-indicator)'),
    dateEntryDisplay: getComputedStyle(text.parentElement).display,
    nativeInputHidden: style.opacity === '0' && picker.tabIndex === -1 &&
      picker.getAttribute('aria-hidden') === 'true',
    buttonInsideText: b.left > a.left && b.right <= a.right &&
      Math.abs((b.top + b.height / 2) - (a.top + a.height / 2)) < 1,
    focused: ui.activeElement === button,
    focusVisible: button.matches(':focus-visible'),
    focusOutline: getComputedStyle(button).outlineStyle,
    calendarToText, textToCalendar,
    textBox: [a.x, a.y, a.width, a.height],
    buttonBox: [b.x, b.y, b.width, b.height]
  };
`;

async function main() {
  const port = await portNumber();
  driverPort = port;
  driver = spawn(geckodriver, ['--host', '127.0.0.1', '--port', String(port),
    '--binary', firefox, '--profile-root', profileRoot, '--log', 'error'], {
    cwd: workRoot, shell: false, windowsHide: true,
    env: { ...process.env, MOZ_HEADLESS: '1', MOZ_HEADLESS_WIDTH: '1000',
      MOZ_HEADLESS_HEIGHT: '900' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  for (const stream of [driver.stdout, driver.stderr]) {
    stream.on('data', data => { log = (log + data.toString()).slice(-10000); });
  }
  await waitForDriver(port);
  const session = await request(port, 'POST', '/session', {
    capabilities: { alwaysMatch: { browserName: 'firefox',
      'moz:firefoxOptions': { binary: firefox, args: ['-headless'], prefs: {
        'app.update.enabled': false, 'browser.shell.checkDefaultBrowser': false
      } } } }
  }, 90000);
  sessionId = session.sessionId;
  await request(port, 'POST', `/session/${sessionId}/url`, {
    url: pathToFileURL(path.join(__dirname, 'browser-firefox-date.html')).href
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await execute(port, prepareScript);
    if (result.ready) break;
    if (attempt === 49) throw Error('Userscript UI did not load');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  async function checkWidth(width) {
    const result = await execute(port, inspectScript);
    console.log(`${width}px: ${JSON.stringify(result)}`);
    if (result.viewportWidth !== width) throw Error(`Expected ${width}px viewport, got ${result.viewportWidth}px`);
    if (result.supportsWebkitIndicator || result.dateEntryDisplay !== 'block' ||
      !result.nativeInputHidden || !result.buttonInsideText || !result.focused ||
      !result.focusVisible || result.focusOutline === 'none' ||
      !result.calendarToText || !result.textToCalendar) {
      throw Error(`Firefox date control failed at ${width}px`);
    }
  }
  await request(port, 'POST', `/session/${sessionId}/window/rect`, { width: 1000, height: 900 });
  await checkWidth(1000);
  const image = await request(port, 'GET', `/session/${sessionId}/screenshot`);
  fs.writeFileSync(screenshot, Buffer.from(image, 'base64'));
  await execute(port, `
    const frame = document.createElement('iframe');
    frame.id = 'narrowFirefoxDate';
    frame.width = '320';
    frame.height = '640';
    frame.src = location.href;
    document.body.append(frame);
    return true;
  `);
  const frame = await request(port, 'POST', `/session/${sessionId}/element`, {
    using: 'css selector', value: '#narrowFirefoxDate'
  });
  await request(port, 'POST', `/session/${sessionId}/frame`, { id: frame });
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await execute(port, prepareScript);
    if (result.ready) break;
    if (attempt === 49) throw Error('Narrow Firefox fixture did not load');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await checkWidth(320);
  const button = await execute(port,
    `return window.nbsisTestRoot.querySelector('#scheduleFromCalendar');`);
  const elementId = button['element-6066-11e4-a52e-4f735466cecf'];
  if (!elementId) throw Error('WebDriver did not return the calendar button element');
  await request(port, 'POST', `/session/${sessionId}/element/${elementId}/click`, {});
  const opened = await execute(port, `
    const ui = window.nbsisTestRoot;
    return !ui.querySelector('#scheduleFrom').parentElement.classList.contains('native-date-fallback') &&
      !ui.querySelector('#scheduleFromCalendar').hidden;
  `);
  if (!opened) throw Error('Firefox calendar button fell back instead of opening the native picker');
  await request(port, 'POST', `/session/${sessionId}/frame/parent`, {});
  const topButton = await execute(port,
    `return window.nbsisTestRoot.querySelector('#scheduleFromCalendar');`);
  const topElementId = topButton['element-6066-11e4-a52e-4f735466cecf'];
  if (!topElementId) throw Error('WebDriver did not return the top-level calendar button');
  await request(port, 'POST', `/session/${sessionId}/element/${topElementId}/click`, {});
  console.log(`PASS: Firefox calendar layout, focus, picker launch, and date synchronization; screenshot: ${screenshot}`);
}

main().catch(error => {
  console.error(error.stack || error.message);
  if (log) console.error(`geckodriver log: ${log.slice(-2000)}`);
  process.exitCode = 1;
}).finally(async () => {
  if (sessionId && driver?.exitCode === null) {
    try {
      await request(driverPort, 'DELETE', `/session/${sessionId}`);
    } catch (error) { console.error(`Session cleanup: ${error.message}`); process.exitCode = 1; }
  }
  if (driver?.exitCode === null) driver.kill();
  const relative = path.relative(workRoot, profileRoot);
  if (!relative.startsWith('profile-') || relative.includes(path.sep) || relative.startsWith('..')) {
    throw Error('Unsafe Firefox profile cleanup target');
  }
  fs.rmSync(profileRoot, { recursive: true, force: true });
});
