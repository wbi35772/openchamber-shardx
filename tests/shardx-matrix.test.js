'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const contract = require('../core/contract');
const { createProfileStore } = require('../core/profile-store');
const { createEgressClient } = require('../lib/egress-client');
const { createShardxClient } = require('../lib/shardx-client');
const { createCdpRunner } = require('../lib/cdp-runner');
const { createWsHub, WsConn, connect: wsConnect } = require('../lib/ws');
const { createService } = require('../service/main');
const { createMcpServer } = require('../mcp/server');

/* ------------------------------------------------------------------------- */
/* helpers                                                                   */
/* ------------------------------------------------------------------------- */

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer.unref) timer.unref();
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(address.port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    try { server.closeAllConnections(); } catch { /* older node */ }
    if (server._upgradedSockets) {
      for (const socket of server._upgradedSockets) {
        try { socket.destroy(); } catch { /* ignore */ }
      }
      server._upgradedSockets.clear();
    }
    const timer = setTimeout(resolve, 300);
    if (timer.unref) timer.unref();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function readAll(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function readJson(req) {
  const text = await readAll(req);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function sendJson(res, status, body) {
  const buffer = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(buffer.length),
  });
  res.end(buffer);
}

function attachWs(server, pathname, onConnection) {
  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== pathname) {
      socket.destroy();
      return;
    }
    if (!server._upgradedSockets) server._upgradedSockets = new Set();
    server._upgradedSockets.add(socket);
    socket.on('close', () => server._upgradedSockets.delete(socket));
    const key = String(req.headers['sec-websocket-key'] || '');
    const accept = crypto
      .createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    const conn = new WsConn(socket, head, { mask: false });
    conn.resume();
    onConnection(conn);
  });
}

async function waitFor(predicate, options = {}) {
  const timeout = Number(options.timeout) || 4000;
  const interval = Number(options.interval) || 20;
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) {
      throw new Error(options.message || 'waitFor 超时');
    }
    await sleep(interval);
  }
}

function makeStore(prefix = 'shardx-store-') {
  const dir = tmpDir(prefix);
  const store = createProfileStore({ stateDir: dir });
  if (typeof store.load === 'function') store.load();
  return store;
}

function writeLauncherSettings(dir, port) {
  const dataDir = path.join(dir, 'shardx-data');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dir, 'shardx-settings.json');
  fs.writeFileSync(file, JSON.stringify({
    api_port: port,
    api_secret: 'test-secret',
    data_root: dataDir,
  }, null, 2));
  return { file, dataDir };
}

/* ------------------------------------------------------------------------- */
/* Mock egress bus                                                           */
/* ------------------------------------------------------------------------- */

async function startMockEgress() {
  const slotId = 'slot-001';
  const state = {
    ws: null,
    acks: [],
    leases: {
      [slotId]: {
        matrixSlotId: slotId,
        egressPort: 24001,
        routingPlane: 'ELASTIC_DATA',
        healthState: 'ACTIVE',
        leaseId: 'lease-0001',
        country: 'US',
        provider: 'mock-egress',
        egressFingerprint: {
          exitIp: '203.0.113.10',
          ipv6Prefix64: '2001:db8:1:2::',
          asn: 'AS64500',
          leaseId: 'lease-0001',
          updatedAt: Date.now(),
        },
      },
    },
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === contract.EGRESS_HEALTH_PATH) {
      sendJson(res, 200, { ok: true, slots: Object.keys(state.leases).length });
      return;
    }
    if (url.pathname === contract.EGRESS_SLOTS_PATH) {
      sendJson(res, 200, { slots: Object.values(state.leases) });
      return;
    }
    if (url.pathname.startsWith('/api/v1/egress/lease/')) {
      const requested = decodeURIComponent(url.pathname.split('/').pop());
      const lease = state.leases[requested];
      if (!lease) {
        sendJson(res, 404, { ok: false, error: { message: 'lease missing' } });
        return;
      }
      sendJson(res, 200, lease);
      return;
    }
    sendJson(res, 404, { ok: false, error: { message: `${req.method} ${url.pathname}` } });
  });

  attachWs(server, contract.EGRESS_WS_PATH, (conn) => {
    state.ws = conn;
    conn.on('message', ({ data, binary }) => {
      if (binary) return;
      try {
        const message = JSON.parse(data.toString('utf8'));
        if (message.type === 'ACK_FREEZE') state.acks.push(message);
      } catch { /* ignore */ }
    });
  });

  const port = await listen(server);
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    state,
    freeze(slot, eventId = 'evt-1') {
      state.ws.sendText(JSON.stringify({
        type: 'PRE_ROTATION_FREEZE',
        matrixSlotId: slot,
        eventId,
        reason: 'scheduled-rotation',
      }));
    },
    resume(slot) {
      state.ws.sendText(JSON.stringify({
        type: 'POST_ROTATION_RESUME',
        matrixSlotId: slot,
      }));
    },
    close: () => closeServer(server),
  };
}

