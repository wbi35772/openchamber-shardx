/**
 * ShardX Workspace MCP server (stdio, zero dependencies).
 *
 * OpenChamber extensions cannot register agent tools by themselves: the
 * `contributes.tools` entry only styles tool calls in the chat. The callable
 * tools live here, spoken over MCP on stdin/stdout, and drive the local ShardX
 * launcher exactly like the panel does (REST + CDP).
 *
 * Requirements: Node >= 22 (global WebSocket), a running ShardX launcher with
 * the automation API enabled. The launcher is discovered through its own
 * `%APPDATA%\shardx-launcher\settings.json`; no path or token has to be typed.
 *
 * The panel and this server share `%APPDATA%\shardx-workspace\state.json`
 * (mappings, skills, assignments, launcher path). Override with
 * SHARDX_WORKSPACE_STATE / SHARDX_LAUNCHER_SETTINGS.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8'));
const TOOLS = Array.isArray(CATALOG.tools) ? CATALOG.tools : [];
const SERVER = { name: 'shardx', version: CATALOG.version || '1.2.0' };

const API_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 90_000;
const CDP_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Launcher discovery + REST
// ---------------------------------------------------------------------------

let launcherCache = null;

function settingsPath() {
  const override = String(process.env.SHARDX_LAUNCHER_SETTINGS ?? '').trim();
  if (override) return override;
  const appData = String(process.env.APPDATA ?? '').trim();
  return appData ? `${appData}\\shardx-launcher\\settings.json` : '';
}

function loadLauncher() {
  const path = settingsPath();
  if (!path) throw new Error('APPDATA 不可用，无法定位 ShardX 配置');
  let settings;
  try {
    settings = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`读取 ShardX 配置失败（${path}）：${error instanceof Error ? error.message : String(error)}`);
  }
  const port = Number(settings.api_port);
  const secret = String(settings.api_secret ?? '').trim();
  if (!Number.isFinite(port) || port < 1 || port > 65535) throw new Error('ShardX 配置中没有有效的 api_port');
  if (!secret) throw new Error('ShardX 还没有生成 api_secret，请先在客户端开启自动化 API');
  return { port: Math.trunc(port), secret, dataRoot: String(settings.data_root ?? ''), path, raw: settings };
}

function launcher() {
  if (!launcherCache) launcherCache = loadLauncher();
  return launcherCache;
}

function mintToken(secret, ttlSeconds = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ sub: 'shardx-api', iat: now, exp: now + ttlSeconds })).toString('base64url');
  const signature = createHmac('sha256', Buffer.from(secret, 'utf8')).update(`${header}.${claims}`).digest('base64url');
  return `${header}.${claims}.${signature}`;
}

const tokenCache = { token: '', expiresAt: 0 };

function bearer() {
  const { secret } = launcher();
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt) return tokenCache.token;
  tokenCache.token = mintToken(secret);
  tokenCache.expiresAt = now + 50 * 60 * 1000;
  return tokenCache.token;
}

async function api(method, path, { query, body, timeoutMs = API_TIMEOUT_MS, retried = false } = {}) {
  const { port } = launcher();
  const url = new URL(path, `http://127.0.0.1:${port}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
  }
  const headers = { Accept: 'application/json', Authorization: `Bearer ${bearer()}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`无法连接 ShardX（http://127.0.0.1:${port}）：${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  if (response.status === 401 && !retried) {
    launcherCache = null;
    tokenCache.token = '';
    return api(method, path, { query, body, timeoutMs, retried: true });
  }
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const detail = typeof parsed === 'object' && parsed
      ? parsed.error ?? parsed.message ?? parsed.detail ?? text
      : text;
    throw new Error(`ShardX ${method} ${path} -> ${response.status} ${String(detail).slice(0, 400)}`);
  }
  return parsed;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of ['items', 'data', 'list', 'profiles', 'folders', 'proxies', 'running']) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Workspace state (shared with the panel through the bridge service)
// ---------------------------------------------------------------------------

function workspaceStatePath() {
  const override = String(process.env.SHARDX_WORKSPACE_STATE ?? '').trim();
  if (override) return override;
  const appData = String(process.env.APPDATA ?? '').trim();
  return appData
    ? join(appData, 'shardx-workspace', 'state.json')
    : join(HERE, 'workspace-state.json');
}

function normalizeSteps(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((step) => step && typeof step === 'object' && typeof step.action === 'string')
    .map((step) => ({ ...step }));
}

function normalizeSkill(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '').trim();
  if (!id) return null;
  return {
    ...raw,
    id,
    name: String(raw.name ?? id),
    site: String(raw.site ?? ''),
    url_pattern: String(raw.url_pattern ?? ''),
    description: String(raw.description ?? ''),
    steps: normalizeSteps(raw.steps),
    created_at: Number(raw.created_at) || Date.now(),
    updated_at: Number(raw.updated_at) || Date.now(),
  };
}

function normalizeWorkspaceState(raw) {
  const base = raw && typeof raw === 'object' ? raw : {};
  const mappings = Array.isArray(base.mappings) ? base.mappings : [];
  const skills = Array.isArray(base.skills) ? base.skills : [];
  const assignments = Array.isArray(base.assignments) ? base.assignments : [];
  return {
    ...base,
    version: Number(base.version) || 1,
    mappings: mappings
      .filter((item) => item && typeof item === 'object' && item.profile_id)
      .map((item) => ({
        ...item,
        profile_id: String(item.profile_id),
        profile_name: String(item.profile_name ?? item.profile_id),
        session_id: String(item.session_id ?? ''),
        source: String(item.source ?? ''),
        updated_at: Number(item.updated_at) || Date.now(),
      })),
    skills: skills.map(normalizeSkill).filter(Boolean),
    assignments: assignments
      .filter((item) => item && typeof item === 'object' && item.skill_id && item.target_type && item.target_id)
      .map((item) => ({
        ...item,
        skill_id: String(item.skill_id),
        target_type: item.target_type === 'folder' ? 'folder' : 'profile',
        target_id: String(item.target_id),
        created_at: Number(item.created_at) || Date.now(),
      })),
    settings: {
      ...(base.settings && typeof base.settings === 'object' ? base.settings : {}),
      launcher_path: String(base.settings?.launcher_path ?? ''),
    },
  };
}

function readWorkspaceState() {
  try {
    return normalizeWorkspaceState(JSON.parse(readFileSync(workspaceStatePath(), 'utf8')));
  } catch {
    return normalizeWorkspaceState({});
  }
}

function writeWorkspaceState(state) {
  const file = workspaceStatePath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  try {
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw error;
  }
  return state;
}

function saveMapping(profileId, profileName, sessionId, source = 'mcp') {
  const state = readWorkspaceState();
  state.mappings = state.mappings.filter((item) => item.profile_id !== profileId);
  state.mappings.push({
    profile_id: profileId,
    profile_name: profileName || profileId,
    session_id: sessionId,
    source,
    updated_at: Date.now(),
  });
  return writeWorkspaceState(state);
}

function removeMapping(profileId, sessionId = '') {
  const state = readWorkspaceState();
  state.mappings = state.mappings.filter((item) => {
    if (item.profile_id !== profileId) return true;
    if (sessionId && item.session_id !== sessionId) return true;
    return false;
  });
  return writeWorkspaceState(state);
}

function skillsForProfile(state, profileId, folder = '') {
  const ids = new Set(
    state.assignments
      .filter(
        (item) =>
          (item.target_type === 'profile' && item.target_id === profileId) ||
          (item.target_type === 'folder' && folder && item.target_id === folder),
      )
      .map((item) => item.skill_id),
  );
  return state.skills.filter((skill) => ids.has(skill.id));
}

// ---------------------------------------------------------------------------
// Minimal CDP client (one socket per attached profile)
// ---------------------------------------------------------------------------

class Cdp {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #closed = false;
  #closeReason = '';

  static async open(url, timeoutMs = 15_000) {
    if (typeof WebSocket === 'undefined') {
      throw new Error('当前 Node 运行时没有全局 WebSocket（需要 Node >= 22）');
    }
    const cdp = new Cdp();
    cdp.#ws = new WebSocket(url);
    cdp.#ws.addEventListener('message', (event) => cdp.#dispatch(event.data));
    cdp.#ws.addEventListener('close', () => {
      cdp.#closed = cdp.#closed || true;
      cdp.#closeReason = 'CDP 连接已关闭';
      for (const pending of cdp.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(cdp.#closeReason));
      }
      cdp.#pending.clear();
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接 CDP 超时')), timeoutMs);
      cdp.#ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      cdp.#ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('连接 CDP 失败'));
      }, { once: true });
    });
    return cdp;
  }

  #dispatch(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (typeof message.id === 'number') {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message ?? 'CDP 错误'}`));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method === 'string') {
      const key = message.method;
      const set = this.#listeners.get(key);
      if (set) for (const fn of [...set]) {
        try {
          fn(message.params ?? {}, message.sessionId ?? null);
        } catch {
          /* listener failure never breaks the socket */
        }
      }
    }
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = CDP_TIMEOUT_MS) {
    if (this.#closed || this.#ws.readyState !== 1) {
      return Promise.reject(new Error(this.#closeReason || 'CDP 未连接'));
    }
    const id = this.#nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP 命令超时：${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      try {
        this.#ws.send(JSON.stringify(message));
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  waitFor(method, predicate = null, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const set = this.#listeners.get(method) ?? new Set();
      this.#listeners.set(method, set);
      const handler = (params, sessionId) => {
        if (predicate && !predicate(params, sessionId)) return;
        clearTimeout(timer);
        set.delete(handler);
        resolve(params);
      };
      set.add(handler);
      const timer = setTimeout(() => {
        set.delete(handler);
        reject(new Error(`等待事件超时：${method}`));
      }, timeoutMs);
    });
  }

  close() {
    this.#closed = true;
    try {
      this.#ws.close();
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// Instance registry (one profile can be held by a single session; a session
// may hold several profiles, as long as every instance gets its own tab in
// the panel)
// ---------------------------------------------------------------------------

const instances = new Map();

function sessionIdOf(args) {
  const id = String(args?.session_id ?? '').trim();
  return id || 'default';
}

function shortId(id) {
  const text = String(id ?? '');
  return text.length <= 14 ? text : `${text.slice(0, 6)}…${text.slice(-4)}`;
}

function ownedBy(sessionId) {
  return [...instances.values()].filter((instance) => instance.sessionId === sessionId);
}

function requireInstance(args) {
  const sessionId = sessionIdOf(args);
  const profileId = String(args?.profile_id ?? '').trim();
  if (profileId) {
    const instance = instances.get(profileId);
    if (!instance) {
      throw new Error(`Profile ${profileId} 还没有被 MCP 接管。调用 list_and_bind_profile 或 session_attach 先接管。`);
    }
    if (instance.sessionId !== sessionId) {
      throw new Error(`Profile ${profileId} 正被会话 ${instance.sessionId} 独占，不能从会话 ${sessionId} 操作。`);
    }
    return instance;
  }
  const owned = ownedBy(sessionId);
  if (owned.length === 0) {
    throw new Error(`会话 ${sessionId} 还没有绑定浏览器。先调用 list_and_bind_profile（action=bind 或 auto-bind）或 session_attach。`);
  }
  if (owned.length > 1) {
    const list = owned.map((item) => `${item.name} [${item.profileId}]`).join('、');
    throw new Error(`会话 ${sessionId} 有多个实例：${list}。请传 profile_id 指明要操作哪一个。`);
  }
  return owned[0];
}

async function attachPage(cdp) {
  const { targetInfos = [] } = await cdp.send('Target.getTargets', {});
  const pages = targetInfos.filter((target) => target.type === 'page');
  const page = pages.find((target) => target.url && !target.url.startsWith('chrome://')) ?? pages[0];
  if (!page) throw new Error('实例里没有可用的页面目标');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable', 'DOM.enable']) {
    await cdp.send(method, {}, sessionId).catch(() => {});
  }
  return sessionId;
}

function wsUrlOf(started) {
  const cdp = started?.cdp ?? {};
  return started?.cdp?.web_socket_debugger_url
    ?? started?.cdp?.webSocketDebuggerUrl
    ?? started?.web_socket_debugger_url
    ?? started?.webSocketDebuggerUrl
    ?? cdp.ws_url
    ?? started?.wsUrl;
}

async function startProfile(profileId) {
  try {
    return await api('POST', `/profiles/${encodeURIComponent(profileId)}/start`, { timeoutMs: START_TIMEOUT_MS });
  } catch (error) {
    const running = await api('GET', '/running').catch(() => null);
    const list = asArray(running);
    const hit = list.find((item) => item?.id === profileId || item?.profile_id === profileId);
    if (hit) return hit;
    throw error;
  }
}

async function startOrFindRunning(profileId) {
  const running = await api('GET', '/running').catch(() => null);
  const hit = asArray(running).find((item) => item?.id === profileId || item?.profile_id === profileId);
  if (hit && wsUrlOf(hit)) return hit;
  return startProfile(profileId);
}

async function profileName(profileId) {
  try {
    const profile = await api('GET', `/profiles/${encodeURIComponent(profileId)}`);
    return String(profile?.name ?? '') || profileId;
  } catch {
    return profileId;
  }
}

async function openInstance(sessionId, profileId, name, started, source) {
  const url = wsUrlOf(started);
  if (!url) throw new Error('启动响应里没有 cdp.web_socket_debugger_url');
  const cdp = await Cdp.open(url);
  const pageSession = await attachPage(cdp);
  const instance = {
    sessionId,
    profileId,
    name: name || profileId,
    cdp,
    pageSession,
    startedAt: Date.now(),
    source,
  };
  instances.set(profileId, instance);
  saveMapping(profileId, instance.name, sessionId, source);
  return instance;
}

async function bind(sessionId, profileId, name) {
  const holder = instances.get(profileId);
  if (holder) {
    if (holder.sessionId !== sessionId) {
      throw new Error(`Profile ${profileId} 正被会话 ${holder.sessionId} 独占，先让那个会话 session_stop_and_release。`);
    }
    return holder;
  }
  const started = await startProfile(profileId);
  return openInstance(sessionId, profileId, name, started, 'mcp');
}

async function attachRunning(sessionId, profileId, name) {
  const holder = instances.get(profileId);
  if (holder) {
    if (holder.sessionId !== sessionId) {
      throw new Error(`Profile ${profileId} 正被会话 ${holder.sessionId} 独占，先让那个会话 session_stop_and_release。`);
    }
    return holder;
  }
  const started = await startOrFindRunning(profileId);
  return openInstance(sessionId, profileId, name, started, 'mcp-attach');
}

async function release(sessionId, profileId = '') {
  const targets = profileId
    ? [instances.get(profileId)].filter(Boolean)
    : ownedBy(sessionId);
  const released = [];
  for (const instance of targets) {
    if (instance.sessionId !== sessionId) {
      throw new Error(`Profile ${instance.profileId} 属于会话 ${instance.sessionId}，不能从会话 ${sessionId} 关闭。`);
    }
    instances.delete(instance.profileId);
    try {
      instance.cdp.close();
    } catch {
      /* ignore */
    }
    try {
      await api('POST', `/profiles/${encodeURIComponent(instance.profileId)}/stop`);
    } catch {
      /* the browser may already be gone */
    }
    removeMapping(instance.profileId, sessionId);
    released.push(instance.profileId);
  }
  return released;
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '页面脚本异常';
    throw new Error(String(detail));
  }
  return result.result?.value;
}

function selectorExpr(selector) {
  return selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document.body';
}

const MARKDOWN_FN = `(() => {
  const root = SEL;
  if (!root) return '';
  const out = [];
  const push = (value) => {
    const text = String(value ?? '').replace(/\\s+/g, ' ').trim();
    if (text) out.push(text);
  };
  const block = (tag) => ['p','div','section','article','header','footer','nav','main','table','ul','ol','tr'].includes(tag);
  const walk = (node) => {
    if (!node) return;
    if (node.nodeType === 3) { push(node.nodeValue); return; }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (['script','style','noscript','svg','template','iframe'].includes(tag)) return;
    if (/^h[1-6]$/.test(tag)) {
      out.push('#'.repeat(Number(tag[1])) + ' ' + (node.innerText || '').replace(/\\s+/g, ' ').trim());
      return;
    }
    if (tag === 'a') { out.push('[' + (node.innerText || '').replace(/\\s+/g,' ').trim() + '](' + (node.getAttribute('href') || '') + ')'); return; }
    if (tag === 'img') { out.push('![' + (node.getAttribute('alt') || '') + '](' + (node.getAttribute('src') || '') + ')'); return; }
    if (tag === 'li') { out.push('- ' + (node.innerText || '').replace(/\\s+/g,' ').trim()); return; }
    if (tag === 'br') { out.push(''); return; }
    if (block(tag)) out.push('');
    for (const child of node.childNodes) walk(child);
    if (block(tag)) out.push('');
  };
  walk(root);
  return out.join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
})()`;

const FORMS_FN = `(() => {
  const root = SEL || document;
  if (!root) return '[]';
  const items = [];
  for (const element of root.querySelectorAll('input,textarea,select,button')) {
    items.push({
      tag: element.tagName.toLowerCase(),
      type: element.type || '',
      name: element.name || '',
      id: element.id || '',
      placeholder: element.placeholder || '',
      label: element.labels && element.labels[0] ? (element.labels[0].innerText || '').trim() : '',
      required: Boolean(element.required),
      disabled: Boolean(element.disabled),
      value: element.type === 'password' ? '' : (element.value || '')
    });
  }
  return JSON.stringify(items, null, 2);
})()`;

async function boxOf(cdp, sessionId, selector) {
  const expression = `(() => {
    const element = ${selectorExpr(selector)};
    if (!element || typeof element.getBoundingClientRect !== 'function') return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    if (!rect || rect.width < 1 || rect.height < 1) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`;
  return evaluate(cdp, sessionId, expression);
}

async function clickPoint(cdp, sessionId, x, y) {
  const base = { x, y, button: 'left', clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base }, sessionId);
}

