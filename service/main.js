'use strict';

/*
 * ShardX matrix service (`127.0.0.1:19884`).
 *
 * One process owns every browser slot: it leases exit identities from the
 * egress bus, patches ShardX profiles, attaches to the already-running
 * Chromium over CDP, executes tasks inside the rotation freeze barrier and
 * streams the result to the panel over WebSocket.
 *
 * The HTTP surface is deliberately small and matrix-family compatible; the
 * MCP server in `mcp/server.js` is a thin client of this process.
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const contract = require('../core/contract');
const { createProfileStore } = require('../core/profile-store');
const { createWsHub } = require('../lib/ws');
const { createEgressClient } = require('../lib/egress-client');
const { createCdpRunner } = require('../lib/cdp-runner');
const { createShardxClient } = require('../lib/shardx-client');
const { createSlotManager } = require('../lib/slot-manager');
const { requestJson } = require('../lib/http-client');

const SERVICE_VERSION = '2.0.0';

function discoveryTargets(env, stateDir) {
  const targets = [];
  const dataDir = String(env.OPENCHAMBER_SERVICE_DATA_DIR || '').trim();
  if (dataDir) targets.push(path.join(dataDir, 'service.json'));
  const fallback = stateDir || path.join(os.homedir(), '.openchamber-shardx-matrix');
  targets.push(path.join(fallback, 'run', 'service.json'));
  return Array.from(new Set(targets));
}

function writeDiscovery(targets, record) {
  for (const file of targets) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    } catch { /* discovery is best-effort */ }
  }
}

function removeDiscovery(targets) {
  for (const file of targets) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
}
const BODY_LIMIT_BYTES = 16 * 1024 * 1024;
const PANEL_DIR = path.join(__dirname, '..', 'panel');
const ROOT_DIR = path.join(__dirname, '..');

const STATIC_FILES = Object.freeze({
  '/': { file: path.join(PANEL_DIR, 'index.html'), type: 'text/html; charset=utf-8' },
  '/index.html': { file: path.join(PANEL_DIR, 'index.html'), type: 'text/html; charset=utf-8' },
  '/style.css': { file: path.join(PANEL_DIR, 'style.css'), type: 'text/css; charset=utf-8' },
  '/main.js': { file: path.join(PANEL_DIR, 'main.js'), type: 'text/javascript; charset=utf-8' },
  '/icon.svg': { file: path.join(ROOT_DIR, 'icon.svg'), type: 'image/svg+xml' },
});

const PUBLIC_PATHS = new Set([
  '/',
  '/index.html',
  '/style.css',
  '/main.js',
  '/icon.svg',
  '/favicon.ico',
  '/health',
  '/api/v1/shardx/bus-health',
  '/api/v1/shardx/ws',
]);

function createError(message, code, status, extra) {
  const error = new Error(message);
  if (code) error.code = code;
  if (status) error.status = status;
  if (extra && typeof extra === 'object') Object.assign(error, extra);
  return error;
}

function nowMs() {
  return Date.now();
}

function safeEqual(left, right) {
  const a = crypto.createHash('sha256').update(String(left)).digest();
  const b = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(a, b);
}

function readBody(req, limit = BODY_LIMIT_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(createError('请求体超过 16MB 限制', 'payload_too_large', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (error) => reject(error));
  });
}

async function readJsonBody(req) {
  const buffer = await readBody(req);
  if (!buffer.length) return {};
  const text = buffer.toString('utf8').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed === null ? {} : parsed;
  } catch {
    throw createError('请求体不是合法 JSON', 'invalid_json', 400);
  }
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(String(text), 'utf8');
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function normalizeError(error) {
  const status = Number(error && error.status) || 500;
  const code = (error && error.code) || (status === 500 ? 'internal_error' : `http_${status}`);
  const message = error && error.message ? error.message : '未知错误';
  return { status, body: { ok: false, error: { code, message } } };
}

/**
 * Build the whole runtime (store, hub, egress, runner, ShardX client,
 * slot manager) without listening. Tests inject their own doubles here.
 */