/* ------------------------------------------------------------------------- */
/* Mock ShardX launcher                                                      */
/* ------------------------------------------------------------------------- */

async function startMockShardx(options = {}) {
  const state = {
    profiles: options.profiles || [{
      id: 'profile-1',
      name: 'Alpha',
      notes: 'keep me',
      folder: 'Team',
      proxy_id: '',
      running: false,
      timezone: 'UTC',
      icu_locale: 'en-US',
      screen: { width: 1920, height: 1080 },
      noise: { canvas: { enabled: true, seed: 7 } },
    }],
    proxies: [],
    patched: [],
    started: [],
    stopped: [],
    authHeaders: [],
  };
  let cdpUrl = options.cdpUrl || '';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    state.authHeaders.push(String(req.headers.authorization || ''));
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readJson(req) : {};
    const findProfile = (id) => state.profiles.find((item) => item.id === id);

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, version: 'mock-shardx' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/profiles') {
      sendJson(res, 200, { profiles: state.profiles });
      return;
    }
    const profileMatch = url.pathname.match(/^\/profiles\/([^/]+)$/);
    if (profileMatch && req.method === 'GET') {
      const profile = findProfile(decodeURIComponent(profileMatch[1]));
      if (!profile) {
        sendJson(res, 404, { ok: false, error: { message: 'profile missing' } });
        return;
      }
      sendJson(res, 200, profile);
      return;
    }
    if (profileMatch && req.method === 'PATCH') {
      const profile = findProfile(decodeURIComponent(profileMatch[1]));
      if (!profile) {
        sendJson(res, 404, { ok: false, error: { message: 'profile missing' } });
        return;
      }
      if (body.fingerprint && typeof body.fingerprint === 'object') {
        const meta = {};
        for (const key of ['id', '_meta', 'running', 'cdp', 'proxy_id', 'folder']) {
          if (key in profile) meta[key] = profile[key];
        }
        for (const key of Object.keys(profile)) delete profile[key];
        Object.assign(profile, meta, body.fingerprint);
      }
      if (typeof body.proxy_id === 'string') profile.proxy_id = body.proxy_id;
      state.patched.push({ id: profile.id, body });
      sendJson(res, 200, profile);
      return;
    }
    const startMatch = url.pathname.match(/^\/profiles\/([^/]+)\/start$/);
    if (startMatch && req.method === 'POST') {
      const profile = findProfile(decodeURIComponent(startMatch[1]));
      if (!profile) {
        sendJson(res, 404, { ok: false, error: { message: 'profile missing' } });
        return;
      }
      profile.running = true;
      state.started.push(profile.id);
      sendJson(res, 200, {
        ok: true,
        profile,
        cdp: { web_socket_debugger_url: cdpUrl },
      });
      return;
    }
    const stopMatch = url.pathname.match(/^\/profiles\/([^/]+)\/stop$/);
    if (stopMatch && req.method === 'POST') {
      const profile = findProfile(decodeURIComponent(stopMatch[1]));
      if (!profile) {
        sendJson(res, 404, { ok: false, error: { message: 'profile missing' } });
        return;
      }
      profile.running = false;
      state.stopped.push(profile.id);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/proxies') {
      sendJson(res, 200, { proxies: state.proxies });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/proxies') {
      const proxy = Object.assign({ id: `proxy-${state.proxies.length + 1}` }, body);
      state.proxies.push(proxy);
      sendJson(res, 200, proxy);
      return;
    }
    const proxyMatch = url.pathname.match(/^\/proxies\/([^/]+)$/);
    if (proxyMatch && req.method === 'PATCH') {
      const proxy = state.proxies.find((item) => item.id === decodeURIComponent(proxyMatch[1]));
      if (!proxy) {
        sendJson(res, 404, { ok: false, error: { message: 'proxy missing' } });
        return;
      }
      Object.assign(proxy, body);
      sendJson(res, 200, proxy);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/running') {
      sendJson(res, 200, { profiles: state.profiles.filter((profile) => profile.running) });
      return;
    }
    sendJson(res, 404, { ok: false, error: { message: `no route ${req.method} ${url.pathname}` } });
  });

  const port = await listen(server);
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    state,
    setCdpUrl(value) { cdpUrl = value; },
    close: () => closeServer(server),
  };
}