async function click(cdp, sessionId, args) {
  if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y)) && args.x !== undefined && args.y !== undefined) {
    const x = Number(args.x);
    const y = Number(args.y);
    await clickPoint(cdp, sessionId, x, y);
    return { clicked: { x, y } };
  }
  if (!args.selector) throw new Error('click 需要 selector 或 x/y');
  const box = await boxOf(cdp, sessionId, args.selector);
  if (box) {
    await clickPoint(cdp, sessionId, box.x, box.y);
    return { clicked: { selector: args.selector, x: box.x, y: box.y } };
  }
  const fallback = await evaluate(cdp, sessionId, `(() => {
    const element = ${selectorExpr(args.selector)};
    if (!element) return false;
    element.click();
    return true;
  })()`);
  if (!fallback) throw new Error(`找不到可点击的元素：${args.selector}`);
  return { clicked: { selector: args.selector, via: 'element.click()' } };
}

async function typeText(cdp, sessionId, args) {
  if (!args.selector) throw new Error('type 需要 selector');
  const focused = await evaluate(cdp, sessionId, `(() => {
    const element = ${selectorExpr(args.selector)};
    if (!element) return false;
    element.focus();
    if (typeof element.select === 'function' && element.tagName !== 'SELECT') element.select();
    return document.activeElement === element;
  })()`);
  if (!focused) throw new Error(`无法聚焦元素：${args.selector}`);
  const text = String(args.text ?? args.value ?? '');
  await cdp.send('Input.insertText', { text }, sessionId);
  return { typed: text.length, selector: args.selector };
}

