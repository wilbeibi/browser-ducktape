// Manual check for duplicate_tabs_closer's sweep. NOT part of `npm run check`:
// it launches Chrome and hits the network, so it is too slow and too flaky for
// CI. Run it by hand after touching the protocol:  node misc/manual_sweep_check.js
//
// Does ONE click of "Close duplicate tabs everywhere" close duplicates in OTHER
// tabs, OTHER windows and OTHER origins? It opens 18 tabs over 3 URLs in 2
// browser windows, clicks the command in ONE of them, and reports the survivors
// per URL. Expected: one survivor per URL, and it is the oldest tab.
//
// This is the check that caught background-tab timer throttling silently
// stranding duplicates - keep it timer-hostile.
//
// The shim is faithful on the one point that matters: GM_setValue in one page
// is delivered to every other page's GM_addValueChangeListener with remote=true,
// which is exactly what Tampermonkey/Violentmonkey do across windows and origins.
const { spawn } = require('node:child_process');
const os = require('node:os'), fs = require('node:fs'), path = require('node:path');

const PORT = 9334;
const SRC = fs.readFileSync(path.join(__dirname, '..', 'duplicate_tabs_closer.user.js'), 'utf8');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dtcsweep-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--headless=new', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const http = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
      else if (m.method) this.handlers.forEach((h) => h(m));
    });
  }
  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res) => { this.pending.set(id, res); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  on(fn) { this.handlers.push(fn); }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return r.result?.result?.value;
  }
}

// GM shim + the real userscript, function-wrapped the way a manager wraps it.
const bootstrap = `
window.__gm = { store: { dtc_config: JSON.stringify({ mode: 'manual' }) },
                listeners: {}, menu: {}, closed: false, focused: 0 };
function GM_getValue(k, d) { return k in window.__gm.store ? window.__gm.store[k] : d; }
function GM_setValue(k, v) { window.__gm.store[k] = v; gmBusOut(JSON.stringify({ k, v })); }
function GM_addValueChangeListener(k, cb) { (window.__gm.listeners[k] = window.__gm.listeners[k] || []).push(cb); }
function GM_addStyle() {}
function GM_registerMenuCommand(label, fn) { window.__gm.menu[label] = fn; return label; }
window.__gmDeliver = (k, v) => {
  const old = window.__gm.store[k];
  window.__gm.store[k] = v;
  (window.__gm.listeners[k] || []).forEach((cb) => cb(k, old, v, true));
};
window.close = () => { window.__gm.closed = true; };
window.focus = () => { window.__gm.focused++; };
(function () { ${SRC} })();
`;

const GROUPS = ['https://example.com/', 'https://example.org/', 'https://www.iana.org/help/example-domains'];
const PAGES = [];
for (let i = 0; i < 18; i++) {
  const url = GROUPS[i % GROUPS.length];
  PAGES.push({ name: `T${String(i).padStart(2, '0')} ${url.slice(8, 24)}`, url, newWindow: i === 9 });
}

(async () => {
  for (let i = 0; i < 40; i++) { try { await http('/json/version'); break; } catch { await sleep(250); } }
  const browser = await CDP.open((await http('/json/version')).webSocketDebuggerUrl);
  const pages = [];

  for (const spec of PAGES) {
    const { result } = await browser.send('Target.createTarget', { url: 'about:blank', newWindow: spec.newWindow });
    const entry = (await http('/json/list')).find((t) => t.id === result.targetId);
    const cdp = await CDP.open(entry.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Runtime.addBinding', { name: 'gmBusOut' });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: bootstrap });
    const win = await browser.send('Browser.getWindowForTarget', { targetId: result.targetId });
    const page = { ...spec, cdp, targetId: result.targetId, windowId: win.result.windowId };
    // The bus: one page's GM_setValue reaches every other page's listener.
    cdp.on((m) => {
      if (m.method !== 'Runtime.bindingCalled' || m.params.name !== 'gmBusOut') return;
      const { k, v } = JSON.parse(m.params.payload);
      for (const other of pages) {
        if (other !== page) other.cdp.eval(`window.__gmDeliver(${JSON.stringify(k)}, ${JSON.stringify(v)})`);
      }
    });
    pages.push(page);
    await cdp.send('Page.navigate', { url: spec.url });
    await sleep(350); // stagger loads so tab age is unambiguous
  }

  await sleep(500);
  const before = [];
  for (const p of pages) before.push(await p.cdp.eval('window.__gm.closed'));

  // ONE click, in a duplicate that is neither the oldest nor in the first window.
  const trigger = pages[14];
  await trigger.cdp.eval("window.__gm.menu['Close duplicate tabs everywhere']()");
  await sleep(2500);

  const rows = [];
  for (const p of pages) {
    rows.push({
      page: p.name,
      url: await p.cdp.eval('location.href'),
      scriptRan: await p.cdp.eval('Object.keys(window.__gm.menu).length > 0'),
      heardSweep: await p.cdp.eval('!!window.__gm.store.dtc_sweep'),
      closedBefore: before[pages.indexOf(p)],
      closedBySweep: await p.cdp.eval('window.__gm.closed'),
      focused: await p.cdp.eval('window.__gm.focused'),
    });
  }
  console.log(`triggered from: ${trigger.name}`);
  const byUrl = {};
  for (const r of rows) (byUrl[r.url] = byUrl[r.url] || []).push(r);
  for (const [url, group] of Object.entries(byUrl)) {
    const survivors = group.filter((r) => !r.closedBySweep);
    const oldest = group[0];
    console.log(`${url}\n  tabs ${group.length} | closed ${group.length - survivors.length} | survivors ${survivors.length} (${survivors.map((r) => r.page).join(', ')}) | oldest survived: ${survivors.length === 1 && survivors[0].page === oldest.page}`);
  }
  console.log('windows used:', [...new Set(pages.map((p) => p.windowId))].length);

  chrome.kill();
  await sleep(600);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
})().catch(async (e) => { console.error('FAILED', e); chrome.kill(); process.exit(1); });