/* ------------------------------------------------------------------------- */
/* Mock DevTools endpoint                                                    */
/* ------------------------------------------------------------------------- */

async function startMockCdp() {
  const state = {
    connections: 0,
    cookies: [],
    navigations: [],
    commands: [],
  };
  const snapshot = () => ({
    url: 'https://example.test/login',
    title: 'Mock Login',
    readyState: 'complete',
    text: 'Welcome to the mock page',
    elements: [
      { ref: 'e1', role: 'textbox', name: 'Email', x: 100, y: 120 },
      { ref: 'e2', role: 'button', name: 'Sign in', x: 100, y: 180 },
    ],
    aria: [{ role: 'textbox', name: 'Email' }],
    scroll: { x: 0, y: 0 },
    viewport: { width: 1280, height: 720 },
    capturedAt: Date.now(),
  });

  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('devtools websocket only');
  });

  attachWs(server, '/devtools/browser', (conn) => {
    state.connections += 1;
    conn.on('message', ({ data, binary }) => {
      if (binary) return;
      let message;
      try {
        message = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      const method = String(message.method || '');
      const params = message.params || {};
      const expression = params.expression ? String(params.expression) : '';
      state.commands.push(method);
      const reply = (result) => {
        try {
          conn.sendText(JSON.stringify({
            id: message.id,
            result,
            ...(message.sessionId ? { sessionId: message.sessionId } : {}),
          }));
        } catch { /* closed */ }
      };

      if (method === 'Target.getTargets') {
        reply({ targetInfos: [{ targetId: 'target-1', type: 'page', url: 'about:blank' }] });
        return;
      }
      if (method === 'Target.attachToTarget') {
        reply({ sessionId: 'session-1' });
        return;
      }
      if (method === 'Page.navigate') {
        state.navigations.push(String(params.url || ''));
        reply({ frameId: 'frame-1' });
        setTimeout(() => {
          try {
            conn.sendText(JSON.stringify({
              method: 'Page.loadEventFired',
              params: { timestamp: Date.now() / 1000 },
              sessionId: message.sessionId,
            }));
          } catch { /* closed */ }
        }, 5);
        return;
      }
      if (method === 'Runtime.evaluate') {
        if (expression.trim() === 'document.readyState') {
          reply({ result: { type: 'string', value: 'complete' } });
          return;
        }
        if (expression.includes('capturedAt')) {
          reply({ result: { type: 'object', value: snapshot() } });
          return;
        }
        if (expression.includes('getBoundingClientRect')) {
          reply({ result: { type: 'object', value: { x: 100, y: 120 } } });
          return;
        }
        if (expression.includes('scrollX')) {
          reply({ result: { type: 'object', value: { x: 0, y: 0, w: 1280, h: 720 } } });
          return;
        }
        if (expression.includes('location.href')) {
          reply({ result: { type: 'object', value: { url: 'https://example.test/login', title: 'Mock Login' } } });
          return;
        }
        if (expression.includes('innerText') || expression.includes('textContent')) {
          reply({ result: { type: 'string', value: 'Welcome to the mock page' } });
          return;
        }
        if (expression.includes('__shardxRefs')) {
          reply({ result: { type: 'boolean', value: true } });
          return;
        }
        reply({ result: { type: 'string', value: '' } });
        return;
      }
      if (method === 'Page.captureScreenshot') {
        reply({ data: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64') });
        return;
      }
      if (method === 'Network.setCookie') {
        state.cookies.push(params);
        reply({ success: true });
        return;
      }
      reply({});
    });
  });

  const port = await listen(server);
  return {
    server,
    port,
    wsUrl: `ws://127.0.0.1:${port}/devtools/browser`,
    state,
    snapshot,
    close: () => closeServer(server),
  };
}

/* ------------------------------------------------------------------------- */
/* contract                                                                  */
/* ------------------------------------------------------------------------- */

test('contract: 槽位与代理端口一一对应', () => {
  assert.equal(contract.slotIdForIndex(1), 'slot-001');
  assert.equal(contract.slotIdForIndex(250), 'slot-250');
  assert.equal(contract.egressPortForSlotId('slot-001'), 24001);
  assert.equal(contract.egressPortForSlotId('slot-250'), 24250);
  assert.equal(contract.indexForSlotId('slot-042'), 42);
  assert.equal(contract.indexForSlotId('slot-251'), 0);
  assert.equal(contract.matrixSlotIdForPort(24100), 'slot-100');
  assert.equal(contract.isMatrixPort(24000), false);
  assert.equal(contract.isMatrixPort(24251), false);
  assert.equal(contract.normalizeBrowserState('running'), 'RUNNING');
  assert.equal(contract.normalizeHealthState('rotating'), 'ROTATING');
  assert.equal(contract.isBlockedHealthState('QUARANTINED'), true);
});

/* ------------------------------------------------------------------------- */
/* profile store                                                             */
/* ------------------------------------------------------------------------- */

test('profile-store: 1:1 绑定、白名单更新、任务与加密凭据', async () => {
  const store = makeStore();

  const binding = await store.bind({
    matrixSlotId: 'slot-001',
    profileId: 'profile-1',
    profileName: 'Alpha',
    source: 'test',
  });
  assert.equal(binding.matrixSlotId, 'slot-001');
  assert.equal(binding.profileId, 'profile-1');
  assert.equal(binding.egressPort, 24001);

  await assert.rejects(
    store.bind({ matrixSlotId: 'slot-002', profileId: 'profile-1' }),
    (error) => error.status === 409 && error.code === 'profile_already_bound',
  );

  const replaced = await store.bind({ matrixSlotId: 'slot-001', profileId: 'profile-2' });
  assert.equal(replaced.profileId, 'profile-2');
  assert.equal(store.listBindings().length, 1);

  const touched = await store.touchBinding('slot-001', {
    lastUrl: 'https://example.test/',
    lastTitle: 'Example',
    ignoredField: 'should-not-be-written',
  });
  assert.equal(touched.lastUrl, 'https://example.test/');
  assert.equal(touched.lastTitle, 'Example');
  assert.equal(Object.prototype.hasOwnProperty.call(touched, 'ignoredField'), false);

  const task = await store.createTask({
    matrixSlotId: 'slot-001',
    profileId: 'profile-2',
    steps: [{ action: 'goto', url: 'https://example.test/' }],
  });
  assert.ok(task.id);
  assert.equal(task.status, 'QUEUED');
  await store.updateTask(task.id, { status: 'RUNNING', stepsDone: 1 });
  await store.appendTaskLog(task.id, { level: 'info', message: 'hello' });
  const finished = await store.finishTask(task.id, {
    status: 'DONE',
    result: { ok: true },
  });
  assert.equal(finished.status, 'DONE');
  assert.equal(store.listTasks({ matrixSlotId: 'slot-001' }).length, 1);

  const saved = await store.setCredentials('slot-001', {
    cookies: [{ name: 'sid', value: 'secret-value', domain: '.example.test' }],
  }, { source: 'test' });
  assert.equal(saved.slotId, 'slot-001');
  const restored = store.getCredentials('slot-001');
  assert.equal(restored.cookies[0].value, 'secret-value');
  assert.equal(store.hasCredentials('slot-001'), true);
  const meta = store.getCredentialMeta('slot-001');
  assert.equal(meta.exists, true);
  assert.equal(meta.source, 'test');
  await store.deleteCredentials('slot-001');
  assert.equal(store.hasCredentials('slot-001'), false);

  const removed = await store.unbind('slot-001');
  assert.equal(removed.profileId, 'profile-2');
  assert.equal(store.listBindings().length, 0);
});

/* ------------------------------------------------------------------------- */
/* egress client                                                             */
/* ------------------------------------------------------------------------- */

test('egress-client: 租约、缓存与换血冻结屏障', async () => {
  const mock = await startMockEgress();
  const events = [];
  const client = createEgressClient({
    baseUrl: mock.url,
    freezeTimeoutMs: 3000,
    onEvent: (event) => events.push(event),
  });
  try {
    client.start();
    const lease = await client.lease('slot-001');
    assert.equal(lease.egressPort, 24001);
    assert.equal(lease.leaseId, 'lease-0001');
    assert.equal(lease.egressFingerprint.exitIp, '203.0.113.10');
    assert.equal(client.cachedSlot('slot-001').healthState, 'ACTIVE');

    const health = await client.health();
    assert.equal(health.ok, true);

    await waitFor(() => mock.state.ws, { message: 'egress WS 未连接' });
    mock.freeze('slot-001', 'evt-freeze');
    await waitFor(() => client.isFrozen('slot-001'), { message: '未进入冻结' });
    assert.equal(events.some((event) => event.type === 'freeze'), true);
    await waitFor(() => mock.state.acks.length > 0, { message: '未回 ACK_FREEZE' });
    assert.equal(mock.state.acks[0].eventId, 'evt-freeze');

    let resumed = false;
    client.waitForUnfrozen('slot-001', 2000).then(() => { resumed = true; });
    mock.resume('slot-001');
    await waitFor(() => resumed, { message: '冻结未解除' });
    assert.equal(client.isFrozen('slot-001'), false);
  } finally {
    client.stop();
    await mock.close();
  }
});

/* ------------------------------------------------------------------------- */
/* ShardX client                                                             */
/* ------------------------------------------------------------------------- */

test('shardx-client: JWT 鉴权、代理对齐与 CDP 地址', async () => {
  const dir = tmpDir('shardx-client-');
  const mock = await startMockShardx();
  const { file } = writeLauncherSettings(dir, mock.port);
  const env = {
    SHARDX_API_BASE: mock.url,
    SHARDX_LAUNCHER_SETTINGS: file,
  };
  try {
    const client = createShardxClient({ env });
    const health = await client.health();
    assert.equal(health.ok, true);

    const profiles = await client.listProfiles();
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].id, 'profile-1');
    const bearer = mock.state.authHeaders.find((value) => value.startsWith('Bearer '));
    assert.match(bearer || '', /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const proxy = await client.ensureSlotProxy('slot-001');
    assert.equal(proxy.host, '127.0.0.1');
    assert.equal(proxy.port, 24001);
    assert.equal(mock.state.proxies.length, 1);

    const again = await client.ensureSlotProxy('slot-001');
    assert.equal(again.id, proxy.id);
    assert.equal(mock.state.proxies.length, 1);

    const lease = {
      matrixSlotId: 'slot-001',
      country: 'US',
      egressFingerprint: { exitIp: '203.0.113.10' },
    };
    await client.alignProfileToLease('profile-1', lease, proxy.id);
    const patch = mock.state.patched.find((entry) => entry.id === 'profile-1');
    assert.equal(patch.body.proxy_id, proxy.id);
    assert.equal(patch.body.fingerprint.webrtc, 'proxy');
    assert.equal(patch.body.fingerprint.timezone, 'America/New_York');
    assert.equal(patch.body.fingerprint.icu_locale, 'en-US');
    assert.equal(patch.body.fingerprint.name, 'Alpha');
    assert.equal(patch.body.fingerprint.notes, 'keep me');
    assert.equal(patch.body.fingerprint.screen.width, 1920);
    assert.equal(mock.state.profiles[0].name, 'Alpha');

    const started = await client.startProfile('profile-1');
    assert.equal(mock.state.started[0], 'profile-1');
    assert.equal(started.cdp.web_socket_debugger_url, '');
    assert.equal(mock.state.profiles[0].running, true);
  } finally {
    await mock.close();
  }
});

/* ------------------------------------------------------------------------- */
/* CDP runner                                                                */
/* ------------------------------------------------------------------------- */

test('cdp-runner: 接管已启动实例、语义快照与动作执行', async () => {
  const mockCdp = await startMockCdp();
  const runner = createCdpRunner({ playwright: false, actionOptions: { minMs: 1, maxMs: 2 } });
  try {
    const session = await runner.attach('profile-1', {
      wsUrl: mockCdp.wsUrl,
      matrixSlotId: 'slot-001',
      timeoutMs: 3000,
    });
    assert.equal(session.engine, 'cdp');
    assert.equal(runner.getSession('profile-1'), session);

    const snapshot = await runner.observe('profile-1');
    assert.equal(snapshot.title, 'Mock Login');
    assert.equal(snapshot.elements[0].ref, 'e1');
    assert.equal(snapshot.elements.length, 2);

    const click = await runner.runStep('profile-1', { action: 'click', ref: 'e2' }, { stepIndex: 0, results: {} });
    assert.equal(click.ok, true);

    const fill = await runner.runStep('profile-1', {
      action: 'fill',
      ref: 'e1',
      text: 'agent@example.test',
    }, { stepIndex: 1, results: {} });
    assert.equal(fill.ok, true);

    const assertion = await runner.runStep('profile-1', {
      action: 'assertText',
      text: 'Welcome',
    }, { stepIndex: 2, results: {} });
    assert.equal(assertion.ok, true);

    const shot = await runner.screenshot('profile-1');
    assert.match(shot.dataUrl, /^data:image\/png;base64,/);
    assert.equal(mockCdp.state.connections, 1);

    const applied = await runner.setCookies('profile-1', [
      { name: 'sid', value: 'abc', domain: '.example.test', path: '/', secure: true },
    ]);
    assert.equal(applied, 1);
    assert.equal(mockCdp.state.cookies[0].name, 'sid');

    await runner.detach('profile-1');
    assert.equal(runner.getSession('profile-1'), null);
  } finally {
    await runner.closeAll().catch(() => {});
    await mockCdp.close();
  }
});

/* ------------------------------------------------------------------------- */
/* Service + slot manager end to end                                         */
/* ------------------------------------------------------------------------- */

test('service: 绑定、启动、观测、任务、冻结屏障与关闭全链路', async (t) => {
  const mockCdp = await startMockCdp();
  const mockShardx = await startMockShardx({ cdpUrl: mockCdp.wsUrl });
  const mockEgress = await startMockEgress();
  const store = makeStore('shardx-service-');
  const dir = tmpDir('shardx-service-env-');
  const { file } = writeLauncherSettings(dir, mockShardx.port);

  await store.updateSettings({
    egressBusUrl: mockEgress.url,
    cloudflareBusUrl: mockEgress.url,
    instaboxBusUrl: mockEgress.url,
    poissonMinMs: 1,
    poissonMaxMs: 2,
    freezeTimeoutMs: 2000,
    launchTimeoutMs: 5000,
    requireEgressLease: true,
  });
  await store.bind({ matrixSlotId: 'slot-001', profileId: 'profile-1', profileName: 'Alpha' });

  const service = createService({
    store,
    env: { SHARDX_API_BASE: mockShardx.url, SHARDX_LAUNCHER_SETTINGS: file },
    port: 0,
    log: () => {},
    playwright: false,
  });

  let panel = null;
  try {
    const started = await service.start();
    const base = started.url;

    const indexResponse = await fetch(`${base}/`);
    assert.equal(indexResponse.status, 200);
    const indexHtml = await indexResponse.text();
    assert.match(indexHtml, /ShardX/i);

    const healthResponse = await fetch(`${base}/api/v1/shardx/bus-health`);
    assert.equal(healthResponse.status, 200);
    const busHealth = await healthResponse.json();
    assert.equal(busHealth.ok, true);
    assert.equal(busHealth.service, 'shardx-matrix');
    assert.equal(busHealth.boundSlots, 1);

    panel = await wsConnect(`ws://127.0.0.1:${started.port}/api/v1/shardx/ws`);
    const frames = [];
    let clientId = '';
    panel.on('message', ({ data, binary }) => {
      if (binary) return;
      let frame;
      try {
        frame = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      frames.push(frame);
      if (frame.type === 'SERVICE_READY') clientId = frame.clientId;
      if (frame.type === 'PRE_ROTATION_FREEZE' && frame.eventId) {
        panel.sendText(JSON.stringify({
          type: 'ACK_FREEZE',
          eventId: frame.eventId,
          clientId,
          ok: true,
        }));
      }
    });
    await waitFor(() => frames.some((frame) => frame.type === 'SERVICE_READY'), {
      message: '未收到 SERVICE_READY',
    });

    const launch = await fetch(`${base}/api/v1/shardx/profile/launch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matrixSlotId: 'slot-001', startUrl: 'https://example.test/login' }),
    });
    assert.equal(launch.status, 200);
    const launched = await launch.json();
    assert.equal(launched.slot.browser.state, 'RUNNING');
    assert.equal(launched.slot.browser.cdpAttached, true);
    assert.equal(mockShardx.state.started[0], 'profile-1');
    assert.equal(mockShardx.state.proxies.length, 1);
    assert.equal(mockShardx.state.proxies[0].port, 24001);

    const observe = await fetch(`${base}/api/v1/shardx/page/observe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matrixSlotId: 'slot-001' }),
    });
    assert.equal(observe.status, 200);
    const observed = await observe.json();
    assert.equal(observed.snapshot.elements[0].ref, 'e1');

    const act = await fetch(`${base}/api/v1/shardx/page/act`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matrixSlotId: 'slot-001', action: 'click', ref: 'e2' }),
    });
    assert.equal(act.status, 200);
    assert.equal((await act.json()).result.ok, true);

    const taskResponse = await fetch(`${base}/api/v1/shardx/task/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        matrixSlotId: 'slot-001',
        steps: [
          { action: 'goto', url: 'https://example.test/login' },
          { action: 'wait', ms: 1 },
          { action: 'assertText', text: 'Welcome' },
        ],
      }),
    });
    assert.equal(taskResponse.status, 200);
    const task = (await taskResponse.json()).task;
    assert.equal(task.status, 'DONE');
    assert.equal(task.stepsDone, 3);
    assert.ok(mockCdp.state.navigations.includes('https://example.test/login'));

    const screenshot = await fetch(`${base}/api/v1/shardx/page/screenshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matrixSlotId: 'slot-001' }),
    });
    assert.equal(screenshot.status, 200);
    assert.match((await screenshot.json()).dataUrl, /^data:image\/png;base64,/);

    const saveCredentials = await fetch(`${base}/api/v1/shardx/credentials/slot-001`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies: [{ name: 'sid', value: 'abc', domain: '.example.test' }] }),
    });
    assert.equal(saveCredentials.status, 200);
    assert.deepEqual((await saveCredentials.json()).names, ['sid']);

    const imported = await fetch(`${base}/api/v1/shardx/credentials/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matrixSlotId: 'slot-001', source: 'store' }),
    });
    assert.equal(imported.status, 200);
    assert.equal((await imported.json()).applied, 1);
    assert.ok(mockCdp.state.cookies.some((cookie) => cookie.name === 'sid'));

    mockEgress.freeze('slot-001', 'evt-service');
    await waitFor(() => frames.some((frame) => frame.type === 'PRE_ROTATION_FREEZE' && frame.eventId === 'evt-service'), {
      message: '面板未收到 PRE_ROTATION_FREEZE',
    });
    await waitFor(() => mockEgress.state.acks.some((ack) => ack.eventId === 'evt-service'), {
      message: 'egress 未收到 ACK_FREEZE',
    });
    assert.equal(service.runtime.egress.isFrozen('slot-001'), true);

    mockEgress.resume('slot-001');
    await waitFor(() => service.runtime.egress.isFrozen('slot-001') === false, {
      message: '换血恢复失败',
    });
    await waitFor(() => frames.some((frame) => frame.type === 'POST_ROTATION_RESUME'), {
      message: '面板未收到 POST_ROTATION_RESUME',
    });

    const statusResponse = await fetch(`${base}/api/v1/shardx/bus-health`);
    const statusBody = await statusResponse.json();
    assert.equal(statusBody.runningProfiles, 1);
    assert.equal(statusBody.activeTasks, 0);

    const close = await fetch(`${base}/api/v1/shardx/profile/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matrixSlotId: 'slot-001' }),
    });
    assert.equal(close.status, 200);
    assert.equal((await close.json()).slot.browser.state, 'STOPPED');
    assert.deepEqual(mockShardx.state.stopped, ['profile-1']);
  } finally {
    if (panel) {
      try { panel.close(1000, 'test done'); } catch { /* ignore */ }
    }
    await service.stop();
    await mockEgress.close();
    await mockShardx.close();
    await mockCdp.close();
  }
});

