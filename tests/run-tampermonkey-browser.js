// Optional installed-manager check. Requires Chrome for Testing (CHROME_PATH) and
// an unpacked Tampermonkey extension (TM_EXTENSION_PATH). Neither is bundled.
// Runs headlessly in a throwaway browser profile and local HTTP fixture.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const chrome = process.env.CHROME_PATH;
const extension = process.env.TM_EXTENSION_PATH;
const scriptPath = path.resolve(__dirname, '..', 'No-BS-Image-Swapper.user.js');
const scriptName = 'No-BS-Image-Swapper.user.js';
const injectedExpression = `!!document.getElementById('image-swap-widget-host')`;
if (!chrome || !extension || !fs.existsSync(chrome) || !fs.existsSync(path.join(extension, 'manifest.json'))) {
  console.error('Set CHROME_PATH and TM_EXTENSION_PATH to existing Chrome and unpacked Tampermonkey paths.');
  process.exit(2);
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nbsis-tm-check-'));
const server = http.createServer((req, res) => {
  if (req.url === '/' + scriptName) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(fs.readFileSync(scriptPath));
  } else if (req.url === '/fixture') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>NBSIS manager check</title><img src="/source.png" alt="source">');
  } else {
    res.writeHead(404); res.end();
  }
});

let child;
let socket;
let browserOutput = '';
const pending = new Map();
let nextId = 1;
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function openPage(url, background = false) {
  const { targetId } = await send('Target.createTarget', { url, background });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  return { targetId, sessionId };
}
async function evaluate(page, expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, page.sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
async function widgetCall(page, body) {
  const { root } = await send('DOM.getDocument', { depth: -1, pierce: true }, page.sessionId);
  const find = node => {
    if (node.nodeType === 1 && node.attributes?.some((value, index) =>
      index % 2 === 0 && value === 'id' && node.attributes[index + 1] === 'image-swap-widget-host')) return node;
    for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
      const result = find(child);
      if (result) return result;
    }
    return null;
  };
  const host = find(root);
  if (!host?.shadowRoots?.[0]) throw new Error('NBSIS closed shadow root missing');
  const { object } = await send('DOM.resolveNode', { backendNodeId: host.shadowRoots[0].backendNodeId }, page.sessionId);
  const result = await send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: 'function () { ' + body + ' }',
    awaitPromise: true, returnByValue: true
  }, page.sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
