'use strict';

/*
 * Browser orchestration over CDP.
 *
 * A ShardX profile is already a running Chromium instance when this module is
 * called; the runner only attaches to it. Two engines share one interface:
 *
 *   playwright - `chromium.connectOverCDP(wsUrl)` from `playwright-core`.
 *                Used whenever the package is installed.
 *   cdp        - a minimal DevTools client over the built-in WebSocket,
 *                so the extension still works with zero npm dependencies.
 *
 * Neither engine ever launches a browser. The ShardX launcher owns the
 * process, its proxy and its fingerprint; attaching must not change them.
 *
 * Every click / keystroke / scroll goes through the Poisson scheduler so the
 * traffic shape stays human. `observe()` returns a semantic snapshot with
 * stable `e1..eN` refs plus geometry; `act()` consumes those refs.
 */

const scheduler = require('./scheduler');
const { connect: wsConnect } = require('./ws');

const SNAPSHOT_SOURCE = `(() => {
  const MAX_TEXT = 8000;
  const MAX_ELEMENTS = 160;
  const MAX_NODES = 220;
  const visible = (el) => {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (Number(style.opacity) === 0) return false;
    return rect.bottom >= -400 && rect.top <= window.innerHeight + 400;
  };
  const selectorOf = (el) => {
    if (!el || el.nodeType !== 1) return '';
    if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id)) return '#' + el.id;
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id && /^[A-Za-z][\\w-]*$/.test(node.id)) { parts.unshift('#' + node.id); break; }
      const parent = node.parentElement;
      if (parent) {
        const same = Array.prototype.filter.call(parent.children, (child) => child.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
      depth += 1;
    }
    return parts.join(' > ');
  };
  const labelOf = (el) => {
    const raw = el.getAttribute('aria-label')
      || el.getAttribute('placeholder')
      || el.getAttribute('title')
      || el.getAttribute('alt')
      || (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ? el.value : '')
      || (el.innerText || el.textContent || '');
    return String(raw).replace(/\\s+/g, ' ').trim().slice(0, 120);
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      const type = String(el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button') return 'button';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'summary') return 'button';
    if (tag === 'label') return 'label';
    return 'generic';
  };
  const refs = new Map();
  window.__shardxRefs = refs;
  const elements = [];
  const candidates = document.querySelectorAll(
    'a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="textbox"],[contenteditable=""],[contenteditable="true"],[onclick]'
  );
  let index = 0;
  for (const el of candidates) {
    if (index >= MAX_ELEMENTS) break;
    if (!visible(el)) continue;
    index += 1;
    const ref = 'e' + index;
    refs.set(ref, el);
    const rect = el.getBoundingClientRect();
    elements.push({
      ref,
      role: roleOf(el),
      tag: el.tagName.toLowerCase(),
      label: labelOf(el),
      selector: selectorOf(el),
      value: String(el.value === undefined ? '' : el.value).slice(0, 200),
      disabled: Boolean(el.disabled),
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  }
  const seen = new Set();
  const tree = [];
  let nodeCount = 0;
  const walk = (root, depth) => {
    if (!root || nodeCount >= MAX_NODES || depth > 5) return;
    const children = [];
    for (const el of root.children) {
      if (nodeCount >= MAX_NODES) break;
      if (!visible(el)) continue;
      nodeCount += 1;
      const role = roleOf(el);
      const entry = { role, name: labelOf(el).slice(0, 80), children };
      if (!seen.has(el)) {
        seen.add(el);
        tree.push(null);
        tree.pop();
      }
      const node = { role, name: entry.name, children: [] };
      if (depth < 4) walk(el, depth + 1, node.children);
      if (node.children.length) children.push(node);
      else if (node.name) children.push({ role, name: node.name, children: [] });
    }
    return children;
  };
  const aria = walk(document.body, 0) || [];
  const text = String(document.body ? document.body.innerText || '' : '')
    .replace(/[ \\t]+/g, ' ')
    .replace(/\\n{3,}/g, '\\n\\n')
    .trim()
    .slice(0, MAX_TEXT);
  return {
    url: location.href,
    title: document.title || '',
    readyState: document.readyState,
    text,
    elements,
    aria,
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    capturedAt: Date.now(),
  };
})()`;

const KEY_ALIASES = Object.freeze({
  enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  pagedown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  pageup: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  end: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
});