/* ------------------------------------------------------------------------- */
/* MCP server                                                                */
/* ------------------------------------------------------------------------- */

test('mcp: 工具列表与五个工具转发到本地服务', async () => {
  const calls = [];
  const request = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({
      method: options.method || 'GET',
      path: parsed.pathname,
      body: options.body,
      authorization: options.headers && options.headers.Authorization,
    });
    return { status: 200, body: { ok: true, echo: parsed.pathname }, text: '' };
  };
  const server = createMcpServer({
    serviceBaseUrl: 'http://127.0.0.1:19884',
    token: 'test-token',
    request,
  });

  const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(init.result.serverInfo.name, 'shardx-matrix');
  assert.equal(init.result.protocolVersion, '2024-11-05');

  const list = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = list.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'shardx_page_act',
    'shardx_page_observe',
    'shardx_slot_close',
    'shardx_slot_launch',
    'shardx_task_run',
  ]);

  const launch = await server.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'shardx_slot_launch', arguments: { matrixSlotId: 'slot-007' } },
  });
  assert.equal(launch.result.isError, false);
  assert.equal(calls[0].path, '/api/v1/shardx/profile/launch');
  assert.equal(calls[0].authorization, 'Bearer test-token');
  assert.equal(JSON.parse(calls[0].body).matrixSlotId, 'slot-007');

  await server.handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'shardx_page_observe', arguments: { matrixSlotId: 'slot-007' } },
  });
  assert.equal(calls[1].path, '/api/v1/shardx/page/observe');

  await server.handle({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'shardx_page_act',
      arguments: { matrixSlotId: 'slot-007', action: 'click', ref: 'e2' },
    },
  });
  assert.equal(calls[2].path, '/api/v1/shardx/page/act');
  assert.equal(JSON.parse(calls[2].body).action, 'click');
  assert.equal(JSON.parse(calls[2].body).ref, 'e2');

  await server.handle({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: {
      name: 'shardx_task_run',
      arguments: {
        matrixSlotId: 'slot-007',
        steps: [{ action: 'goto', url: 'https://example.test/' }],
      },
    },
  });
  assert.equal(calls[3].path, '/api/v1/shardx/task/execute');
  assert.equal(JSON.parse(calls[3].body).steps.length, 1);

  await server.handle({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'shardx_slot_close', arguments: { matrixSlotId: 'slot-007' } },
  });
  assert.equal(calls[4].path, '/api/v1/shardx/profile/close');

  const invalid = await server.handle({
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: { name: 'shardx_slot_launch', arguments: { matrixSlotId: 'nope' } },
  });
  assert.equal(invalid.result.isError, true);
  assert.match(invalid.result.content[0].text, /matrixSlotId/);

  const unknown = await server.handle({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: { name: 'not_a_tool', arguments: {} },
  });
  assert.equal(unknown.result.isError, true);
});

