'use strict';

/*
 * Client for the local OpenChamber egress matrix bus (`127.0.0.1:19880`).
 *
 * The bus owns matrix slots, exit leases and the rotation freeze
 * choreography. This module is the only place the ShardX matrix reads an
 * exit identity, and it fails closed:
 *
 *   - unreachable bus              -> ERR_EGRESS_UNAVAILABLE (503)
 *   - slot QUARANTINED/ROTATING    -> ERR_EGRESS_SLOT_BLOCKED (503)
 *   - PRE_ROTATION_FREEZE seen     -> browser actions wait for resume,
 *                                     the client answers ACK_FREEZE at once
 */

const contract = require('../core/contract');
const { requestJson } = require('./http-client');
const { connect: wsConnect } = require('./ws');

const DEFAULT_TIMEOUT_MS = 4000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

class EgressError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = options.name || 'EgressError';
    if (options.code) this.code = options.code;
    if (options.status) this.status = options.status;
    if (options.cause) this.cause = options.cause;
  }
}

function unavailable(cause) {
  return new EgressError(
    `egress 总线不可达${cause && cause.message ? `：${cause.message}` : ''}`,
    { code: 'ERR_EGRESS_UNAVAILABLE', status: 503, cause },
  );
}

function normalizeLease(raw, matrixSlotId) {
  const payload = raw && typeof raw === 'object' ? raw : {};
  const slot = payload.slot && typeof payload.slot === 'object' ? payload.slot : null;
  const lease = payload.lease && typeof payload.lease === 'object' ? payload.lease : null;
  const merged = Object.assign({}, slot || {}, lease || {}, payload);
  const slotId = contract.indexForSlotId(merged.matrixSlotId || matrixSlotId)
    ? (merged.matrixSlotId || matrixSlotId)
    : matrixSlotId;
  const record = {
    matrixSlotId: slotId,
    egressPort: Number(merged.egressPort) || contract.egressPortForSlotId(slotId),
    routingPlane: contract.normalizeRoutingPlane(merged.routingPlane, 'ELASTIC_DATA'),
    healthState: contract.normalizeHealthState(merged.healthState, 'ACTIVE'),
    egressFingerprint: contract.normalizeFingerprint(
      merged.egressFingerprint || (lease && lease.egressFingerprint) || {},
      merged.leaseId || (lease && lease.leaseId) || '',
    ),
    leaseId: String(merged.leaseId || (lease && lease.leaseId) || ''),
    country: String(merged.country || (lease && lease.country) || ''),
    provider: String(merged.provider || (lease && lease.provider) || ''),
    raw: payload,
  };
  return record;
}

function slotIdOf(message) {
  if (!message || typeof message !== 'object') return '';
  if (contract.indexForSlotId(message.matrixSlotId)) return message.matrixSlotId;
  if (contract.indexForSlotId(message.slotId)) return message.slotId;
  if (message.slot && contract.indexForSlotId(message.slot.matrixSlotId)) return message.slot.matrixSlotId;
  const port = Number(message.egressPort || (message.slot && message.slot.egressPort));
  if (port) return contract.matrixSlotIdForPort(port);
  return '';
}