function keyDefinition(raw) {
  const text = String(raw || '').trim();
  if (!text) return KEY_ALIASES.enter;
  const alias = KEY_ALIASES[text.toLowerCase()];
  if (alias) return alias;
  const char = text.slice(0, 1);
  const code = /[a-zA-Z]/.test(char) ? `Key${char.toUpperCase()}` : /[0-9]/.test(char) ? `Digit${char}` : '';
  return {
    key: char,
    code,
    windowsVirtualKeyCode: char.toUpperCase().charCodeAt(0),
    text: char,
  };
}

class CdpError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'CdpError';
    if (options.code) this.code = options.code;
    if (options.cause) this.cause = options.cause;
  }
}

function withTimeout(promise, ms, message, code = 'cdp_timeout') {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new CdpError(message, { code })), Math.max(1, ms));
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/* ------------------------------------------------------------------------- */
/* Raw DevTools protocol engine                                              */
/* ------------------------------------------------------------------------- */

class CdpConnection {
  constructor(conn) {
    this.conn = conn;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    conn.on('message', ({ data, binary }) => {
      if (binary) return;
      let message;
      try { message = JSON.parse(data.toString('utf8')); } catch { return; }
      if (message.id && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          entry.reject(new CdpError(
            `CDP ${entry.method} 失败：${message.error.message || 'unknown'}`,
            { code: 'cdp_command_failed' },
          ));
        } else {
          entry.resolve(message.result || {});
        }
        return;
      }
      if (message.method) {
        const key = message.sessionId ? `${message.method}@${message.sessionId}` : message.method;
        for (const handler of this.listeners.get(key) || []) handler(message.params || {});
        for (const handler of this.listeners.get(message.method) || []) handler(message.params || {});
      }
    });
    conn.on('close', () => {
      this.closed = true;
      for (const entry of this.pending.values()) {
        entry.reject(new CdpError('CDP 连接已关闭', { code: 'cdp_closed' }));
      }
      this.pending.clear();
      for (const handler of this.listeners.get('__close__') || []) handler({});
    });
  }

  send(method, params = {}, sessionId = '') {
    if (this.closed) return Promise.reject(new CdpError('CDP 连接已关闭', { code: 'cdp_closed' }));
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        this.conn.sendText(JSON.stringify(payload));
      } catch (error) {
        this.pending.delete(id);
        reject(new CdpError(`CDP 发送失败：${error.message}`, { code: 'cdp_send_failed', cause: error }));
      }
    });
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
    return () => {
      const list = this.listeners.get(event) || [];
      this.listeners.set(event, list.filter((item) => item !== handler));
    };
  }

  close() {
    try { this.conn.close(1000, 'runner detach'); } catch { /* ignore */ }
  }
}

class RawCdpPage {
  constructor(client) {
    this.client = client;
    this.sessionId = '';
    this.targetId = '';
  }

  send(method, params = {}) {
    return this.client.send(method, params, this.sessionId);
  }