async function scroll(cdp, sessionId, args) {
  if (args.selector) {
    await evaluate(cdp, sessionId, `(() => {
      const element = ${selectorExpr(args.selector)};
      if (!element) return false;
      element.scrollIntoView({ block: 'start', behavior: 'instant' });
      return true;
    })()`);
    return { scrolled: { selector: args.selector } };
  }
  const delta = Number.isFinite(Number(args.y)) ? Number(args.y) : 600;
  await evaluate(cdp, sessionId, `window.scrollBy(0, ${delta})`);
  return { scrolled: delta };
}

async function extractValue(cdp, sessionId, { selector = '', mode = 'markdown' } = {}) {
  if (mode === 'html') {
    return String(await evaluate(cdp, sessionId, `(() => {
      const element = ${selectorExpr(selector)};
      return element ? element.outerHTML : '';
    })()`) ?? '');
  }
  if (mode === 'text') {
    return String(await evaluate(cdp, sessionId, `(() => {
      const element = ${selectorExpr(selector)};
      return element ? element.innerText : '';
    })()`) ?? '');
  }
  if (mode === 'forms') {
    return String(await evaluate(cdp, sessionId, FORMS_FN.replace('SEL', selectorExpr(selector))) ?? '[]');
  }
  return String(await evaluate(cdp, sessionId, MARKDOWN_FN.replace('SEL', selectorExpr(selector))) ?? '');
}