function createEgressClient(options = {}) {
  const baseUrl = contract.normalizeServiceBase(options.baseUrl, contract.EGRESS_BUS_URL);
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const freezeTimeoutMs = Number(options.freezeTimeoutMs) || 30000;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};

  const wsUrl = `${baseUrl.replace(/^http/, 'ws')}${contract.EGRESS_WS_PATH}?clientId=shardx-matrix-${process.pid}`;
  const frozen = new Map();
  const waiters = new Map();
  const leaseCache = new Map();

  let conn = null;
  let connected = false;
  let stopped = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let lastEventAt = 0;
  let lastError = '';

  async function getJson(pathname) {
    try {
      const response = await requestJson(`${baseUrl}${pathname}`, { timeoutMs });
      return response.body;
    } catch (cause) {
      if (cause && cause.code === 'ERR_EGRESS_UNAVAILABLE') throw cause;
      throw unavailable(cause);
    }
  }

  async function health() {
    const started = Date.now();
    try {
      const body = await getJson(contract.EGRESS_HEALTH_PATH);
      return { ok: true, latencyMs: Date.now() - started, body, baseUrl };
    } catch (cause) {
      return { ok: false, latencyMs: Date.now() - started, error: cause.message, code: cause.code, baseUrl };
    }
  }

  async function slots() {
    const body = await getJson(contract.EGRESS_SLOTS_PATH);
    const list = Array.isArray(body) ? body : (body && Array.isArray(body.slots) ? body.slots : []);
    return list.map((entry) => {
      const slotId = slotIdOf(entry);
      return slotId ? normalizeLease(entry, slotId) : null;
    }).filter(Boolean);
  }

  async function lease(matrixSlotId) {
    const slotId = contract.assertSlotId(matrixSlotId);
    let payload;
    try {
      const response = await requestJson(`${baseUrl}/api/v1/egress/lease/${slotId}`, {
        timeoutMs,
        allowNon2xx: true,
      });
      payload = response.body;
      if (response.status === 404) {
        throw new EgressError(`egress 上没有 ${slotId} 的租约`, {
          code: 'ERR_EGRESS_LEASE_MISSING',
          status: 404,
        });
      }
      if (response.status < 200 || response.status >= 300) {
        throw unavailable(new Error(`HTTP ${response.status}`));
      }
    } catch (cause) {
      if (cause instanceof EgressError) throw cause;
      throw unavailable(cause);
    }

    const record = normalizeLease(payload, slotId);
    if (contract.isBlockedHealthState(record.healthState)) {
      throw new EgressError(
        `${slotId} 当前 ${record.healthState}，egress 禁止下发控制面流量`,
        { code: 'ERR_EGRESS_SLOT_BLOCKED', status: 503 },
      );
    }
    leaseCache.set(slotId, { record, at: Date.now() });
    return record;
  }

  function cachedSlot(matrixSlotId) {
    const entry = leaseCache.get(String(matrixSlotId || ''));
    return entry ? entry.record : null;
  }

  function isFrozen(matrixSlotId) {
    return frozen.has(String(matrixSlotId || ''));
  }

  function resolveWaiters(slotId) {
    const list = waiters.get(slotId);
    if (!list) return;
    waiters.delete(slotId);
    for (const waiter of list) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  function freeze(slotId, message) {
    if (!slotId) return;
    const entry = {
      slotId,
      at: Date.now(),
      eventId: String((message && message.eventId) || ''),
      reason: String((message && (message.reason || message.message)) || 'rotation'),
    };
    frozen.set(slotId, entry);
    lastEventAt = Date.now();
    log(`[egress] ${slotId} 进入换血冻结：${entry.reason}`);
    onEvent({ type: 'freeze', slotId, entry });
    if (conn && conn.isOpen) {
      try {
        conn.sendText(JSON.stringify({
          type: 'ACK_FREEZE',
          eventId: entry.eventId,
          clientId: `shardx-matrix-${process.pid}`,
          ok: true,
          at: Date.now(),
        }));
      } catch { /* reconnect will follow */ }
    }
  }

  function resume(slotId, message) {
    if (!slotId) return;
    if (!frozen.has(slotId)) return;
    frozen.delete(slotId);
    lastEventAt = Date.now();
    log(`[egress] ${slotId} 换血完成，恢复任务`);
    onEvent({ type: 'resume', slotId, message: message || null });
    resolveWaiters(slotId);
  }

  function handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    const type = String(message.type || '');
    const slotId = slotIdOf(message);
    if (type === 'PRE_ROTATION_FREEZE' || type === 'ROTATION_FREEZE') {
      freeze(slotId, message);
      return;
    }
    if (type === 'POST_ROTATION_RESUME' || type === 'ROTATION_RESUME') {
      resume(slotId, message);
      return;
    }
    if (type === 'ROTATION_FAILED') {
      const entry = frozen.get(slotId);
      if (!entry) return;
      entry.reason = `换血失败：${String(message.reason || message.message || 'unknown')}`;
      entry.failed = true;
      onEvent({ type: 'rotation_failed', slotId, message });
      resolveWaiters(slotId);
      frozen.delete(slotId);
      return;
    }
    if (type === 'PONG') return;
  }

  function scheduleReconnect() {
    if (stopped) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * Math.max(1, reconnectAttempts + 1));
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectBus().catch(() => {});
    }, delay);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  async function reconcileAfterReconnect() {
    for (const slotId of [...frozen.keys()]) {
      try {
        const record = await lease(slotId);
        if (!contract.isBlockedHealthState(record.healthState)) {
          resume(slotId, { type: 'POST_ROTATION_RESUME', reason: 'reconciled' });
        }
      } catch { /* keep frozen until the next resume */ }
    }
  }

  async function connectBus() {
    if (stopped) return;
    if (conn && conn.isOpen) return;
    try {
      const next = await wsConnect(wsUrl, { timeoutMs });
      conn = next;
      connected = true;
      reconnectAttempts = 0;
      lastError = '';
      next.on('message', ({ data, binary }) => {
        if (binary) return;
        let message;
        try { message = JSON.parse(data.toString('utf8')); } catch { return; }
        handleMessage(message);
      });
      next.on('close', () => {
        connected = false;
        conn = null;
        if (!stopped) {
          log('[egress] 总线连接断开，准备重连');
          scheduleReconnect();
        }
      });
      next.on('error', (error) => {
        lastError = error && error.message ? error.message : String(error);
      });
      log('[egress] 已连接换血总线');
      reconcileAfterReconnect().catch(() => {});
    } catch (cause) {
      connected = false;
      lastError = cause && cause.message ? cause.message : String(cause);
      scheduleReconnect();
    }
  }

  function start() {
    stopped = false;
    connectBus().catch(() => {});
    return { wsUrl, baseUrl };
  }

  function stop() {
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (conn) {
      try { conn.close(1000, 'service shutdown'); } catch { /* ignore */ }
      conn = null;
    }
    connected = false;
    for (const list of waiters.values()) {
      for (const waiter of list) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    }
    waiters.clear();
    frozen.clear();
  }

  function waitForUnfrozen(matrixSlotId, timeoutMsOverride) {
    const slotId = String(matrixSlotId || '');
    if (!slotId || !frozen.has(slotId)) return Promise.resolve();
    const budget = Number(timeoutMsOverride) || freezeTimeoutMs;
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          const list = waiters.get(slotId) || [];
          waiters.set(slotId, list.filter((item) => item !== waiter));
          reject(new EgressError(
            `${slotId} 换血冻结超过 ${budget}ms 仍未恢复`,
            { code: 'egress_rotation_timeout', status: 503 },
          ));
        }, Math.max(100, budget)),
      };
      if (waiter.timer.unref) waiter.timer.unref();
      const list = waiters.get(slotId) || [];
      list.push(waiter);
      waiters.set(slotId, list);
    });
  }

  function status() {
    return {
      baseUrl,
      wsUrl,
      connected,
      reconnectAttempts,
      frozenSlots: [...frozen.keys()],
      pendingWaiters: [...waiters.values()].reduce((sum, list) => sum + list.length, 0),
      lastEventAt,
      lastError,
    };
  }

  return {
    baseUrl,
    start,
    stop,
    health,
    slots,
    lease,
    cachedSlot,
    isFrozen,
    frozenSlots: () => [...frozen.keys()],
    waitForUnfrozen,
    status,
  };
}

module.exports = {
  createEgressClient,
  EgressError,
  normalizeLease,
  slotIdOf,
  unavailable,
};