  async attach() {
    const targets = await this.client.send('Target.getTargets');
    const pages = (targets.targetInfos || []).filter((info) => info.type === 'page'
      && !String(info.url || '').startsWith('devtools://'));
    let targetId = pages.length ? pages[0].targetId : '';
    if (!targetId) {
      const created = await this.client.send('Target.createTarget', { url: 'about:blank' });
      targetId = created.targetId;
    }
    const attached = await this.client.send('Target.attachToTarget', { targetId, flatten: true });
    this.sessionId = attached.sessionId;
    this.targetId = targetId;
    await this.send('Page.enable').catch(() => {});
    await this.send('Runtime.enable').catch(() => {});
    await this.send('Page.setLifecycleEventsEnabled', { enabled: true }).catch(() => {});
    return this;
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception
        ? result.exceptionDetails.exception.description
        : result.exceptionDetails.text;
      throw new CdpError(`页面脚本异常：${String(description || 'unknown')}`, { code: 'page_script_error' });
    }
    return result.result ? result.result.value : undefined;
  }

  async goto(url, timeoutMs) {
    const loaded = new Promise((resolve) => {
      const off = this.client.on(`Page.loadEventFired@${this.sessionId}`, () => {
        off();
        resolve();
      });
    });
    const navigation = await this.send('Page.navigate', { url });
    if (navigation.errorText) {
      throw new CdpError(`导航失败：${navigation.errorText}`, { code: 'navigation_failed' });
    }
    await withTimeout(loaded, timeoutMs, `页面加载超时（${url}）`, 'navigation_timeout').catch(() => {});
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = await this.evaluate('document.readyState');
      if (state === 'complete' || state === 'interactive') return;
      if (Date.now() >= deadline) return;
      await scheduler.sleep(100);
    }
  }

  async clickAt(x, y) {
    const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved' }, base, { button: 'none' }));
    await this.send('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed' }, base));
    await this.send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased' }, base));
  }

  async clickRef(ref) {
    const point = await this.evaluate(`(() => {
      const el = window.__shardxRefs && window.__shardxRefs.get(${JSON.stringify(String(ref))});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (!point) return false;
    await this.clickAt(point.x, point.y);
    return true;
  }

  async clickSelector(selector) {
    const point = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(String(selector))});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (!point) return false;
    await this.clickAt(point.x, point.y);
    return true;
  }

  async focusRef(ref) {
    return this.evaluate(`(() => {
      const el = window.__shardxRefs && window.__shardxRefs.get(${JSON.stringify(String(ref))});
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.focus();
      if (typeof el.select === 'function' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) el.select();
      return true;
    })()`);
  }

  async focusSelector(selector) {
    return this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(String(selector))});
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.focus();
      if (typeof el.select === 'function' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) el.select();
      return true;
    })()`);
  }

  async typeText(text) {
    for (const char of String(text)) {
      await this.send('Input.insertText', { text: char });
    }
  }

  async pressKey(rawKey) {
    const def = keyDefinition(rawKey);
    const base = {
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.windowsVirtualKeyCode,
      nativeVirtualKeyCode: def.windowsVirtualKeyCode,
    };
    await this.send('Input.dispatchKeyEvent', Object.assign({ type: def.text ? 'keyDown' : 'rawKeyDown' }, base, def.text ? { text: def.text } : {}));
    await this.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
  }

  async scrollBy(x, y, deltaX, deltaY) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round(x),
      y: Math.round(y),
      deltaX: Math.round(deltaX),
      deltaY: Math.round(deltaY),
      button: 'none',
    });
  }

  async screenshot() {
    const shot = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    return String(shot.data || '');
  }

  async pageInfo() {
    return this.evaluate('({ url: location.href, title: document.title })');
  }

  async setCookies(cookies) {
    let applied = 0;
    for (const cookie of cookies || []) {
      if (!cookie || !cookie.name) continue;
      const params = {
        name: String(cookie.name),
        value: String(cookie.value === undefined ? '' : cookie.value),
        path: String(cookie.path || '/'),
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.httpOnly),
      };
      if (cookie.domain) params.domain = String(cookie.domain);
      if (cookie.url) params.url = String(cookie.url);
      if (cookie.expires !== undefined && Number.isFinite(Number(cookie.expires))) {
        params.expires = Number(cookie.expires);
      }
      if (cookie.sameSite) params.sameSite = cookie.sameSite;
      try {
        const result = await this.send('Network.setCookie', params);
        if (!result || result.success !== false) applied += 1;
      } catch (error) {
        if (!cookie.url && cookie.domain) {
          const retried = await this.send('Network.setCookie', Object.assign({}, params, {
            url: `https://${String(cookie.domain).replace(/^\./, '')}${params.path}`,
          })).catch(() => null);
          if (retried && retried.success !== false) {
            applied += 1;
            continue;
          }
        }
        throw error;
      }
    }
    return applied;
  }

  detach() {
    if (this.targetId) {
      this.client.send('Target.detachFromTarget', { sessionId: this.sessionId }).catch(() => {});
    }
  }
}

/* ------------------------------------------------------------------------- */
/* Playwright engine                                                         */
/* ------------------------------------------------------------------------- */

class PlaywrightPage {
  constructor(browser, page) {
    this.browser = browser;
    this.page = page;
  }

  async evaluate(expression) {
    return this.page.evaluate(expression);
  }

  async goto(url, timeoutMs) {
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  }

  async clickAt(x, y) {
    await this.page.mouse.move(x, y);
    await this.page.mouse.click(x, y);
  }

