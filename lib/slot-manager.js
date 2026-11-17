'use strict';

/*
 * Slot orchestration: the only place that knows the full launch recipe.
 *
 *   egress lease -> loopback proxy on 24000+index -> profile patch
 *   (proxy_id, timezone, locale) -> ShardX start -> CDP attach -> navigate
 *
 * Tasks run inside a freeze barrier: the egress bus can ask every browser to
 * stop touching the network while it rewrites an exit identity, and the
 * runner resumes only after POST_ROTATION_RESUME.
 */

const contract = require('../core/contract');
const scheduler = require('./scheduler');
const { requestJson } = require('./http-client');

const EVENT_RING = 500;

function createError(message, code, status) {
  const error = new Error(message);
  if (code) error.code = code;
  if (status) error.status = status;
  return error;
}

function createSlotManager(options = {}) {
  const store = options.store;
  const shardx = options.shardx;
  const egress = options.egress;
  const runner = options.runner;
  const hub = options.hub || null;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const startedAt = Date.now();

  const launching = new Map();
  const activeTasks = new Map();
  const taskBySlot = new Map();
  const events = [];

  function broadcast(type, payload) {
    const frame = Object.assign({ type, at: Date.now() }, payload || {});
    events.push(frame);
    if (events.length > EVENT_RING) events.splice(0, events.length - EVENT_RING);
    if (hub) {
      try { hub.broadcast(type, payload || {}); } catch (error) { log(`[ws] 广播失败：${error.message}`); }
    }
    return frame;
  }

  function listEvents(limit = 100) {
    const count = Math.max(1, Math.min(Number(limit) || 100, EVENT_RING));
    return events.slice(-count).reverse();
  }

  function activeTaskFor(slotId) {
    const taskId = taskBySlot.get(String(slotId || ''));
    if (!taskId) return null;
    return store.getTask(taskId);
  }

  function latestTaskFor(slotId) {
    const active = activeTaskFor(slotId);
    if (active) return active;
    const list = store.listTasks({ matrixSlotId: slotId, limit: 1 });
    return list.length ? list[0] : null;
  }

  function slotView(binding) {
    const slotId = binding.matrixSlotId;
    const cached = egress.cachedSlot(slotId);
    const session = runner.getSession(binding.profileId);
    const task = latestTaskFor(slotId);
    const browserState = session
      ? 'RUNNING'
      : contract.normalizeBrowserState(binding.browserState, 'STOPPED');
    return {
      matrixSlotId: slotId,
      egressPort: binding.egressPort,
      bound: true,
      profileId: binding.profileId,
      profileName: binding.profileName,
      routingPlane: cached ? cached.routingPlane : 'ELASTIC_DATA',
      healthState: cached ? cached.healthState : binding.healthState,
      egressFingerprint: cached ? cached.egressFingerprint : binding.egressFingerprint,
      leaseId: cached ? cached.leaseId : (binding.egressFingerprint && binding.egressFingerprint.leaseId) || '',
      browser: {
        state: browserState,
        cdpAttached: Boolean(session),
        engine: session ? session.engine : '',
        pageUrl: binding.lastUrl || '',
        pageTitle: binding.lastTitle || '',
        pid: Number(binding.pid) || 0,
        attachedAt: session ? session.attachedAt : 0,
        frozen: egress.isFrozen(slotId),
      },
      task: task ? {
        id: task.id,
        status: task.status,
        stepsDone: task.stepsDone,
        stepsTotal: task.stepsTotal,
        startedAt: task.startedAt,
      } : null,
      credentials: store.hasCredentials(slotId),
      lastError: binding.lastError || (session && session.lastError) || '',
      updatedAt: binding.updatedAt,
    };
  }

  function unboundView(matrixSlotId) {
    return {
      matrixSlotId,
      egressPort: contract.egressPortForSlotId(matrixSlotId),
      bound: false,
      profileId: '',
      profileName: '',
      routingPlane: 'ELASTIC_DATA',
      healthState: 'UNKNOWN',
      egressFingerprint: contract.emptyFingerprint(),
      leaseId: '',
      browser: {
        state: 'STOPPED',
        cdpAttached: false,
        engine: '',
        pageUrl: '',
        pageTitle: '',
        pid: 0,
        attachedAt: 0,
        frozen: false,
      },
      task: null,
      credentials: false,
      lastError: '',
      updatedAt: 0,
    };
  }

  function listSlots(options2 = {}) {
    const includeUnbound = options2.includeUnbound !== false;
    const bindings = store.listBindings();
    const bySlot = new Map(bindings.map((binding) => [binding.matrixSlotId, binding]));
    const slots = [];
    for (let index = contract.SLOT_MIN_INDEX; index <= contract.SLOT_MAX_INDEX; index += 1) {
      const slotId = contract.slotIdForIndex(index);
      const binding = bySlot.get(slotId);
      if (binding) {
        slots.push(slotView(binding));
      } else if (includeUnbound) {
        slots.push(unboundView(slotId));
      }
    }
    return slots;
  }

  function getSlotView(matrixSlotId) {
    const slotId = contract.assertSlotId(matrixSlotId);
    const binding = store.getBinding(slotId);
    return binding ? slotView(binding) : unboundView(slotId);
  }

  async function refreshPageState(matrixSlotId) {
    const binding = store.getBinding(matrixSlotId);
    if (!binding) return;
    const session = runner.getSession(binding.profileId);
    if (!session) return;
    const info = await runner.pageInfo(binding.profileId).catch(() => null);
    if (!info) return;
    await store.touchBinding(matrixSlotId, {
      lastUrl: info.url || '',
      lastTitle: info.title || '',
    }).catch(() => {});
  }

  async function doLaunch(matrixSlotId, binding, launchOptions = {}) {
    const settings = store.getSettings();
    const startUrl = String(launchOptions.startUrl || settings.defaultStartUrl || 'about:blank');
    await store.touchBinding(matrixSlotId, {
      browserState: 'LAUNCHING',
      lastError: '',
    });
    broadcast('slot.updated', { slot: slotView(store.getBinding(matrixSlotId)) });
    broadcast('slot.launching', { matrixSlotId, profileId: binding.profileId });
    log(`[slot] ${matrixSlotId} 启动 ${binding.profileId}（${binding.profileName}）`);

    let lease = null;
    try {
      if (settings.requireEgressLease) {
        lease = await egress.lease(matrixSlotId);
        await store.touchBinding(matrixSlotId, {
          healthState: lease.healthState,
          egressFingerprint: lease.egressFingerprint,
        });
      } else {
        lease = egress.cachedSlot(matrixSlotId);
      }

      let wsUrl = '';
      if (lease) {
        const proxy = await shardx.ensureSlotProxy(matrixSlotId);
        await shardx.alignProfileToLease(binding.profileId, lease, proxy.id);
        log(`[slot] ${matrixSlotId} 代理已对齐 127.0.0.1:${lease.egressPort}，时区 ${lease.country || 'UTC'}`);
      }

      const profile = await shardx.getProfile(binding.profileId);
      if (profile.running) {
        wsUrl = String(
          (profile.cdp && (profile.cdp.web_socket_debugger_url || profile.cdp.webSocketDebuggerUrl))
          || profile.web_socket_debugger_url
          || '',
        );
      } else {
        const started = await shardx.startProfile(binding.profileId, { headless: settings.headless });
        wsUrl = String(
          (started && started.cdp && (started.cdp.web_socket_debugger_url || started.cdp.webSocketDebuggerUrl))
          || (started && started.web_socket_debugger_url)
          || '',
        );
      }
      if (!wsUrl) {
        const resolved = await shardx.waitForCdp(binding.profileId, {
          timeoutMs: settings.launchTimeoutMs,
        });
        wsUrl = resolved.wsUrl;
      }

      const session = await runner.attach(binding.profileId, {
        wsUrl,
        matrixSlotId,
        timeoutMs: settings.launchTimeoutMs,
      });

      if (startUrl && startUrl !== 'about:blank') {
        await runner.runStep(binding.profileId, {
          action: 'goto',
          url: startUrl,
          timeoutMs: settings.launchTimeoutMs,
          minDelayMs: 0,
          maxDelayMs: 0,
        }, { stepIndex: 0, results: {} });
      }

      const info = await runner.pageInfo(binding.profileId).catch(() => ({ url: startUrl, title: '' }));
      const updated = await store.touchBinding(matrixSlotId, {
        browserState: 'RUNNING',
        healthState: lease ? lease.healthState : 'ACTIVE',
        lastLaunchAt: Date.now(),
        lastUrl: info.url || startUrl,
        lastTitle: info.title || '',
        egressFingerprint: lease ? lease.egressFingerprint : store.getBinding(matrixSlotId).egressFingerprint,
        lastError: '',
      });
      await store.bumpCounter('launches').catch(() => {});
      broadcast('slot.launched', {
        matrixSlotId,
        profileId: binding.profileId,
        engine: session.engine,
        url: info.url,
      });
      broadcast('slot.updated', { slot: slotView(updated) });
      return slotView(updated);
    } catch (error) {
      log(`[slot] ${matrixSlotId} 启动失败：${error.message}`);
      const failed = await store.touchBinding(matrixSlotId, {
        browserState: 'ERROR',
        lastError: error.message,
      }).catch(() => store.getBinding(matrixSlotId));
      broadcast('slot.failed', { matrixSlotId, message: error.message });
      broadcast('slot.updated', { slot: slotView(failed) });
      throw error;
    }
  }

  async function launchSlot(matrixSlotId, launchOptions = {}) {
    const slotId = contract.assertSlotId(matrixSlotId);
    const binding = store.getBinding(slotId);
    if (!binding) throw createError(`槽位 ${slotId} 还没有绑定 Profile`, 'binding_missing', 404);
    if (runner.getSession(binding.profileId)) {
      return getSlotView(slotId);
    }
    if (launching.has(slotId)) return launching.get(slotId);
    const promise = doLaunch(slotId, binding, launchOptions).finally(() => launching.delete(slotId));
    launching.set(slotId, promise);
    return promise;
  }

  async function ensureSession(matrixSlotId) {
    const slotId = contract.assertSlotId(matrixSlotId);
    const binding = store.getBinding(slotId);
    if (!binding) throw createError(`槽位 ${slotId} 还没有绑定 Profile`, 'binding_missing', 404);
    let session = runner.getSession(binding.profileId);
    if (session) return { binding, session };
    await launchSlot(slotId, {});
    session = runner.getSession(binding.profileId);
    if (!session) {
      throw createError(`槽位 ${slotId} 启动后仍没有 CDP 会话`, 'session_missing', 502);
    }
    return { binding: store.getBinding(slotId), session };
  }

  async function closeSlot(matrixSlotId, closeOptions = {}) {
    const slotId = contract.assertSlotId(matrixSlotId);
    const binding = store.getBinding(slotId);
    if (!binding) throw createError(`槽位 ${slotId} 还没有绑定 Profile`, 'binding_missing', 404);

    const activeTaskId = taskBySlot.get(slotId);
    if (activeTaskId) cancelTask(activeTaskId, '槽位休眠，任务取消');

    await runner.detach(binding.profileId).catch(() => {});
    try {
      await shardx.stopProfile(binding.profileId);
    } catch (error) {
      log(`[slot] ${slotId} 停止 Profile 失败：${error.message}`);
    }
    const updated = await store.touchBinding(slotId, {
      browserState: 'STOPPED',
      lastUrl: closeOptions.keepUrl ? binding.lastUrl : '',
      lastTitle: closeOptions.keepUrl ? binding.lastTitle : '',
      lastError: '',
    });
    await store.bumpCounter('sleeps').catch(() => {});
    broadcast('slot.closed', { matrixSlotId: slotId, profileId: binding.profileId });
    broadcast('slot.updated', { slot: slotView(updated) });
    return slotView(updated);
  }

  async function sleepAll() {
    const bindings = store.listBindings();
    const results = [];
    for (const binding of bindings) {
      try {
        const view = await closeSlot(binding.matrixSlotId);
        results.push({ matrixSlotId: binding.matrixSlotId, ok: true, view });
      } catch (error) {
        results.push({ matrixSlotId: binding.matrixSlotId, ok: false, error: error.message });
      }
    }
    return { total: bindings.length, results };
  }

  function cancelTask(taskId, reason) {
    const entry = activeTasks.get(String(taskId || ''));
    if (!entry) return false;
    entry.reason = String(reason || '用户取消');
    entry.controller.abort();
    return true;
  }

  async function runTask(matrixSlotId, steps, taskOptions = {}) {
    const slotId = contract.assertSlotId(matrixSlotId);
    const list = Array.isArray(steps) ? steps.filter((step) => step && typeof step === 'object') : [];
    if (!list.length) throw createError('task/execute 需要至少一个步骤', 'steps_required', 400);
    const { binding } = await ensureSession(slotId);
    const settings = store.getSettings();

    const task = await store.createTask({
      matrixSlotId: slotId,
      profileId: binding.profileId,
      steps: list,
    });
    const controller = new AbortController();
    const entry = { taskId: task.id, slotId, controller, reason: '' };
    activeTasks.set(task.id, entry);
    taskBySlot.set(slotId, task.id);

    await store.updateTask(task.id, { status: 'RUNNING' });
    broadcast('task.started', {
      matrixSlotId: slotId,
      taskId: task.id,
      stepsTotal: list.length,
      source: String(taskOptions.source || 'panel'),
    });
    broadcast('slot.updated', { slot: slotView(store.getBinding(slotId)) });

    const results = {};
    const stepResults = [];
    let currentStep = -1;

    const runnerForSteps = scheduler.createStepRunner({
      minMs: settings.poissonMinMs,
      maxMs: settings.poissonMaxMs,
      barrier: async () => {
        await egress.waitForUnfrozen(slotId, settings.freezeTimeoutMs);
      },
      onLog: (message, meta) => {
        const stepIndex = meta && Number.isInteger(meta.stepIndex) ? meta.stepIndex : undefined;
        store.appendTaskLog(task.id, { level: 'info', message, stepIndex }).catch(() => {});
        broadcast('task.log', {
          matrixSlotId: slotId,
          taskId: task.id,
          level: 'info',
          message,
          stepsDone: Math.max(0, currentStep + 1),
          stepsTotal: list.length,
          stepIndex,
        });
      },
      onStep: async (step, index, context) => {
        currentStep = index;
        const attemptLimit = Math.max(1, Math.min(Number(step.retries) || 1, 5));
        let lastError = null;
        for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
          try {
            return await runner.runStep(binding.profileId, step, {
              stepIndex: index,
              results,
              signal: context.signal,
              attempt,
            });
          } catch (error) {
            lastError = error;
            if (attempt >= attemptLimit) break;
            const backoff = Math.min(4000, 400 * attempt);
            store.appendTaskLog(task.id, {
              level: 'warn',
              message: `第 ${index + 1} 步失败，${backoff}ms 后重试（${attempt}/${attemptLimit - 1}）：${error.message}`,
              stepIndex: index,
            }).catch(() => {});
            broadcast('task.log', {
              matrixSlotId: slotId,
              taskId: task.id,
              level: 'warn',
              message: `重试 ${attempt}/${attemptLimit - 1}：${error.message}`,
              stepsDone: index,
              stepsTotal: list.length,
            });
            await scheduler.sleep(backoff);
          }
        }
        throw lastError;
      },
    });

    try {
      const settled = await runnerForSteps.run(slotId, list, { signal: controller.signal, results });
      stepResults.push(...settled);
      await store.updateTask(task.id, { stepsDone: list.length });
      const finished = await store.finishTask(task.id, {
        status: 'DONE',
        result: { ok: true, results, steps: settled },
      });
      await refreshPageState(slotId);
      broadcast('task.done', { task: publicTask(finished) });
      broadcast('slot.updated', { slot: slotView(store.getBinding(slotId)) });
      return finished;
    } catch (error) {
      const aborted = controller.signal.aborted || error.code === 'ABORT_ERR';
      const finished = await store.finishTask(task.id, {
        status: aborted ? 'CANCELLED' : 'FAILED',
        error: aborted ? (entry.reason || '任务已取消') : error.message,
        result: { ok: false, results, error: error.message },
      });
      await refreshPageState(slotId);
      broadcast('task.done', { task: publicTask(finished) });
      broadcast('slot.updated', { slot: slotView(store.getBinding(slotId)) });
      if (!aborted) log(`[task] ${task.id} 失败：${error.message}`);
      return finished;
    } finally {
      activeTasks.delete(task.id);
      if (taskBySlot.get(slotId) === task.id) taskBySlot.delete(slotId);
    }
  }

  function publicTask(task) {
    if (!task) return null;
    const copy = Object.assign({}, task);
    delete copy.log;
    return copy;
  }

  async function observeSlot(matrixSlotId) {
    const slotId = contract.assertSlotId(matrixSlotId);
    const { binding } = await ensureSession(slotId);
    await beforeActionFor(slotId);
    const snapshot = await runner.observe(binding.profileId);
    await store.touchBinding(slotId, {
      lastUrl: snapshot.url,
      lastTitle: snapshot.title,
    }).catch(() => {});
    broadcast('slot.updated', { slot: slotView(store.getBinding(slotId)) });
    return snapshot;
  }

  async function actSlot(matrixSlotId, payload) {
    const slotId = contract.assertSlotId(matrixSlotId);
    const { binding } = await ensureSession(slotId);
    const step = Object.assign({}, payload || {});
    if (step.action === undefined) throw createError('page/act 需要 action', 'action_required', 400);
    const result = await runner.runStep(binding.profileId, step, { stepIndex: 0, results: {} });
    if (['goto', 'click', 'press', 'scroll'].includes(String(step.action).toLowerCase())) {
      await refreshPageState(slotId);
    }
    broadcast('slot.updated', { slot: slotView(store.getBinding(slotId)) });
    return result;
  }

  async function beforeActionFor(slotId) {
    const settings = store.getSettings();
    await egress.waitForUnfrozen(slotId, settings.freezeTimeoutMs);
  }

  async function screenshotSlot(matrixSlotId, screenshotOptions = {}) {
    const slotId = contract.assertSlotId(matrixSlotId);
    const { binding } = await ensureSession(slotId);
    const shot = await runner.screenshot(binding.profileId, screenshotOptions);
    return {
      matrixSlotId: slotId,
      profileId: binding.profileId,
      dataUrl: shot.dataUrl,
      capturedAt: shot.capturedAt,
      saved: shot.saved,
    };
  }

  async function syncProxy(matrixSlotId) {
    const slotId = contract.assertSlotId(matrixSlotId);
    const binding = store.getBinding(slotId);
    if (!binding) throw createError(`槽位 ${slotId} 还没有绑定 Profile`, 'binding_missing', 404);
    const lease = await egress.lease(slotId);
    const proxy = await shardx.ensureSlotProxy(slotId);
    await shardx.alignProfileToLease(binding.profileId, lease, proxy.id);
    const updated = await store.touchBinding(slotId, {
      healthState: lease.healthState,
      egressFingerprint: lease.egressFingerprint,
      lastError: '',
    });
    broadcast('slot.updated', { slot: slotView(updated) });
    return {
      matrixSlotId: slotId,
      profileId: binding.profileId,
      proxyId: proxy.id,
      egressPort: lease.egressPort,
      healthState: lease.healthState,
      egressFingerprint: lease.egressFingerprint,
    };
  }

  async function syncAllProxies() {
    const bindings = store.listBindings();
    const results = [];
    for (const binding of bindings) {
      try {
        results.push(Object.assign({ ok: true }, await syncProxy(binding.matrixSlotId)));
      } catch (error) {
        results.push({ ok: false, matrixSlotId: binding.matrixSlotId, error: error.message });
      }
    }
    return { total: bindings.length, synced: results.filter((item) => item.ok).length, results };
  }

  function normalizeCookieList(input, fallback = {}) {
    const cookies = [];
    if (Array.isArray(input)) {
      for (const item of input) {
        if (!item || typeof item !== 'object') continue;
        if (!item.name) continue;
        cookies.push({
          name: String(item.name),
          value: String(item.value === undefined ? '' : item.value),
          domain: String(item.domain || fallback.domain || ''),
          path: String(item.path || fallback.path || '/'),
          url: item.url ? String(item.url) : (fallback.url ? String(fallback.url) : ''),
          secure: Boolean(item.secure),
          httpOnly: Boolean(item.httpOnly),
          sameSite: item.sameSite ? String(item.sameSite) : undefined,
          expires: Number(item.expires) || undefined,
        });
      }
      return cookies;
    }
    const text = String(input || '').trim();
    if (!text) return cookies;
    for (const pair of text.split(';')) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const split = trimmed.indexOf('=');
      if (split < 0) continue;
      cookies.push({
        name: trimmed.slice(0, split).trim(),
        value: trimmed.slice(split + 1).trim(),
        domain: String(fallback.domain || ''),
        path: String(fallback.path || '/'),
        url: fallback.url ? String(fallback.url) : '',
        secure: Boolean(fallback.secure),
        httpOnly: Boolean(fallback.httpOnly),
      });
    }
    return cookies;
  }

  async function fetchSiblingCredentials(source) {
    const settings = store.getSettings();
    const base = source === 'cloudflare' ? settings.cloudflareBusUrl : settings.instaboxBusUrl;
    const prefix = source === 'cloudflare' ? 'cf' : 'instabox';
    const paths = [
      `/api/v1/${prefix}/credentials/export`,
      `/api/v1/${prefix}/cookies/export`,
    ];
    let lastError = '';
    for (const pathname of paths) {
      try {
        const response = await requestJson(`${base}${pathname}`, { timeoutMs: 5000, allowNon2xx: true });
        if (response.status >= 200 && response.status < 300 && response.body) {
          return response.body;
        }
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error.message;
      }
    }
    throw createError(
      `从 ${source} 导出 Cookie 失败${lastError ? `：${lastError}` : ''}`,
      'sibling_credentials_unavailable',
      503,
    );
  }

  async function importCookies(matrixSlotId, importOptions = {}) {
    const slotId = contract.assertSlotId(matrixSlotId);
    const { binding } = await ensureSession(slotId);
    const source = String(importOptions.source || 'store');
    let bundle = null;
    if (importOptions.cookies) bundle = importOptions;
    else if (source === 'cloudflare' || source === 'instabox') bundle = await fetchSiblingCredentials(source);
    else bundle = store.getCredentials(slotId);

    if (!bundle) {
      throw createError(`槽位 ${slotId} 没有可导入的凭据`, 'credentials_missing', 404);
    }
    const payload = bundle.cookies || bundle.cookieString || bundle.cookie || bundle;
    const cookies = normalizeCookieList(payload, {
      domain: importOptions.domain,
      url: importOptions.url || store.getBinding(slotId).lastUrl,
      secure: true,
    });
    if (!cookies.length) {
      throw createError('凭据里没有可用的 Cookie', 'credentials_empty', 400);
    }
    const applied = await runner.setCookies(binding.profileId, cookies);
    await store.touchBinding(slotId, { credentialsUpdatedAt: Date.now() });
    broadcast('slot.updated', { slot: slotView(store.getBinding(slotId)) });
    return {
      matrixSlotId: slotId,
      profileId: binding.profileId,
      source,
      applied,
      names: cookies.map((cookie) => cookie.name),
    };
  }

  function handleEgressEvent(event) {
    if (!event || !event.slotId) return;
    if (event.type === 'freeze') {
      const reason = event.entry ? event.entry.reason : 'rotation';
      broadcast('rotation.freeze', { matrixSlotId: event.slotId, reason });
      broadcast('slot.updated', { slot: getSlotView(event.slotId) });
      if (hub && typeof hub.broadcastAwait === 'function') {
        hub.broadcastAwait('PRE_ROTATION_FREEZE', {
          matrixSlotId: event.slotId,
          eventId: event.entry ? event.entry.eventId : '',
          reason,
          source: 'egress',
        }, { timeoutMs: 4000 }).then((result) => {
          if (result && result.timedOut) {
            log(`[egress] ${event.slotId} 冻结 ACK 超时：${result.results.filter((item) => !item.ok).length} 个客户端未响应`);
          }
        }).catch(() => {});
      }
      store.touchBinding(event.slotId, { healthState: 'ROTATING' }).catch(() => {});
      return;
    }
    if (event.type === 'resume') {
      broadcast('rotation.resume', { matrixSlotId: event.slotId });
      broadcast('slot.updated', { slot: getSlotView(event.slotId) });
      if (hub && typeof hub.broadcast === 'function') {
        hub.broadcast('POST_ROTATION_RESUME', { matrixSlotId: event.slotId, source: 'egress' });
      }
      store.touchBinding(event.slotId, { healthState: 'ACTIVE' }).catch(() => {});
      return;
    }
    if (event.type === 'rotation_failed') {
      broadcast('rotation.failed', {
        matrixSlotId: event.slotId,
        message: event.message && (event.message.reason || event.message.message || '') || 'rotation failed',
      });
    }
  }

  function status() {
    const bindings = store.listBindings();
    return {
      service: contract.SHARDX_SERVICE_ID,
      uptimeMs: Date.now() - startedAt,
      boundSlots: bindings.length,
      runningProfiles: runner.listSessions().length,
      activeTasks: activeTasks.size,
      launching: launching.size,
      wsClients: hub ? hub.clientCount : 0,
      engine: runner.engine,
      hasPlaywright: Boolean(runner.hasPlaywright),
      egress: egress.status(),
      events: events.length,
    };
  }

  async function shutdown() {
    for (const entry of [...activeTasks.values()]) {
      entry.controller.abort();
    }
    await runner.closeAll().catch(() => {});
  }

  return {
    listSlots,
    getSlotView,
    launchSlot,
    closeSlot,
    sleepAll,
    runTask,
    cancelTask,
    observeSlot,
    actSlot,
    screenshotSlot,
    syncProxy,
    syncAllProxies,
    importCookies,
    handleEgressEvent,
    listEvents,
    listTasks: (listOptions) => store.listTasks(listOptions),
    status,
    shutdown,
    get activeTaskCount() {
      return activeTasks.size;
    },
    get runningProfileCount() {
      return runner.listSessions().length;
    },
  };
}

module.exports = { createSlotManager };