function buildRuntime(options = {}) {
  const env = options.env || process.env;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const store = options.store || createProfileStore(options);
  const settings = store.getSettings();
  const hub = options.hub || createWsHub({ log });

  let manager = null;
  const egress = options.egress || createEgressClient({
    baseUrl: options.egressBusUrl || settings.egressBusUrl,
    freezeTimeoutMs: settings.freezeTimeoutMs,
    log,
    onEvent: (event) => {
      if (manager) manager.handleEgressEvent(event);
    },
  });

  const runner = options.runner || createCdpRunner({
    store,
    log,
    playwright: options.playwright,
    actionOptions: {
      minMs: settings.poissonMinMs,
      maxMs: settings.poissonMaxMs,
    },
    beforeAction: async (session) => {
      if (session && session.matrixSlotId) {
        await egress.waitForUnfrozen(session.matrixSlotId, settings.freezeTimeoutMs);
      }
    },
  });

  const shardx = options.shardx || createShardxClient({ store, log, env });
  manager = options.manager || createSlotManager({ store, shardx, egress, runner, hub, log });

  return { env, store, settings, hub, egress, runner, shardx, manager, log };
}

function createIntegrationsProbe(options = {}) {
  const cacheMs = Number(options.cacheMs) || 3000;
  let cached = null;
  let cachedAt = 0;

  async function probeAll(runtime) {
    const settings = runtime.store.getSettings();
    const checks = await Promise.all([
      (async () => {
        const result = await runtime.egress.health();
        return { id: 'egress', label: 'Egress', service: 'egress-matrix', ok: result.ok, latencyMs: result.latencyMs, url: result.baseUrl, error: result.ok ? '' : result.error };
      })(),
      (async () => {
        const started = nowMs();
        try {
          const response = await requestJson(`${settings.cloudflareBusUrl}${contract.CF_HEALTH_PATH}`, {
            timeoutMs: 2500,
            allowNon2xx: true,
          });
          return {
            id: 'cloudflare',
            label: 'Cloudflare',
            service: 'cf-matrix',
            ok: response.status >= 200 && response.status < 300,
            latencyMs: nowMs() - started,
            url: settings.cloudflareBusUrl,
            error: '',
          };
        } catch (error) {
          return { id: 'cloudflare', label: 'Cloudflare', service: 'cf-matrix', ok: false, latencyMs: nowMs() - started, url: settings.cloudflareBusUrl, error: error.message };
        }
      })(),
      (async () => {
        const started = nowMs();
        try {
          const response = await requestJson(`${settings.instaboxBusUrl}${contract.INSTABOX_HEALTH_PATH}`, {
            timeoutMs: 2500,
            allowNon2xx: true,
          });
          return {
            id: 'instabox',
            label: 'Instabox',
            service: 'instabox-matrix',
            ok: response.status >= 200 && response.status < 300,
            latencyMs: nowMs() - started,
            url: settings.instaboxBusUrl,
            error: '',
          };
        } catch (error) {
          return { id: 'instabox', label: 'Instabox', service: 'instabox-matrix', ok: false, latencyMs: nowMs() - started, url: settings.instaboxBusUrl, error: error.message };
        }
      })(),
      (async () => {
        const started = nowMs();
        try {
          const health = await runtime.shardx.health();
          return {
            id: 'shardx',
            label: 'ShardX',
            service: 'shardx-launcher',
            ok: health.ok,
            latencyMs: health.latencyMs,
            url: health.baseUrl,
            error: health.ok ? '' : (health.error || `HTTP ${health.status}${health.status ? '' : ' 未响应'}`),
          };
        } catch (error) {
          return { id: 'shardx', label: 'ShardX', service: 'shardx-launcher', ok: false, latencyMs: nowMs() - started, url: '', error: error.message };
        }
      })(),
    ]);
    return {
      checkedAt: nowMs(),
      services: [
        { id: 'shardx-matrix', label: 'ShardX Matrix', service: contract.SHARDX_SERVICE_ID, ok: true, latencyMs: 0, url: `http://127.0.0.1:${settings.servicePort}`, error: '' },
        ...checks,
      ],
    };
  }

  return async function integrations(runtime, force) {
    if (!force && cached && nowMs() - cachedAt < cacheMs) return cached;
    cached = await probeAll(runtime);
    cachedAt = nowMs();
    return cached;
  };
}