  async clickRef(ref) {
    const point = await this.page.evaluate(`(() => {
      const el = window.__shardxRefs && window.__shardxRefs.get(${JSON.stringify(String(ref))});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (!point) return false;
    await this.clickAt(point.x, point.y);
    return true;
  }

  async clickSelector(selector) {
    await this.page.locator(String(selector)).first().click({ timeout: 15000 });
    return true;
  }

  async focusRef(ref) {
    return this.page.evaluate(`(() => {
      const el = window.__shardxRefs && window.__shardxRefs.get(${JSON.stringify(String(ref))});
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.focus();
      if (typeof el.select === 'function' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) el.select();
      return true;
    })()`);
  }

  async focusSelector(selector) {
    await this.page.locator(String(selector)).first().focus({ timeout: 15000 });
    return true;
  }

  async typeText(text) {
    for (const char of String(text)) await this.page.keyboard.type(char);
  }

  async pressKey(rawKey) {
    await this.page.keyboard.press(String(rawKey || 'Enter'));
  }

  async scrollBy(x, y, deltaX, deltaY) {
    await this.page.mouse.move(x, y);
    await this.page.mouse.wheel(deltaX, deltaY);
  }

  async screenshot() {
    const buffer = await this.page.screenshot({ type: 'png' });
    return buffer.toString('base64');
  }

  async pageInfo() {
    return { url: this.page.url(), title: await this.page.title() };
  }

  async setCookies(cookies) {
    const list = [];
    for (const cookie of cookies || []) {
      if (!cookie || !cookie.name) continue;
      const entry = {
        name: String(cookie.name),
        value: String(cookie.value === undefined ? '' : cookie.value),
        path: String(cookie.path || '/'),
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.httpOnly),
      };
      if (cookie.domain) entry.domain = String(cookie.domain);
      if (cookie.url) entry.url = String(cookie.url);
      if (cookie.expires !== undefined && Number.isFinite(Number(cookie.expires))) {
        entry.expires = Number(cookie.expires);
      }
      if (cookie.sameSite) {
        const name = String(cookie.sameSite).toLowerCase();
        entry.sameSite = name === 'strict' ? 'Strict' : name === 'none' ? 'None' : 'Lax';
      }
      list.push(entry);
    }
    if (!list.length) return 0;
    await this.page.context().addCookies(list);
    return list.length;
  }

  detach() {
    try { this.browser.close().catch(() => {}); } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------------- */
/* Runner                                                                    */
/* ------------------------------------------------------------------------- */

function loadPlaywright(explicit) {
  if (explicit === false) return null;
  if (explicit) return explicit;
  try {
    return require('playwright-core');
  } catch {
    return null;
  }
}

function createCdpRunner(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const store = options.store || null;
  const playwright = loadPlaywright(options.playwright);
  const actionOptions = Object.assign({
    minMs: 400,
    maxMs: 1800,
  }, options.actionOptions || {});
  const defaultTimeoutMs = Number(options.timeoutMs) || 20000;
  const beforeAction = typeof options.beforeAction === 'function' ? options.beforeAction : async () => {};
  const sessions = new Map();

  function engineName() {
    return playwright ? 'playwright' : 'cdp';
  }

  async function attach(profileId, attachOptions = {}) {
    const id = String(profileId || '').trim();
    if (!id) throw new CdpError('profileId 不能为空', { code: 'profile_id_required' });
    const wsUrl = String(attachOptions.wsUrl || '').trim();
    if (!wsUrl) throw new CdpError('attach 需要 wsUrl', { code: 'cdp_endpoint_missing', status: 400 });
    const existing = sessions.get(id);
    if (existing && existing.wsUrl === wsUrl) return existing;

    if (existing) await detach(id).catch(() => {});

    if (playwright) {
      try {
        const browser = await playwright.chromium.connectOverCDP(wsUrl, { timeout: attachOptions.timeoutMs || defaultTimeoutMs });
        const contexts = browser.contexts();
        const context = contexts.length ? contexts[0] : await browser.newContext();
        const pages = context.pages();
        const page = pages.length ? pages[0] : await context.newPage();
        const session = {
          profileId: id,
          wsUrl,
          engine: 'playwright',
          browser,
          page: new PlaywrightPage(browser, page),
          attachedAt: Date.now(),
          matrixSlotId: String(attachOptions.matrixSlotId || ''),
          lastError: '',
        };
        browser.on('disconnected', () => {
          if (sessions.get(id) === session) {
            sessions.delete(id);
            log(`[cdp] Profile ${id} 的浏览器已断开`);
          }
        });
        sessions.set(id, session);
        log(`[cdp] 已用 playwright 接管 ${id}`);
        return session;
      } catch (error) {
        log(`[cdp] playwright 接管失败，改用原生 CDP：${error.message}`);
      }
    }

    let conn;
    try {
      conn = await wsConnect(wsUrl, { timeoutMs: attachOptions.timeoutMs || defaultTimeoutMs });
    } catch (error) {
      throw new CdpError(`无法连接 CDP ${wsUrl}：${error.message}`, { code: 'cdp_connect_failed', cause: error });
    }
    const client = new CdpConnection(conn);
    const page = new RawCdpPage(client);
    try {
      await page.attach();
    } catch (error) {
      client.close();
      throw new CdpError(`CDP 会话初始化失败：${error.message}`, { code: 'cdp_attach_failed', cause: error });
    }
    const session = {
      profileId: id,
      wsUrl,
      engine: 'cdp',
      client,
      page,
      attachedAt: Date.now(),
      matrixSlotId: String(attachOptions.matrixSlotId || ''),
      lastError: '',
    };
    client.on('__close__', () => {
      if (sessions.get(id) === session) {
        sessions.delete(id);
        log(`[cdp] Profile ${id} 的 CDP 连接已断开`);
      }
    });
    sessions.set(id, session);
    log(`[cdp] 已用零依赖 CDP 接管 ${id}`);
    return session;
  }

  async function detach(profileId) {
    const id = String(profileId || '').trim();
    const session = sessions.get(id);
    if (!session) return false;
    sessions.delete(id);
    try { session.page.detach(); } catch { /* ignore */ }
    return true;
  }

  function getSession(profileId) {
    return sessions.get(String(profileId || '')) || null;
  }

  function listSessions() {
    return [...sessions.values()].map((session) => ({
      profileId: session.profileId,
      matrixSlotId: session.matrixSlotId,
      engine: session.engine,
      wsUrl: session.wsUrl,
      attachedAt: session.attachedAt,
      lastError: session.lastError,
    }));
  }

  function requireSession(profileId) {
    const session = getSession(profileId);
    if (!session) {
      throw new CdpError(`Profile ${profileId} 还没有被接管，先启动槽位`, {
        code: 'profile_not_attached',
        status: 409,
      });
    }
    return session;
  }

  async function observe(profileId) {
    const session = requireSession(profileId);
    try {
      const snapshot = await session.page.evaluate(SNAPSHOT_SOURCE);
      session.lastError = '';
      return snapshot;
    } catch (error) {
      session.lastError = error.message;
      throw error;
    }
  }

  async function pageInfo(profileId) {
    const session = requireSession(profileId);
    try {
      return await session.page.pageInfo();
    } catch {
      return { url: '', title: '' };
    }
  }

  async function screenshot(profileId, screenshotOptions = {}) {
    const session = requireSession(profileId);
    const base64 = await session.page.screenshot();
    const capturedAt = Date.now();
    let saved = null;
    if (store && screenshotOptions.persist !== false) {
      try {
        saved = store.saveScreenshot(session.matrixSlotId || session.profileId, base64, { extension: 'png' });
      } catch (error) {
        log(`[cdp] 截图落盘失败：${error.message}`);
      }
    }
    return {
      dataUrl: base64 ? `data:image/png;base64,${base64}` : '',
      base64,
      capturedAt,
      saved,
    };
  }

  async function resolveClickTarget(session, step) {
    if (step.ref) {
      const ok = await session.page.clickRef(step.ref);
      if (!ok && step.selector) return session.page.clickSelector(step.selector);
      if (!ok) {
        await observe(session.profileId).catch(() => {});
        const retried = await session.page.clickRef(step.ref);
        if (!retried) {
          throw new CdpError(`页面上找不到 ref ${step.ref}，请重新 page_observe`, {
            code: 'element_not_found',
            status: 409,
          });
        }
      }
      return true;
    }
    if (step.selector) return session.page.clickSelector(step.selector);
    if (Number.isFinite(Number(step.x)) && Number.isFinite(Number(step.y))) {
      await session.page.clickAt(Number(step.x), Number(step.y));
      return true;
    }
    throw new CdpError('click 需要 ref、selector 或坐标', { code: 'invalid_step', status: 400 });
  }

  async function focusTarget(session, step) {
    if (step.ref) {
      const ok = await session.page.focusRef(step.ref);
      if (!ok) {
        throw new CdpError(`页面上找不到 ref ${step.ref}，请重新 page_observe`, {
          code: 'element_not_found',
          status: 409,
        });
      }
      return;
    }
    if (step.selector) {
      await session.page.focusSelector(step.selector);
      return;
    }
    throw new CdpError('fill 需要 ref 或 selector', { code: 'invalid_step', status: 400 });
  }

  async function runStep(profileId, step, context = {}) {
    const session = requireSession(profileId);
    const action = String((step && step.action) || '').toLowerCase();
    const minMs = Number(step && step.minDelayMs) || actionOptions.minMs;
    const maxMs = Number(step && step.maxDelayMs) || actionOptions.maxMs;
    const delayKey = `${profileId}:${context.stepIndex === undefined ? 0 : context.stepIndex}:${action}`;
    const pause = () => scheduler.actionDelay(delayKey, { minMs, maxMs });
    const timeoutMs = Number(step && step.timeoutMs) || defaultTimeoutMs;

    try {
      await beforeAction(session);

      if (action === 'goto' || action === 'navigate') {
        const url = String(step.url || '').trim();
        if (!url) throw new CdpError('goto 需要 url', { code: 'invalid_step', status: 400 });
        await session.page.goto(url, timeoutMs);
        await pause();
        const info = await session.page.pageInfo();
        return { ok: true, action, url: info.url, title: info.title };
      }

      if (action === 'click') {
        await resolveClickTarget(session, step);
        await pause();
        return { ok: true, action };
      }

      if (action === 'fill') {
        await focusTarget(session, step);
        const text = String(step.text === undefined ? step.value : step.text);
        if (step.clear !== false) {
          const key = process.platform === 'darwin' ? 'Meta+A' : 'Control+A';
          await session.page.pressKey(key).catch(() => {});
          await session.page.pressKey('Backspace').catch(() => {});
        }
        for (const char of text) {
          await session.page.typeText(char);
          await scheduler.typeDelay(`${delayKey}:${char}`);
        }
        if (step.submit === true) {
          await pause();
          await session.page.pressKey('Enter');
        }
        return { ok: true, action, length: text.length };
      }

      if (action === 'press') {
        await session.page.pressKey(step.key || step.value || 'Enter');
        await pause();
        return { ok: true, action, key: String(step.key || step.value || 'Enter') };
      }

      if (action === 'scroll') {
        const snapshot = await session.page.evaluate('({ x: window.scrollX, y: window.scrollY, w: window.innerWidth, h: window.innerHeight })');
        const x = Number.isFinite(Number(step.x)) ? Number(step.x) : Math.round(snapshot.w / 2);
        const y = Number.isFinite(Number(step.y)) ? Number(step.y) : Math.round(snapshot.h / 2);
        const deltaY = Number(step.deltaY !== undefined ? step.deltaY : (step.delta !== undefined ? step.delta : 600));
        const deltaX = Number(step.deltaX) || 0;
        await session.page.scrollBy(x, y, deltaX, deltaY);
        await pause();
        return { ok: true, action, deltaX, deltaY };
      }

      if (action === 'wait') {
        if (step.for === 'selector' || step.selector) {
          const selector = String(step.value || step.selector || '');
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            const hit = await session.page.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
            if (hit) return { ok: true, action, waitedFor: 'selector', selector, elapsedMs: timeoutMs - (deadline - Date.now()) };
            if (Date.now() >= deadline) {
              throw new CdpError(`等待选择器超时：${selector}`, { code: 'wait_timeout', status: 504 });
            }
            await scheduler.sleep(150);
          }
        }
        if (step.for === 'text' || step.text !== undefined || step.contains !== undefined) {
          const needle = String(step.text !== undefined ? step.text : (step.contains !== undefined ? step.contains : step.value));
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            const hit = await session.page.evaluate(`document.body ? document.body.innerText.includes(${JSON.stringify(needle)}) : false`);
            if (hit) return { ok: true, action, waitedFor: 'text', text: needle };
            if (Date.now() >= deadline) {
              throw new CdpError(`等待文本超时：${needle}`, { code: 'wait_timeout', status: 504 });
            }
            await scheduler.sleep(150);
          }
        }
        const ms = Math.min(Number(step.ms !== undefined ? step.ms : step.timeoutMs) || 1000, 120000);
        await scheduler.sleep(ms);
        return { ok: true, action, waitedMs: ms };
      }

      if (action === 'observe' || action === 'snapshot') {
        const snapshot = await session.page.evaluate(SNAPSHOT_SOURCE);
        return {
          ok: true,
          action,
          url: snapshot.url,
          title: snapshot.title,
          elements: snapshot.elements.length,
          text: snapshot.text.slice(0, 600),
        };
      }

      if (action === 'extract') {
        const attribute = String(step.attribute || '');
        const selector = step.selector ? JSON.stringify(String(step.selector)) : 'null';
        const refName = step.ref ? JSON.stringify(String(step.ref)) : 'null';
        const all = step.multiple === true;
        const value = await session.page.evaluate(`(() => {
          const ref = ${refName};
          const selector = ${selector};
          const attr = ${JSON.stringify(attribute)};
          const all = ${all ? 'true' : 'false'};
          let root;
          if (ref) root = window.__shardxRefs && window.__shardxRefs.get(ref);
          else if (selector) root = document.querySelector(selector);
          if (!root) return null;
          const read = (el) => {
            if (attr === 'href') return el.href || el.getAttribute('href') || '';
            if (attr) return el.getAttribute(attr) || '';
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return el.value;
            return (el.innerText || el.textContent || '').trim();
          };
          if (all && selector) {
            return Array.from(document.querySelectorAll(selector)).map(read).filter((item) => item !== '');
          }
          return read(root);
        })()`);
        if (step.as) context.results[String(step.as)] = value;
        return { ok: true, action, value };
      }

      if (action === 'asserttext' || action === 'assert') {
        const needle = String(step.contains !== undefined ? step.contains : (step.text || step.value || ''));
        const present = await session.page.evaluate(`document.body ? document.body.innerText.includes(${JSON.stringify(needle)}) : false`);
        if (!present) {
          throw new CdpError(`页面未包含期望文本：${needle}`, { code: 'assertion_failed', status: 422 });
        }
        return { ok: true, action, contains: needle };
      }

      if (action === 'screenshot') {
        const shot = await screenshot(profileId, { persist: true });
        if (step.as) context.results[String(step.as)] = shot.saved ? shot.saved.path : '';
        return { ok: true, action, bytes: shot.saved ? shot.saved.bytes : shot.base64.length, path: shot.saved ? shot.saved.path : null };
      }

      if (action === 'eval') {
        const expression = String(step.expression || step.value || '');
        if (!expression) throw new CdpError('eval 需要 expression', { code: 'invalid_step', status: 400 });
        const value = await session.page.evaluate(expression);
        if (step.as) context.results[String(step.as)] = value;
        return { ok: true, action, value };
      }

      if (action === 'hover') {
        const point = await session.page.evaluate(`(() => {
          const ref = ${step.ref ? JSON.stringify(String(step.ref)) : 'null'};
          const selector = ${step.selector ? JSON.stringify(String(step.selector)) : 'null'};
          const el = ref ? (window.__shardxRefs && window.__shardxRefs.get(ref)) : (selector ? document.querySelector(selector) : null);
          if (!el) return null;
          el.scrollIntoView({ block: 'center' });
          const rect = el.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })()`);
        if (!point) throw new CdpError('hover 目标不存在', { code: 'element_not_found', status: 409 });
        if (session.engine === 'playwright') await session.page.page.mouse.move(point.x, point.y);
        else await session.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(point.x), y: Math.round(point.y), button: 'none' });
        await pause();
        return { ok: true, action };
      }

      throw new CdpError(`未知动作：${action}`, { code: 'invalid_step', status: 400 });
    } catch (error) {
      session.lastError = error.message;
      throw error;
    }
  }

  async function setCookies(profileId, cookies) {
    const session = requireSession(profileId);
    const list = Array.isArray(cookies) ? cookies : [];
    if (!list.length) return 0;
    try {
      const applied = await session.page.setCookies(list);
      session.lastError = '';
      return applied;
    } catch (error) {
      session.lastError = error.message;
      throw error;
    }
  }

  async function closeAll() {
    const ids = [...sessions.keys()];
    for (const id of ids) {
      await detach(id).catch(() => {});
    }
  }

  return {
    engine: engineName,
    hasPlaywright: Boolean(playwright),
    attach,
    detach,
    getSession,
    listSessions,
    observe,
    pageInfo,
    screenshot,
    runStep,
    setCookies,
    closeAll,
  };
}

module.exports = {
  createCdpRunner,
  CdpError,
  CdpConnection,
  RawCdpPage,
  PlaywrightPage,
  SNAPSHOT_SOURCE,
  keyDefinition,
  loadPlaywright,
  withTimeout,
};