async function runSkillOnInstance(instance, steps) {
  const results = [];
  const { cdp, pageSession } = instance;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index] ?? {};
    const action = String(step.action ?? '');
    try {
      let result;
      if (action === 'navigate') {
        const url = String(step.url ?? '').trim();
        if (!url) throw new Error('navigate 缺少 url');
        const settled = cdp.waitFor('Page.loadEventFired', null, 45_000);
        const navigation = await cdp.send('Page.navigate', { url }, pageSession, 45_000);
        if (navigation.errorText) throw new Error(`导航失败：${navigation.errorText}`);
        await settled.catch(() => {});
        result = { url };
      } else if (action === 'reload') {
        const settled = cdp.waitFor('Page.loadEventFired', null, 45_000);
        await cdp.send('Page.reload', {}, pageSession, 45_000);
        await settled.catch(() => {});
        result = { reloaded: true };
      } else if (action === 'wait') {
        if (step.selector) {
          const timeout = Number(step.timeout_ms) > 0 ? Number(step.timeout_ms) : 30_000;
          const deadline = Date.now() + timeout;
          let found = false;
          while (Date.now() < deadline) {
            found = Boolean(await evaluate(cdp, pageSession, `!!document.querySelector(${JSON.stringify(String(step.selector))})`));
            if (found) break;
            await sleep(250);
          }
          if (!found) throw new Error(`等待元素超时：${step.selector}`);
          result = { selector: String(step.selector), found: true };
        } else {
          const ms = Math.max(0, Number(step.ms ?? 1000));
          await sleep(ms);
          result = { waited: ms };
        }
      } else if (action === 'click') {
        result = await click(cdp, pageSession, step);
      } else if (action === 'type') {
        result = await typeText(cdp, pageSession, step);
      } else if (action === 'evaluate') {
        const script = String(step.script ?? step.expression ?? '').trim();
        if (!script) throw new Error('evaluate 缺少 script');
        const value = await evaluate(cdp, pageSession, script);
        result = value === undefined ? null : value;
      } else if (action === 'extract') {
        const mode = String(step.mode ?? 'text');
        const selector = String(step.selector ?? '');
        const value = await extractValue(cdp, pageSession, { selector, mode });
        result = { mode, selector, value };
      } else {
        throw new Error(`未知步骤 action：${action}`);
      }
      results.push({ index, action, ok: true, result });
    } catch (error) {
      results.push({ index, action, ok: false, error: error instanceof Error ? error.message : String(error) });
      break;
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Launcher process discovery and control
// ---------------------------------------------------------------------------

async function listLauncherProcesses(launcherPath = '') {
  if (process.platform !== 'win32') return [];
  const escaped = String(launcherPath ?? '').replace(/'/g, "''");
  const filter = escaped
    ? `$_.ExecutablePath -eq '${escaped}' -or $_.Name -like 'ShardBrowser*' -or $_.Name -like 'shardx*'`
    : `$_.Name -like 'ShardBrowser*' -or $_.Name -like 'shardx*'`;
  const script = `$items = Get-CimInstance Win32_Process | Where-Object { ${filter} } | Select-Object ProcessId,ExecutablePath,CommandLine; $items | ConvertTo-Json -Compress`;
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 8000, maxBuffer: 2 * 1024 * 1024 },
    );
    const trimmed = String(stdout ?? '').trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .map((row) => ({
        pid: Number(row.ProcessId),
        path: String(row.ExecutablePath ?? ''),
        command: String(row.CommandLine ?? ''),
      }))
      .filter((row) => Number.isFinite(row.pid));
  } catch {
    return [];
  }
}