/* ------------------------------------------------------------------------- */
/* MCP over SSE                                                              */
/* ------------------------------------------------------------------------- */

test('mcp: SSE 会话可完成 initialize 与 tools/list', async () => {
  const request = async (url) => ({ status: 200, body: { ok: true, url }, text: '' });
  const server = createMcpServer({ request, token: '' });
  const { runSse } = require('../mcp/server');
  const started = await runSse(server, { port: 0 });
  try {
    const health = await fetch(`http://127.0.0.1:${started.port}/health`);
    const healthBody = await health.json();
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.transport, 'sse');

    const controller = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${started.port}/sse`, { signal: controller.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readFrame = async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error('SSE 流已关闭');
        buffer += decoder.decode(value, { stream: true });
        const split = buffer.indexOf('\n\n');
        if (split >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          if (frame.includes('event: endpoint')) {
            const line = frame.split('\n').find((item) => item.startsWith('data: '));
            return { type: 'endpoint', data: line.slice(6).trim() };
          }
          if (frame.includes('event: message')) {
            const line = frame.split('\n').find((item) => item.startsWith('data: '));
            return { type: 'message', data: JSON.parse(line.slice(6)) };
          }
        }
      }
    };

    const endpoint = await readFrame();
    assert.match(endpoint.data, /^\/messages\?sessionId=/);
    const post = await fetch(`http://127.0.0.1:${started.port}${endpoint.data}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(post.status, 202);
    const message = await readFrame();
    assert.equal(message.type, 'message');
    assert.equal(message.data.result.serverInfo.name, 'shardx-matrix');
    controller.abort();
  } finally {
    await new Promise((resolve) => started.server.close(() => resolve()));
  }
});
