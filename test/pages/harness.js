// Loads one of the extension's pages into happy-dom, on top of the fake browser API.
// The page's messages to the background go to `handlers` (canned results), not to background.js.
import { fake } from '../fake-browser.js';
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
let loads = 0;

// `confirm`: the answers confirm() gives, in order (true once they run out).
export async function loadPage(name, { search = '', handlers = {}, confirm = [] } = {}) {
  const win = new Window({ url: `chrome-extension://test/${name}.html${search}`, settings: { navigation: { disableMainFrameNavigation: true } } });
  const html = readFileSync(`${SRC}${name}.html`, 'utf8');
  const body = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  win.document.body.innerHTML = body;

  const page = {
    win,
    doc: win.document,
    $: (id) => win.document.getElementById(id),
    sent: [], // messages sent to the background
    alerts: [],
    confirms: [], // confirm() messages
    downloads: [], // { filename, data }
    navigations: [], // location.href assignments
    replaced: [], // history.replaceState URLs
    closed: 0, // window.close() calls
  };

  const answers = [...confirm];
  win.close = () => { page.closed++; };
  const blobs = new Map();
  URL.createObjectURL = (blob) => { const u = `blob:test/${blobs.size}`; blobs.set(u, blob); return u; };
  URL.revokeObjectURL = () => {};
  win.HTMLAnchorElement.prototype.click = function click() {
    if (this.download) page.downloads.push({ filename: this.download, blob: blobs.get(this.href) });
  };
  const location = {
    get search() { return win.location.search; },
    get href() { return win.location.href; },
    set href(v) { page.navigations.push(v); },
  };
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    Node: win.Node,
    HTMLElement: win.HTMLElement,
    Event: win.Event,
    location,
    history: { replaceState: (s, t, u) => page.replaced.push(u) },
    alert: (m) => page.alerts.push(m),
    confirm: (m) => { page.confirms.push(m); return answers.length ? answers.shift() : true; },
  });

  fake.api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    page.sent.push(msg);
    const h = handlers[msg.type];
    if (!h) { sendResponse({ ok: false, error: `Unhandled message: ${msg.type}` }); return true; }
    Promise.resolve().then(() => h(msg)).then(
      (result) => sendResponse({ ok: true, result }),
      (e) => sendResponse({ ok: false, error: e.message }),
    );
    return true;
  });

  await import(`../../src/${name}.js?load=${loads++}`);
  await settle();
  return page;
}

// Waits for the page's async work and the fake's events.
export async function settle() {
  for (let i = 0; i < 3; i++) await fake.flush();
}

export const sentTypes = (page) => page.sent.map((m) => m.type);
export const text = (node) => node?.textContent.replace(/\s+/g, ' ').trim();

export function fire(node, type, init = {}) {
  const win = node.document ? node : (node.ownerDocument || node).defaultView; // a window, document or element
  const Ctor = type.startsWith('key') ? win.KeyboardEvent : win.Event;
  node.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, ...init }));
}

export function setValue(input, value, type = 'input') {
  input.value = value;
  fire(input, type);
}

export function submit(form) {
  fire(form, 'submit');
}

// Ends the previous page: its storage listeners and globals go, the fake starts empty.
export function resetPage() {
  fake.reset({ listeners: true });
}