async function stopLauncher(launcherPath = '') {
  const processes = await listLauncherProcesses(launcherPath);
  for (const item of processes) {
    try {
      process.kill(item.pid, 'SIGTERM');
    } catch {
      try {
        await execFileAsync('taskkill.exe', ['/PID', String(item.pid), '/T', '/F'], { windowsHide: true });
      } catch {
        /* process already gone */
      }
    }
  }
  return processes;
}

async function probeHealth(port, timeoutMs = 2000) {
  if (!port) return { ok: false, body: null };
  try {
    const response = await fetch(`http://127.0.0.1:${Math.trunc(port)}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, body };
  } catch {
    return { ok: false, body: null };
  }
}

async function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { ok } = await probeHealth(port, 2500);
    if (ok) return true;
    await sleep(500);
  }
  return false;
}

async function serverStatus() {
  const path = settingsPath();
  let raw = null;
  let parseError = '';
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }
  const state = readWorkspaceState();
  const port = Number(raw?.api_port) || 0;
  const apiEnabled = Boolean(String(raw?.api_secret ?? '').trim());
  const processes = await listLauncherProcesses(state.settings.launcher_path);
  const launcherPath = state.settings.launcher_path || processes[0]?.path || '';
  const health = await probeHealth(port);
  const version = String(health.body?.version ?? raw?.version ?? '');
  return {
    found: Boolean(raw),
    running: health.ok,
    version: version || null,
    port: port || null,
    apiEnabled,
    dataRoot: String(raw?.data_root ?? ''),
    settingsPath: path,
    launcherPath,
    processes,
    statePath: workspaceStatePath(),
    error: raw ? undefined : parseError || '未找到 ShardX 启动器设置',
  };
}

async function controlServer(action, launcherPath) {
  const status = await serverStatus();
  const port = status.port || launcherCache?.port || 0;
  const path = String(launcherPath ?? '').trim() || status.launcherPath;
  let stopped = [];
  if (action === 'stop' || action === 'restart') {
    stopped = await stopLauncher(path);
    await sleep(600);
  }
  let started = false;
  if (action === 'start' || action === 'restart') {
    if (!path) {
      throw new Error('没有启动器路径。先调用 workspace_state（action=settings）保存 launcher_path，或在 server_control 里传 launcher_path。');
    }
    if (!existsSync(path)) throw new Error(`启动器不存在：${path}`);
    const child = spawn(path, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    let healthPort = port;
    for (let attempt = 0; attempt < 20 && !healthPort; attempt += 1) {
      await sleep(500);
      launcherCache = null;
      try {
        healthPort = launcher().port;
      } catch {
        /* settings not written yet */
      }
    }
    started = healthPort ? await waitForHealth(healthPort, 20_000) : false;
  }
  const after = await serverStatus();
  return { action, stopped, started, ...after };
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function formatProfiles(profiles, live, mappings) {
  const rows = profiles.map((profile, index) => {
    const session = live.get(profile.id);
    const mapping = mappings.get(profile.id);
    const flags = [
      profile.status ? String(profile.status) : '',
      session ? `MCP 会话 ${shortId(session)}` : '',
      !session && mapping ? `映射 ${shortId(mapping.session_id)}` : '',
    ].filter(Boolean).join(' · ');
    return `${index + 1}. ${profile.name ?? '(未命名)'}  [${profile.id}]${flags ? `  ${flags}` : ''}${profile.folder ? `  /${profile.folder}` : ''}`;
  });
  return `${profiles.length} 个指纹环境\n${rows.join('\n')}`;
}

async function toolListAndBind(args) {
  const action = String(args.action ?? 'list');
  const live = new Map([...instances.values()].map((instance) => [instance.profileId, instance.sessionId]));
  const mappings = new Map(readWorkspaceState().mappings.map((item) => [item.profile_id, item]));

  if (action === 'list') {
    const profiles = await api('GET', '/profiles', { query: args.folder ? { folder: args.folder } : undefined });
    return formatProfiles(asArray(profiles), live, mappings);
  }

  if (action === 'bind') {
    const profileId = String(args.profile_id ?? '').trim();
    if (!profileId) throw new Error('action=bind 需要 profile_id');
    const name = await profileName(profileId);
    const session = await bind(sessionIdOf(args), profileId, name);
    const owned = ownedBy(session.sessionId).length;
    return `已绑定并启动：${session.name}\nprofile_id: ${profileId}\nsession_id: ${session.sessionId}\n该会话现在有 ${owned} 个实例${owned > 1 ? '（每个实例在面板里各占一个标签）' : ''}\nCDP page session: ${session.pageSession}`;
  }

  if (action === 'auto-bind') {
    const profiles = await api('GET', '/profiles');
    const list = asArray(profiles);
    const busy = new Set(live.keys());
    for (const profile of list) {
      if (busy.has(profile.id)) continue;
      if (String(profile.status ?? '').toLowerCase() === 'running') continue;
      const name = String(profile.name ?? '') || profile.id;
      const instance = await bind(sessionIdOf(args), profile.id, name);
      return `已自动绑定：${instance.name}\nprofile_id: ${profile.id}\nsession_id: ${instance.sessionId}`;
    }
    throw new Error('没有空闲的 profile 可自动绑定');
  }

  throw new Error(`未知 action：${action}`);
}

async function toolSessionAttach(args) {
  const sessionId = sessionIdOf(args);
  const profileId = String(args.profile_id ?? '').trim();
  if (!profileId) throw new Error('session_attach 需要 profile_id');
  const name = String(args.name ?? '').trim() || (await profileName(profileId));
  const existing = instances.get(profileId);
  const instance = await attachRunning(sessionId, profileId, name);
  const owned = ownedBy(sessionId).length;
  return `${existing ? '已复用' : '已接管'}实例：${instance.name}\nprofile_id: ${profileId}\nsession_id: ${sessionId}\n该会话现在有 ${owned} 个实例\nCDP page session: ${instance.pageSession}`;
}

async function toolNavigate(args) {
  const instance = requireInstance(args);
  const url = String(args.url ?? '').trim();
  if (!url) throw new Error('navigate 需要 url');
  const waitUntil = String(args.wait_until ?? 'networkidle');
  const cdp = instance.cdp;

  let settled = Promise.resolve();
  if (waitUntil === 'load' || waitUntil === 'networkidle') {
    settled = cdp.waitFor('Page.loadEventFired', null, 45_000);
  } else {
    settled = cdp.waitFor('Page.domContentEventFired', null, 45_000);
  }
  const navigation = await cdp.send('Page.navigate', { url }, instance.pageSession, 45_000);
  if (navigation.errorText) throw new Error(`导航失败：${navigation.errorText}`);
  await settled.catch(() => {});
  if (waitUntil === 'networkidle') await sleep(700);

  const info = await evaluate(cdp, instance.pageSession, '({ url: location.href, title: document.title })');
  return `已打开 ${info?.url ?? url}\n标题：${info?.title ?? ''}`;
}

async function toolInteract(args) {
  const instance = requireInstance(args);
  const action = String(args.action ?? '');
  const cdp = instance.cdp;
  const sid = instance.pageSession;

  if (action === 'click') {
    const result = await click(cdp, sid, args);
    return `click 完成 ${JSON.stringify(result.clicked)}`;
  }
  if (action === 'type') {
    const result = await typeText(cdp, sid, args);
    return `已向 ${result.selector} 输入 ${result.typed} 个字符`;
  }
  if (action === 'scroll') {
    const result = await scroll(cdp, sid, args);
    return `scroll 完成 ${JSON.stringify(result.scrolled)}`;
  }
  if (action === 'evaluate_js') {
    const script = String(args.script ?? '').trim();
    if (!script) throw new Error('evaluate_js 需要 script');
    const value = await evaluate(cdp, sid, script);
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  }
  throw new Error(`未知 action：${action}`);
}

async function toolExtract(args) {
  const instance = requireInstance(args);
  const mode = String(args.mode ?? 'markdown');
  const selector = args.selector ? String(args.selector) : '';
  return extractValue(instance.cdp, instance.pageSession, { selector, mode });
}

async function toolCookies(args) {
  const instance = requireInstance(args);
  const action = String(args.action ?? 'get');
  const cdp = instance.cdp;
  const sid = instance.pageSession;

  if (action === 'get') {
    const { cookies = [] } = await cdp.send('Storage.getCookies', {}, sid);
    return JSON.stringify(cookies, null, 2);
  }
  if (action === 'set') {
    let cookies;
    try {
      cookies = JSON.parse(String(args.cookies_json ?? '[]'));
    } catch {
      throw new Error('cookies_json 不是合法 JSON');
    }
    if (!Array.isArray(cookies)) throw new Error('cookies_json 必须是数组');
    await cdp.send('Network.setCookies', { cookies }, sid);
    return `已注入 ${cookies.length} 个 Cookie`;
  }
  if (action === 'clear') {
    await cdp.send('Network.clearBrowserCookies', {}, sid);
    return '已清空当前实例 Cookie';
  }
  throw new Error(`未知 action：${action}`);
}

async function toolStop(args) {
  const sessionId = sessionIdOf(args);
  const profileId = String(args.profile_id ?? '').trim();
  const released = await release(sessionId, profileId);
  if (released.length === 0) {
    return profileId
      ? `会话 ${sessionId} 没有接管 profile ${profileId}`
      : `会话 ${sessionId} 没有绑定实例`;
  }
  return `已关闭并释放：${released.join(', ')}（会话 ${sessionId}）`;
}

function formatState(state) {
  return JSON.stringify(
    {
      statePath: workspaceStatePath(),
      mappings: state.mappings,
      skills: state.skills,
      assignments: state.assignments,
      settings: state.settings,
    },
    null,
    2,
  );
}

async function toolWorkspaceState(args) {
  const action = String(args.action ?? 'get');
  if (action === 'get') return formatState(readWorkspaceState());

  if (action === 'mapping') {
    const profileId = String(args.profile_id ?? '').trim();
    const sessionId = String(args.session_id ?? '').trim();
    if (!profileId || !sessionId) throw new Error('action=mapping 需要 profile_id 与 session_id');
    const name = String(args.profile_name ?? '').trim() || (await profileName(profileId));
    const state = saveMapping(profileId, name, sessionId, String(args.source ?? 'mcp'));
    return formatState(state);
  }

  if (action === 'unmap') {
    const profileId = String(args.profile_id ?? '').trim();
    if (!profileId) throw new Error('action=unmap 需要 profile_id');
    const state = removeMapping(profileId, String(args.session_id ?? '').trim());
    return formatState(state);
  }

  if (action === 'settings') {
    const state = readWorkspaceState();
    if (args.launcher_path !== undefined) state.settings.launcher_path = String(args.launcher_path ?? '').trim();
    writeWorkspaceState(state);
    return formatState(state);
  }

  throw new Error(`未知 action：${action}`);
}

async function toolSkillList(args) {
  const state = readWorkspaceState();
  const query = String(args.query ?? '').trim().toLowerCase();
  const skills = state.skills.filter((skill) => {
    if (!query) return true;
    return [skill.name, skill.site, skill.url_pattern, skill.description, skill.id]
      .join(' ')
      .toLowerCase()
      .includes(query);
  });
  const profileId = String(args.profile_id ?? '').trim();
  const folder = String(args.folder ?? '').trim();
  return JSON.stringify(
    {
      count: skills.length,
      skills,
      assignments: state.assignments,
      effective: profileId || folder ? skillsForProfile(state, profileId, folder) : undefined,
    },
    null,
    2,
  );
}

async function toolSkillSave(args) {
  let input = args.skill && typeof args.skill === 'object' ? args.skill : args;
  if (typeof args.skill_json === 'string' && args.skill_json.trim()) {
    try {
      input = JSON.parse(args.skill_json);
    } catch (error) {
      throw new Error(`skill_json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('Skill 名称不能为空');
  const state = readWorkspaceState();
  const requestedId = String(input.id ?? '').trim();
  const id = requestedId || `skill-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const existing = state.skills.find((skill) => skill.id === id) ?? null;
  const now = Date.now();
  const record = {
    id,
    name,
    site: String(input.site ?? '').trim(),
    url_pattern: String(input.url_pattern ?? '').trim(),
    description: String(input.description ?? '').trim(),
    steps: normalizeSteps(input.steps),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  state.skills = [...state.skills.filter((skill) => skill.id !== id), record];
  writeWorkspaceState(state);
  return JSON.stringify({ skill: record, statePath: workspaceStatePath() }, null, 2);
}

async function toolSkillAssign(args) {
  const skillId = String(args.skill_id ?? '').trim();
  const targetType = String(args.target_type ?? 'profile');
  const targetId = String(args.target_id ?? '').trim();
  if (!skillId) throw new Error('skill_assign 需要 skill_id');
  if (targetType !== 'profile' && targetType !== 'folder') throw new Error('target_type 只能是 profile 或 folder');
  if (!targetId) throw new Error('skill_assign 需要 target_id');
  const state = readWorkspaceState();
  if (!state.skills.some((skill) => skill.id === skillId)) throw new Error(`没有这个 Skill：${skillId}`);
  const remove = Boolean(args.remove);
  state.assignments = state.assignments.filter(
    (item) => !(item.skill_id === skillId && item.target_type === targetType && item.target_id === targetId),
  );
  if (!remove) {
    state.assignments.push({ skill_id: skillId, target_type: targetType, target_id: targetId, created_at: Date.now() });
  }
  writeWorkspaceState(state);
  return JSON.stringify(
    { removed: remove, assignments: state.assignments.filter((item) => item.skill_id === skillId) },
    null,
    2,
  );
}

async function toolSkillRun(args) {
  const skillId = String(args.skill_id ?? '').trim();
  if (!skillId) throw new Error('skill_run 需要 skill_id');
  const state = readWorkspaceState();
  const skill = state.skills.find((item) => item.id === skillId);
  if (!skill) throw new Error(`没有这个 Skill：${skillId}`);
  const instance = requireInstance(args);
  const results = await runSkillOnInstance(instance, skill.steps);
  const ok = results.every((step) => step.ok !== false);
  return JSON.stringify(
    {
      skill_id: skill.id,
      skill: skill.name,
      profile_id: instance.profileId,
      session_id: instance.sessionId,
      ok,
      steps: results,
    },
    null,
    2,
  );
}

async function toolServerStatus() {
  return JSON.stringify(await serverStatus(), null, 2);
}

async function toolServerControl(args) {
  const action = String(args.action ?? '').trim();
  if (action !== 'start' && action !== 'stop' && action !== 'restart') {
    throw new Error('action 只能是 start / stop / restart');
  }
  const result = await controlServer(action, args.launcher_path);
  return JSON.stringify(result, null, 2);
}

async function toolServerSync() {
  const status = await serverStatus();
  const [profiles, folders, proxies, running] = await Promise.all([
    api('GET', '/profiles').catch(() => []),
    api('GET', '/folders').catch(() => []),
    api('GET', '/proxies').catch(() => []),
    api('GET', '/running').catch(() => []),
  ]);
  const profileList = asArray(profiles);
  const folderList = asArray(folders);
  const proxyList = asArray(proxies);
  const runningList = asArray(running);
  return JSON.stringify(
    {
      syncedAt: Date.now(),
      version: status.version,
      port: status.port,
      dataRoot: status.dataRoot,
      profileCount: profileList.length,
      folderCount: folderList.length,
      proxyCount: proxyList.length,
      runningCount: runningList.length,
      profiles: profileList,
      folders: folderList,
      proxies: proxyList,
      running: runningList,
    },
    null,
    2,
  );
}

const HANDLERS = {
  list_and_bind_profile: toolListAndBind,
  session_attach: toolSessionAttach,
  session_navigate: toolNavigate,
  session_interact: toolInteract,
  session_extract_dom: toolExtract,
  session_manage_cookies: toolCookies,
  session_stop_and_release: toolStop,
  workspace_state: toolWorkspaceState,
  skill_list: toolSkillList,
  skill_save: toolSkillSave,
  skill_assign: toolSkillAssign,
  skill_run: toolSkillRun,
  server_status: toolServerStatus,
  server_control: toolServerControl,
  server_sync: toolServerSync,
};

// ---------------------------------------------------------------------------
// MCP stdio protocol
// ---------------------------------------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(message) {
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER,
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') {
    if (!isNotification) reply(id, {});
    return;
  }
  if (method === 'tools/list') {
    reply(id, {
      tools: TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
      })),
    });
    return;
  }
  if (method === 'tools/call') {
    const name = String(params?.name ?? '');
    const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    const handler = HANDLERS[name];
    if (!handler) {
      replyError(id, -32602, `未知工具：${name}`);
      return;
    }
    try {
      const text = await handler(args);
      reply(id, { content: [{ type: 'text', text: String(text) }] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply(id, { content: [{ type: 'text', text: message }], isError: true });
    }
    return;
  }
  if (method === 'resources/list') {
    reply(id, { resources: [] });
    return;
  }
  if (method === 'prompts/list') {
    reply(id, { prompts: [] });
    return;
  }
  if (!isNotification) replyError(id, -32601, `不支持的方法：${method}`);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (!message || typeof message !== 'object' || !message.method) return;
  void handle(message).catch((error) => {
    const id = message.id;
    if (id !== undefined && id !== null) {
      replyError(id, -32603, error instanceof Error ? error.message : String(error));
    } else {
      process.stderr.write(`[shardx-mcp] ${error instanceof Error ? error.stack : String(error)}\n`);
    }
  });
});

function shutdown() {
  for (const instance of instances.values()) {
    try {
      instance.cdp.close();
    } catch {
      /* ignore */
    }
  }
  instances.clear();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
input.on('close', shutdown);