function createService(options = {}) {
  const runtime = buildRuntime(options);
  const { store, manager, hub, egress } = runtime;
  const log = runtime.log;
  const env = runtime.env;
  const integrations = options.integrations || createIntegrationsProbe(options);
  const serviceToken = String(options.token !== undefined ? options.token : (env.OPENCHAMBER_SERVICE_TOKEN || '')).trim();
  const startedAt = nowMs();
  let server = null;
  let closing = false;
  let discovery = [];

  function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Requested-With');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  function authorized(req) {
    if (!serviceToken) return true;
    const header = String(req.headers.authorization || '');
    if (!header.toLowerCase().startsWith('bearer ')) return false;
    return safeEqual(header.slice(7).trim(), serviceToken);
  }

  function serveStatic(req, res, pathname) {
    const entry = STATIC_FILES[pathname];
    if (!entry) {
      sendText(res, 404, 'Not found');
      return;
    }
    fs.readFile(entry.file, (error, buffer) => {
      if (error) {
        sendText(res, 404, `Not found: ${path.basename(entry.file)}`);
        return;
      }
      res.writeHead(200, {
        'Content-Type': entry.type,
        'Content-Length': String(buffer.length),
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') res.end();
      else res.end(buffer);
    });
  }

  function slotOr404(matrixSlotId) {
    try {
      return contract.assertSlotId(matrixSlotId);
    } catch {
      throw createError('matrixSlotId 必须是 slot-001..slot-250', 'invalid_slot', 400);
    }
  }

  async function route(req, res, url) {
    const method = String(req.method || 'GET').toUpperCase();
    const pathname = url.pathname;

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if ((method === 'GET' || method === 'HEAD') && STATIC_FILES[pathname]) {
      serveStatic(req, res, pathname);
      return;
    }
    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/health' && method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        service: contract.SHARDX_SERVICE_ID,
        version: SERVICE_VERSION,
        uptimeMs: nowMs() - startedAt,
        stateDir: store.stateDir,
      });
      return;
    }

    if (pathname === '/api/v1/shardx/bus-health' && method === 'GET') {
      const status = manager.status();
      sendJson(res, 200, {
        ok: true,
        service: contract.SHARDX_SERVICE_ID,
        runningProfiles: status.runningProfiles,
        activeTasks: status.activeTasks,
        boundSlots: status.boundSlots,
        launching: status.launching,
        wsClients: status.wsClients,
        engine: status.engine,
        hasPlaywright: status.hasPlaywright,
        uptimeMs: status.uptimeMs,
        egress: status.egress,
        at: nowMs(),
      });
      return;
    }

    if (!authorized(req)) {
      sendJson(res, 401, {
        ok: false,
        error: { code: 'unauthorized', message: '缺少或错误的 Bearer token' },
      });
      return;
    }

    const segments = pathname.split('/').filter(Boolean);
    if (segments[0] !== 'api' || segments[1] !== 'v1' || segments[2] !== 'shardx') {
      sendJson(res, 404, { ok: false, error: { code: 'not_found', message: `${method} ${pathname} 不存在` } });
      return;
    }
    const rest = segments.slice(3);
    const routePath = `/${rest.join('/')}`;

    /* ---- slots ---------------------------------------------------------- */
    if (routePath === '/slots' && method === 'GET') {
      const includeUnbound = !['0', 'false', 'no'].includes(String(url.searchParams.get('includeUnbound') || '1').toLowerCase());
      sendJson(res, 200, { ok: true, slots: manager.listSlots({ includeUnbound }) });
      return;
    }
    if (rest[0] === 'slots' && rest[1] && !rest[2] && method === 'GET') {
      sendJson(res, 200, { ok: true, slot: manager.getSlotView(slotOr404(rest[1])) });
      return;
    }
    if (rest[0] === 'slots' && rest[1] && rest[2] === 'bind' && method === 'POST') {
      const slotId = slotOr404(rest[1]);
      const body = await readJsonBody(req);
      const binding = await store.bind({
        matrixSlotId: slotId,
        profileId: body.profileId || body.profile_id,
        profileName: body.profileName || body.profile_name,
        source: body.source || 'panel',
      });
      log(`[service] ${slotId} 绑定 ${binding.profileId}`);
      const view = manager.getSlotView(slotId);
      hub.broadcast('slot.bound', { matrixSlotId: slotId, slot: view });
      sendJson(res, 200, { ok: true, slot: view, binding });
      return;
    }
    if (rest[0] === 'slots' && rest[1] && rest[2] === 'unbind' && method === 'POST') {
      const slotId = slotOr404(rest[1]);
      const removed = await store.unbind(slotId);
      hub.broadcast('slot.unbound', { matrixSlotId: slotId });
      sendJson(res, 200, { ok: true, removed: Boolean(removed), slot: removed || null });
      return;
    }

    /* ---- profiles ------------------------------------------------------- */
    if (routePath === '/profiles' && method === 'GET') {
      const refresh = url.searchParams.get('refresh') === '1';
      if (refresh) runtime.shardx.reset();
      const profiles = await runtime.shardx.listProfiles();
      const bindings = store.listBindings();
      const byProfile = new Map(bindings.map((binding) => [binding.profileId, binding.matrixSlotId]));
      sendJson(res, 200, {
        ok: true,
        profiles: profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          notes: profile.notes,
          folder: profile.folder,
          proxyId: profile.proxyId,
          running: profile.running,
          pid: profile.pid,
          lastLaunchedAt: profile.lastLaunchedAt,
          matrixSlotId: byProfile.get(profile.id) || '',
          bound: byProfile.has(profile.id),
        })),
      });
      return;
    }
    if (routePath === '/proxies' && method === 'GET') {
      const proxies = await runtime.shardx.listProxies();
      sendJson(res, 200, { ok: true, proxies });
      return;
    }
    if (routePath === '/profile/launch' && method === 'POST') {
      const body = await readJsonBody(req);
      const slotId = slotOr404(body.matrixSlotId || body.matrix_slot_id);
      const view = await manager.launchSlot(slotId, { startUrl: body.startUrl || body.url });
      sendJson(res, 200, { ok: true, slot: view });
      return;
    }
    if (routePath === '/profile/close' && method === 'POST') {
      const body = await readJsonBody(req);
      const slotId = slotOr404(body.matrixSlotId || body.matrix_slot_id);
      const view = await manager.closeSlot(slotId, { keepUrl: body.keepUrl === true });
      sendJson(res, 200, { ok: true, slot: view });
      return;
    }
    if (routePath === '/profile/sleep-all' && method === 'POST') {
      const result = await manager.sleepAll();
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
    if (routePath === '/profile/sync-proxies' && method === 'POST') {
      const result = await manager.syncAllProxies();
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    /* ---- tasks ---------------------------------------------------------- */
    if (routePath === '/task/execute' && method === 'POST') {
      const body = await readJsonBody(req);
      const slotId = slotOr404(body.matrixSlotId || body.matrix_slot_id);
      const steps = Array.isArray(body.steps) ? body.steps : [];
      const task = await manager.runTask(slotId, steps, { source: body.source || 'panel' });
      sendJson(res, 200, { ok: true, task });
      return;
    }
    if (routePath === '/task/cancel' && method === 'POST') {
      const body = await readJsonBody(req);
      const taskId = String(body.taskId || body.task_id || '').trim();
      if (!taskId) throw createError('taskId 不能为空', 'task_id_required', 400);
      const cancelled = manager.cancelTask(taskId, body.reason);
      sendJson(res, 200, { ok: true, cancelled });
      return;
    }
    if (routePath === '/tasks' && method === 'GET') {
      const slotId = url.searchParams.get('matrixSlotId') || url.searchParams.get('slotId') || '';
      const limit = Number(url.searchParams.get('limit')) || 50;
      const tasks = store.listTasks({ matrixSlotId: slotId || undefined, limit });
      sendJson(res, 200, { ok: true, tasks });
      return;
    }
    if (rest[0] === 'tasks' && rest[1] && method === 'GET') {
      const task = store.getTask(rest[1]);
      if (!task) throw createError(`任务 ${rest[1]} 不存在`, 'task_missing', 404);
      sendJson(res, 200, { ok: true, task });
      return;
    }

    /* ---- page ----------------------------------------------------------- */
    if (routePath === '/page/observe' && method === 'POST') {
      const body = await readJsonBody(req);
      const snapshot = await manager.observeSlot(slotOr404(body.matrixSlotId || body.matrix_slot_id));
      sendJson(res, 200, { ok: true, snapshot });
      return;
    }
    if (routePath === '/page/act' && method === 'POST') {
      const body = await readJsonBody(req);
      const slotId = slotOr404(body.matrixSlotId || body.matrix_slot_id);
      const step = Object.assign({}, body.step || body);
      delete step.matrixSlotId;
      delete step.matrix_slot_id;
      const result = await manager.actSlot(slotId, step);
      sendJson(res, 200, { ok: true, result });
      return;
    }
    if (routePath === '/page/screenshot' && method === 'POST') {
      const body = await readJsonBody(req);
      const shot = await manager.screenshotSlot(slotOr404(body.matrixSlotId || body.matrix_slot_id), {
        persist: body.persist !== false,
      });
      sendJson(res, 200, { ok: true, ...shot });
      return;
    }

    /* ---- credentials ---------------------------------------------------- */
    if (routePath === '/credentials/import' && method === 'POST') {
      const body = await readJsonBody(req);
      const slotId = slotOr404(body.matrixSlotId || body.matrix_slot_id);
      const result = await manager.importCookies(slotId, {
        source: body.source || 'store',
        cookies: body.cookies,
        cookieString: body.cookieString || body.cookie,
        url: body.url,
        domain: body.domain,
      });
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
    if (rest[0] === 'credentials' && rest[1] && !rest[2] && method === 'GET') {
      const slotId = slotOr404(rest[1]);
      const meta = store.getCredentialMeta(slotId);
      sendJson(res, 200, { ok: true, matrixSlotId: slotId, ...meta });
      return;
    }
    if (rest[0] === 'credentials' && rest[1] && !rest[2] && (method === 'PUT' || method === 'POST')) {
      const slotId = slotOr404(rest[1]);
      const body = await readJsonBody(req);
      const saved = await store.setCredentials(slotId, body, { source: body.source || 'manual' });
      sendJson(res, 200, { ok: true, ...saved });
      return;
    }
    if (rest[0] === 'credentials' && rest[1] && !rest[2] && method === 'DELETE') {
      const slotId = slotOr404(rest[1]);
      const removed = await store.deleteCredentials(slotId);
      sendJson(res, 200, { ok: true, removed });
      return;
    }

    /* ---- events / settings / state -------------------------------------- */
    if (routePath === '/events' && method === 'GET') {
      sendJson(res, 200, { ok: true, events: manager.listEvents(Number(url.searchParams.get('limit')) || 100) });
      return;
    }
    if (routePath === '/settings' && method === 'GET') {
      sendJson(res, 200, { ok: true, settings: store.getSettings() });
      return;
    }
    if (routePath === '/settings' && method === 'POST') {
      const body = await readJsonBody(req);
      const settings = await store.updateSettings(body.settings && typeof body.settings === 'object' ? body.settings : body);
      hub.broadcast('settings.updated', { settings });
      sendJson(res, 200, { ok: true, settings });
      return;
    }
    if (routePath === '/state' && method === 'GET') {
      sendJson(res, 200, { ok: true, state: store.snapshot() });
      return;
    }
    if (routePath === '/integrations' && method === 'GET') {
      const result = await integrations(runtime, url.searchParams.get('refresh') === '1');
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
    if (routePath === '/status' && method === 'GET') {
      sendJson(res, 200, { ok: true, status: manager.status(), hub: hub.status() });
      return;
    }

    sendJson(res, 404, { ok: false, error: { code: 'not_found', message: `${method} ${pathname} 不存在` } });
  }

  async function handle(req, res) {
    cors(res);
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      await route(req, res, url);
    } catch (error) {
      const normalized = normalizeError(error);
      if (normalized.status >= 500) log(`[service] ${req.method} ${url.pathname} -> ${normalized.status} ${error.message}`);
      if (res.headersSent) {
        try { res.end(); } catch { /* ignore */ }
        return;
      }
      sendJson(res, normalized.status, normalized.body);
    }
  }

  function start() {
    return new Promise((resolve, reject) => {
      const settings = store.getSettings();
      const envPort = Number.parseInt(String(env.OPENCHAMBER_SERVICE_PORT || ''), 10);
      const port = Number.isInteger(envPort) && envPort > 0
        ? envPort
        : (options.port === undefined || options.port === null
          ? (settings.servicePort || contract.SHARDX_SERVICE_PORT)
          : Number(options.port));
      const host = options.host || '127.0.0.1';
      server = http.createServer((req, res) => {
        handle(req, res).catch(() => {
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: 'internal_error', message: '内部错误' } });
        });
      });
      server.on('upgrade', (req, socket, head) => {
        if (hub.isUpgrade(req)) {
          hub.upgrade(req, socket, head);
          return;
        }
        try { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); } catch { /* ignore */ }
        socket.destroy();
      });
      server.on('error', reject);
      server.listen(port, host, () => {
        if (typeof egress.start === 'function') egress.start();
        const address = server.address();
        const actualPort = address && address.port ? address.port : port;
        discovery = discoveryTargets(env, store.stateDir);
        writeDiscovery(discovery, {
          service: 'shardx-matrix',
          version: SERVICE_VERSION,
          pid: process.pid,
          host,
          port: actualPort,
          url: `http://${host}:${actualPort}`,
          token: serviceToken || undefined,
          startedAt: new Date().toISOString(),
        });
        log(`[service] shardx-matrix v${SERVICE_VERSION} 监听 http://${host}:${actualPort}`);
        resolve({ server, port: actualPort, url: `http://${host}:${actualPort}`, runtime });
      });
    });
  }

  async function stop() {
    if (closing) return;
    closing = true;
    try { await manager.shutdown(); } catch { /* ignore */ }
    try { if (typeof egress.stop === 'function') egress.stop(); } catch { /* ignore */ }
    try { hub.close(); } catch { /* ignore */ }
    removeDiscovery(discovery);
    discovery = [];
    if (server) {
      await new Promise((resolve) => server.close(() => resolve()));
      server = null;
    }
  }

  return {
    start,
    stop,
    handle,
    runtime,
    manager,
    store,
    hub,
    egress,
    get server() {
      return server;
    },
  };
}

async function main() {
  const log = (line) => console.log(`${new Date().toISOString()} ${line}`);
  const service = createService({ log });
  const started = await service.start();
  log(`[service] 面板 http://127.0.0.1:${started.port}/`);
  const shutdown = async (signal) => {
    log(`[service] 收到 ${signal}，正在关闭`);
    await service.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });
  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
  process.on('unhandledRejection', (error) => {
    log(`[service] 未处理的 Promise 拒绝：${error && error.message ? error.message : String(error)}`);
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[service] 启动失败：${error && error.stack ? error.stack : error}`);
    process.exit(1);
  });
}

module.exports = {
  createService,
  buildRuntime,
  createIntegrationsProbe,
  SERVICE_VERSION,
  BODY_LIMIT_BYTES,
  readJsonBody,
  main,
};