async function poll(description, probe, attempts = 80) {
  for (let i = 0; i < attempts; i++) {
    let value = null;
    try { value = await probe(); } catch (_) {}
    if (value) return value;
    await pause(500);
  }
  throw new Error('Timed out waiting for ' + description + (browserOutput ? '\nBrowser: ' + browserOutput.slice(-3000) : ''));
}
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const args = ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
    '--disable-background-networking', '--load-extension=' + extension,
    '--enable-unsafe-extension-debugging', '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--lang=en-US', '--window-size=1280,860', 'about:blank'];
  child = spawn(chrome, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
    browserOutput = (browserOutput + data.toString()).slice(-12000);
  });
  child.on('error', error => { browserOutput += '\nLaunch error: ' + error.message; });
  const wsUrl = await poll('Chrome debugging endpoint', () => {
    const data = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
    return data.length === 2 ? 'ws://127.0.0.1:' + data[0] + data[1] : null;
  }, 100);
  socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const response = JSON.parse(event.data);
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id); clearTimeout(request.timer);
    response.error ? request.reject(new Error(response.error.message)) : request.resolve(response.result);
  };
  socket.onclose = () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('CDP connection closed'));
    }
    pending.clear();
  };
  const extensionsPage = await openPage('chrome://extensions/');
  const manager = await poll('Tampermonkey extension', async () => {
    const list = await evaluate(extensionsPage, 'chrome.developerPrivate.getExtensionsInfo()');
    return list.find(item => /Tampermonkey/i.test(item.name));
  }, 30);
  console.log('Manager: ' + manager.name + ' ' + manager.version);
  await evaluate(extensionsPage, `chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true}).then(() => chrome.developerPrivate.updateExtensionConfiguration({extensionId:${JSON.stringify(manager.id)},userScriptsAccess:true}))`);
  const access = await evaluate(extensionsPage, `chrome.developerPrivate.getExtensionsInfo().then(list => { const e=list.find(x=>x.id===${JSON.stringify(manager.id)}); return {state:e.state,userScriptsAccess:e.userScriptsAccess}; })`);
  if (access.state !== 'ENABLED' || !access.userScriptsAccess?.isActive) throw new Error('Tampermonkey user script access unavailable: ' + JSON.stringify(access));
  await pause(2000);
  await openPage(origin + '/' + scriptName);
  let lastTargets = [];
  const installer = await poll('Tampermonkey installation tab', async () => {
    const { targetInfos } = await send('Target.getTargets');
    lastTargets = targetInfos.filter(item => item.type === 'page').map(item => item.url);
    return targetInfos.find(item => item.type === 'page' && item.url.startsWith('chrome-extension://' + manager.id) && /ask|confirm|install/i.test(item.url));
  }, 12).catch(() => null);
  const installPage = installer ? await (async () => {
    const { sessionId } = await send('Target.attachToTarget', { targetId: installer.targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    return { targetId: installer.targetId, sessionId };
  })() : await openPage('chrome-extension://' + manager.id + '/ask.html?url=' + encodeURIComponent(origin + '/' + scriptName));
  const installed = await poll('Tampermonkey Install button', () => evaluate(installPage, `(() => { const button = [...document.querySelectorAll('button,input[type=button],input[type=submit]')].find(e => /^(install|confirm installation|reinstall|update)$/i.test((e.value || e.textContent).trim())); if (!button) return null; button.click(); return (button.value || button.textContent).trim(); })()`), 30).catch(async error => { throw new Error(error.message + '\nInstaller body: ' + await evaluate(installPage, 'document.body.innerText.slice(0,1000)').catch(() => '') + '\nPage targets: ' + JSON.stringify(lastTargets)); });
  console.log('Installer action: ' + installed);
  await pause(3000);
  const fixture = await openPage(origin + '/fixture');
  // NBSIS keeps its UI host detached until a control is opened; a missing host
  // on a fresh install is expected. Open it through the real manager menu.
  await send('Target.activateTarget', { targetId: fixture.targetId });
  const action = await openPage('chrome-extension://' + manager.id + '/action.html', true);
  const invoked = await poll('NBSIS manager command', () => evaluate(action, `(() => { const e=[...document.querySelectorAll('*')].find(e=>e.children.length===0 && e.textContent.trim()==='Manage image replacements'); if(!e)return ''; e.click(); return true; })()`), 30);
  if (!invoked) throw new Error('Manage image replacements menu command missing');
  await poll('NBSIS panel mount after menu command', () => evaluate(fixture, injectedExpression), 30);
  const panel = await widgetCall(fixture, `return { open: !this.getElementById('veil').hidden,
    label: this.getElementById('panel').getAttribute('aria-label'),
    showButton: this.getElementById('showButton').checked };`);
  if (!panel.open || panel.label !== 'No-BS Image Swapper settings' || panel.showButton) throw new Error('NBSIS panel state invalid: ' + JSON.stringify(panel));
  const theme = await widgetCall(fixture, `
    const button = this.getElementById('themeToggle');
    const first = button.dataset.resolved;
    button.click();
    const second = button.dataset.resolved;
    const explicit = button.dataset.mode;
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    const automatic = button.dataset.mode;
    const autoHint = button.title;
    const autoResolved = button.dataset.resolved;
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    const fixed = button.dataset.mode;
    const fixedHint = button.title;
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    return { first, second, explicit, automatic, autoHint, autoResolved, fixed, fixedHint,
      restored: button.dataset.mode,
      sameSize: button.getBoundingClientRect().width === this.getElementById('close').getBoundingClientRect().width };
  `);
  if (theme.first === theme.second || theme.explicit !== theme.second ||
      theme.automatic !== 'auto' || theme.fixed !== theme.autoResolved ||
      theme.restored !== 'auto' || !theme.autoHint.includes('Shift+click to disable Automatic.') ||
      !theme.fixedHint.includes('Shift+click for Automatic.') || !theme.sameSize)
    throw new Error('Theme bulb toggle invalid in Tampermonkey: ' + JSON.stringify(theme));
  await widgetCall(fixture, `this.getElementById('showButton').click(); return this.getElementById('showButton').checked;`);
  await pause(700);
  await send('Page.reload', {}, fixture.sessionId);
  await poll('floating button after reload', () => evaluate(fixture, injectedExpression), 30);
  const after = await widgetCall(fixture, `return { showButton: this.getElementById('showButton').checked,
    launcherVisible: !this.getElementById('launcher').hidden,
    panelClosed: this.getElementById('veil').hidden };`);
  if (!after.showButton || !after.launcherVisible || !after.panelClosed) throw new Error('Floating button persistence invalid: ' + JSON.stringify(after));
  console.log('PASS: NBSIS installed in Tampermonkey; manager menu opened the panel; Shift+click disabled and restored Automatic; floating button persisted across reload.');
}

(async () => {
  try { await main(); }
  catch (error) { console.error('FAIL: ' + error.stack); process.exitCode = 1; }
  finally {
    try { if (socket?.readyState === WebSocket.OPEN) await send('Browser.close'); } catch (_) {}
    try { socket?.close(); } catch (_) {}
    for (const request of pending.values()) clearTimeout(request.timer);
    if (child && child.exitCode === null) {
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(3000)]);
      if (child.exitCode === null) child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(5000)]);
    }
    if (server.listening) await new Promise(resolve => server.close(resolve));
    const root = fs.realpathSync(os.tmpdir());
    const resolved = fs.realpathSync(profile);
    if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith('nbsis-tm-check-')) {
      throw new Error('Unsafe temporary browser profile cleanup path');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})();
