'use strict';

/*
 * Persistent state for the ShardX matrix.
 *
 *   matrix-state.json   bindings (slot <-> profile, 1:1), tasks, counters
 *   credentials.json    AES-256-GCM sealed cookie/session bundles
 *   secret.key          32 random bytes, base64url, mode 0600
 *   screenshots/        rolling per-slot captures
 *
 * Every read-modify-write goes through `withStateLock`, i.e. an in-process
 * mutex plus a cross-process lock file, and every write is atomic. A crashed
 * writer cannot leave a half-written JSON file behind.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const contract = require('./contract');
const {
  withStateLock,
  withFileLock,
  atomicWriteJson,
  atomicWriteFile,
  readJsonFile,
  ensureDir,
} = require('./store-lock');

const STATE_VERSION = 2;
const TASK_RING = 200;
const TASK_LOG_RING = 300;
const SCREENSHOT_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);

const DEFAULT_SETTINGS = Object.freeze({
  servicePort: 19884,
  defaultStartUrl: 'about:blank',
  headless: false,
  poissonMinMs: 400,
  poissonMaxMs: 1800,
  freezeTimeoutMs: 30000,
  launchTimeoutMs: 60000,
  requireEgressLease: true,
  egressBusUrl: contract.EGRESS_BUS_URL,
  cloudflareBusUrl: contract.CLOUDFLARE_BUS_URL,
  instaboxBusUrl: contract.INSTABOX_BUS_URL,
  screenshotRetention: 50,
});

function createError(message, code, status) {
  const error = new Error(message);
  if (code) error.code = code;
  if (status) error.status = status;
  return error;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function toInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const settings = Object.assign({}, DEFAULT_SETTINGS, source);
  settings.servicePort = clampInt(settings.servicePort, 1, 65535, DEFAULT_SETTINGS.servicePort);
  settings.poissonMinMs = clampInt(settings.poissonMinMs, 0, 60000, DEFAULT_SETTINGS.poissonMinMs);
  settings.poissonMaxMs = clampInt(settings.poissonMaxMs, 0, 60000, DEFAULT_SETTINGS.poissonMaxMs);
  if (settings.poissonMaxMs < settings.poissonMinMs) settings.poissonMaxMs = settings.poissonMinMs;
  settings.freezeTimeoutMs = clampInt(settings.freezeTimeoutMs, 1000, 600000, DEFAULT_SETTINGS.freezeTimeoutMs);
  settings.launchTimeoutMs = clampInt(settings.launchTimeoutMs, 1000, 600000, DEFAULT_SETTINGS.launchTimeoutMs);
  settings.screenshotRetention = clampInt(settings.screenshotRetention, 1, 500, DEFAULT_SETTINGS.screenshotRetention);
  settings.defaultStartUrl = String(settings.defaultStartUrl || DEFAULT_SETTINGS.defaultStartUrl).trim()
    || DEFAULT_SETTINGS.defaultStartUrl;
  settings.headless = Boolean(settings.headless);
  settings.requireEgressLease = settings.requireEgressLease !== false;
  settings.egressBusUrl = contract.normalizeServiceBase(settings.egressBusUrl, DEFAULT_SETTINGS.egressBusUrl);
  settings.cloudflareBusUrl = contract.normalizeServiceBase(settings.cloudflareBusUrl, DEFAULT_SETTINGS.cloudflareBusUrl);
  settings.instaboxBusUrl = contract.normalizeServiceBase(settings.instaboxBusUrl, DEFAULT_SETTINGS.instaboxBusUrl);
  return settings;
}

function clampInt(value, min, max, fallback) {
  const number = toInteger(value, NaN);
  if (!Number.isFinite(number)) return fallback;
  if (number < min) return min;
  if (number > max) return max;
  return number;
}

function normalizeCounters(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    launches: Math.max(0, toInteger(source.launches, 0)),
    tasks: Math.max(0, toInteger(source.tasks, 0)),
    sleeps: Math.max(0, toInteger(source.sleeps, 0)),
  };
}

function normalizeTaskEntry(raw) {
  const task = contract.normalizeTask(raw);
  const log = Array.isArray(raw && raw.log) ? raw.log : [];
  return Object.assign(task, {
    log: log
      .filter((entry) => entry && typeof entry === 'object')
      .slice(-TASK_LOG_RING)
      .map((entry) => ({
        at: Number(entry.at) || Date.now(),
        level: ['debug', 'info', 'warn', 'error'].includes(entry.level) ? entry.level : 'info',
        message: String(entry.message || '').slice(0, 4000),
        stepIndex: Number.isInteger(entry.stepIndex) ? entry.stepIndex : undefined,
        data: entry.data === undefined ? undefined : entry.data,
      })),
  });
}

function normalizeBindingEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!contract.indexForSlotId(raw.matrixSlotId)) return null;
  const profileId = contract.normalizeProfileId(raw.profileId);
  if (!profileId) return null;
  try {
    return contract.bindingRecord({
      matrixSlotId: raw.matrixSlotId,
      profileId,
      profileName: raw.profileName,
      source: raw.source,
      createdAt: raw.createdAt,
      lastLaunchAt: raw.lastLaunchAt,
      lastUrl: raw.lastUrl,
      lastTitle: raw.lastTitle,
      healthState: raw.healthState,
      browserState: raw.browserState,
      egressFingerprint: raw.egressFingerprint,
      credentialsUpdatedAt: raw.credentialsUpdatedAt,
      lastError: raw.lastError,
      notes: raw.notes,
    });
  } catch {
    return null;
  }
}

function emptyState() {
  const now = Date.now();
  return {
    version: STATE_VERSION,
    createdAt: now,
    updatedAt: now,
    settings: normalizeSettings({}),
    bindings: [],
    tasks: [],
    counters: normalizeCounters({}),
  };
}

function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  const bindings = Array.isArray(raw.bindings)
    ? raw.bindings.map(normalizeBindingEntry).filter(Boolean)
    : [];
  const seenSlots = new Set();
  const seenProfiles = new Set();
  const unique = [];
  for (const binding of bindings) {
    if (seenSlots.has(binding.matrixSlotId)) continue;
    if (seenProfiles.has(binding.profileId)) continue;
    seenSlots.add(binding.matrixSlotId);
    seenProfiles.add(binding.profileId);
    unique.push(binding);
  }
  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks.map(normalizeTaskEntry).filter((task) => task.id)
    : [];
  return {
    version: STATE_VERSION,
    createdAt: Number(raw.createdAt) || base.createdAt,
    updatedAt: Number(raw.updatedAt) || base.updatedAt,
    settings: normalizeSettings(raw.settings),
    bindings: unique,
    tasks: tasks.slice(-TASK_RING),
    counters: normalizeCounters(raw.counters),
  };
}

function normalizeKeyMaterial(value) {
  if (Buffer.isBuffer(value)) {
    if (value.length !== 32) throw createError('密钥长度必须是 32 字节', 'invalid_key');
    return value;
  }
  const text = String(value || '').trim();
  const decoded = Buffer.from(text, 'base64url');
  if (decoded.length === 32) return decoded;
  const fallback = Buffer.from(text, 'base64');
  if (fallback.length === 32) return fallback;
  throw createError('密钥必须是 32 字节的 base64url 字符串', 'invalid_key');
}

function aadFor(slotId) {
  return Buffer.from(`shardx-matrix:${slotId}`, 'utf8');
}

function encryptWithKey(key, plaintext, aad) {
  const material = normalizeKeyMaterial(key);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', material, iv);
  if (aad) cipher.setAAD(Buffer.isBuffer(aad) ? aad : Buffer.from(String(aad), 'utf8'));
  const data = Buffer.concat([cipher.update(Buffer.from(String(plaintext), 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: data.toString('base64'),
  };
}

function decryptWithKey(key, payload, aad) {
  const material = normalizeKeyMaterial(key);
  if (!payload || payload.alg !== 'aes-256-gcm') {
    throw createError('凭据格式不受支持', 'credentials_corrupt');
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', material, Buffer.from(payload.iv, 'base64'));
    if (aad) decipher.setAAD(Buffer.isBuffer(aad) ? aad : Buffer.from(String(aad), 'utf8'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]);
    return plain.toString('utf8');
  } catch (cause) {
    const error = createError('凭据解密失败，密钥或数据已损坏', 'credentials_corrupt', 500);
    error.cause = cause;
    throw error;
  }
}

function createProfileStore(options = {}) {
  const env = options.env || process.env;
  const stateDir = options.stateDir
    || env.SHARDX_MATRIX_STATE_DIR
    || path.join(options.home || os.homedir(), '.openchamber-shardx-matrix');
  ensureDir(stateDir, 0o700);

  const paths = {
    stateDir,
    stateFile: path.join(stateDir, 'matrix-state.json'),
    credentialsFile: path.join(stateDir, 'credentials.json'),
    keyFile: path.join(stateDir, 'secret.key'),
    screenshotsDir: path.join(stateDir, 'screenshots'),
  };

  ensureDir(paths.screenshotsDir, 0o700);

  const lockOptions = options.lockOptions || { timeoutMs: 20000, staleMs: 60000 };

  function readState() {
    return normalizeState(readJsonFile(paths.stateFile, null));
  }

  async function update(mutator) {
    return withStateLock(paths.stateFile, async () => {
      const state = readState();
      const result = await mutator(state);
      state.updatedAt = Date.now();
      const normalized = normalizeState(state);
      atomicWriteJson(paths.stateFile, normalized, { mode: 0o600 });
      return { state: clone(normalized), result: clone(result) };
    }, lockOptions).then(({ state }) => state);
  }

  function load() {
    return readState();
  }

  function getSettings() {
    return normalizeSettings(readState().settings);
  }

  async function updateSettings(patch) {
    if (!patch || typeof patch !== 'object') {
      throw createError('settings 必须是对象', 'invalid_settings', 400);
    }
    if (patch.servicePort !== undefined) {
      const port = Number(patch.servicePort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw createError('servicePort 必须是 1-65535 的整数', 'invalid_service_port', 400);
      }
    }
    if (patch.poissonMinMs !== undefined && patch.poissonMaxMs !== undefined) {
      const min = Number(patch.poissonMinMs);
      const max = Number(patch.poissonMaxMs);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
        throw createError('poissonMinMs 必须 ≤ poissonMaxMs 且非负', 'invalid_poisson_range', 400);
      }
    }
    const merged = Object.assign({}, readState().settings, patch);
    const settings = normalizeSettings(merged);
    await update((state) => {
      state.settings = settings;
      return settings;
    });
    return settings;
  }

  async function bind(input = {}) {
    const matrixSlotId = contract.assertSlotId(input.matrixSlotId);
    const profileId = contract.normalizeProfileId(input.profileId);
    if (!profileId) throw createError('profileId 不能为空', 'profile_id_required', 400);

    let conflict = null;
    let record = null;
    await update((state) => {
      const existingProfile = state.bindings.find((binding) => binding.profileId === profileId);
      if (existingProfile && existingProfile.matrixSlotId !== matrixSlotId) {
        conflict = createError(
          `Profile ${profileId} 已绑定到 ${existingProfile.matrixSlotId}，一个 Profile 只能占一个槽位`,
          'profile_already_bound',
          409,
        );
        return null;
      }
      const previous = state.bindings.find((binding) => binding.matrixSlotId === matrixSlotId);
      record = contract.bindingRecord({
        matrixSlotId,
        profileId,
        profileName: input.profileName || profileId,
        source: input.source || 'panel',
        createdAt: previous ? previous.createdAt : Date.now(),
        healthState: existingProfile ? existingProfile.healthState : 'ACTIVE',
        browserState: 'STOPPED',
      });
      record.credentialsUpdatedAt = state.bindings.find((binding) => binding.profileId === profileId)
        ? (state.bindings.find((binding) => binding.profileId === profileId).credentialsUpdatedAt || 0)
        : 0;
      state.bindings = state.bindings.filter((binding) => binding.matrixSlotId !== matrixSlotId);
      state.bindings.push(record);
      state.bindings.sort((a, b) => contract.indexForSlotId(a.matrixSlotId) - contract.indexForSlotId(b.matrixSlotId));
      return record;
    });
    if (conflict) throw conflict;
    return record;
  }

  async function unbind(matrixSlotId) {
    const slotId = contract.assertSlotId(matrixSlotId);
    let removed = null;
    await update((state) => {
      removed = state.bindings.find((binding) => binding.matrixSlotId === slotId) || null;
      state.bindings = state.bindings.filter((binding) => binding.matrixSlotId !== slotId);
      return removed;
    });
    return removed;
  }

  function getBinding(matrixSlotId) {
    const slotId = String(matrixSlotId || '');
    return readState().bindings.find((binding) => binding.matrixSlotId === slotId) || null;
  }

  function findBindingByProfile(profileId) {
    const id = contract.normalizeProfileId(profileId);
    if (!id) return null;
    return readState().bindings.find((binding) => binding.profileId === id) || null;
  }

  function listBindings() {
    return readState().bindings;
  }

  const TOUCH_FIELDS = new Set([
    'profileName',
    'lastLaunchAt',
    'lastUrl',
    'lastTitle',
    'healthState',
    'browserState',
    'egressFingerprint',
    'credentialsUpdatedAt',
    'lastError',
    'notes',
  ]);

  async function touchBinding(matrixSlotId, patch = {}) {
    const slotId = contract.assertSlotId(matrixSlotId);
    let updated = null;
    await update((state) => {
      const binding = state.bindings.find((entry) => entry.matrixSlotId === slotId);
      if (!binding) {
        throw createError(`槽位 ${slotId} 还没有绑定 Profile`, 'binding_missing', 404);
      }
      for (const [key, value] of Object.entries(patch)) {
        if (!TOUCH_FIELDS.has(key)) continue;
        if (key === 'healthState') binding.healthState = contract.normalizeHealthState(value, binding.healthState);
        else if (key === 'browserState') binding.browserState = contract.normalizeBrowserState(value, binding.browserState);
        else if (key === 'egressFingerprint') binding.egressFingerprint = contract.normalizeFingerprint(value, binding.egressFingerprint.leaseId);
        else if (key === 'lastLaunchAt' || key === 'credentialsUpdatedAt') binding[key] = Number(value) || 0;
        else if (key === 'lastError') binding.lastError = value ? String(value).slice(0, 500) : '';
        else binding[key] = String(value === undefined || value === null ? '' : value);
      }
      binding.updatedAt = Date.now();
      updated = clone(binding);
      return updated;
    });
    return updated;
  }

  async function bumpCounter(name, by = 1) {
    const key = String(name || '').trim();
    if (!['launches', 'tasks', 'sleeps'].includes(key)) {
      throw createError(`未知计数器：${key}`, 'invalid_counter', 400);
    }
    const amount = Number(by) || 1;
    let counters = null;
    await update((state) => {
      state.counters[key] = Math.max(0, (state.counters[key] || 0) + amount);
      counters = clone(state.counters);
      return counters;
    });
    return counters;
  }

  async function createTask(input = {}) {
    const matrixSlotId = input.matrixSlotId ? contract.assertSlotId(input.matrixSlotId) : '';
    const profileId = contract.normalizeProfileId(input.profileId);
    const steps = Array.isArray(input.steps) ? input.steps : [];
    const task = {
      id: `task-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      matrixSlotId,
      profileId,
      status: 'QUEUED',
      stepsTotal: steps.length,
      stepsDone: 0,
      startedAt: Date.now(),
      finishedAt: 0,
      error: '',
      result: null,
      log: [],
    };
    await update((state) => {
      state.tasks.push(task);
      if (state.tasks.length > TASK_RING) state.tasks = state.tasks.slice(-TASK_RING);
      state.counters.tasks += 1;
      return task;
    });
    return clone(task);
  }

  async function updateTask(id, patch = {}) {
    const taskId = String(id || '');
    let updated = null;
    await update((state) => {
      const task = state.tasks.find((entry) => entry.id === taskId);
      if (!task) return null;
      if (patch.status) task.status = contract.normalizeTaskState(patch.status, task.status);
      if (patch.stepsDone !== undefined) task.stepsDone = clampInt(patch.stepsDone, 0, task.stepsTotal, task.stepsDone);
      if (patch.stepsTotal !== undefined) task.stepsTotal = clampInt(patch.stepsTotal, 0, 10000, task.stepsTotal);
      if (patch.error !== undefined) task.error = patch.error ? String(patch.error).slice(0, 1000) : '';
      if (patch.result !== undefined) task.result = patch.result;
      if (patch.finishedAt !== undefined) task.finishedAt = Number(patch.finishedAt) || 0;
      updated = clone(task);
      return updated;
    });
    return updated;
  }

  async function appendTaskLog(id, entry = {}) {
    const taskId = String(id || '');
    const record = {
      at: Number(entry.at) || Date.now(),
      level: ['debug', 'info', 'warn', 'error'].includes(entry.level) ? entry.level : 'info',
      message: String(entry.message || '').slice(0, 4000),
    };
    if (Number.isInteger(entry.stepIndex)) record.stepIndex = entry.stepIndex;
    if (entry.data !== undefined) record.data = entry.data;
    let appended = null;
    await update((state) => {
      const task = state.tasks.find((item) => item.id === taskId);
      if (!task) return null;
      if (!Array.isArray(task.log)) task.log = [];
      task.log.push(record);
      if (task.log.length > TASK_LOG_RING) task.log = task.log.slice(-TASK_LOG_RING);
      appended = clone(record);
      return appended;
    });
    return appended;
  }

  async function finishTask(id, options = {}) {
    const taskId = String(id || '');
    const status = contract.normalizeTaskState(options.status, 'DONE');
    const finalStatus = ['DONE', 'FAILED', 'CANCELLED'].includes(status) ? status : 'DONE';
    let finished = null;
    await update((state) => {
      const task = state.tasks.find((entry) => entry.id === taskId);
      if (!task) return null;
      task.status = finalStatus;
      task.finishedAt = Number(options.finishedAt) || Date.now();
      if (finalStatus === 'DONE') task.stepsDone = task.stepsTotal;
      if (options.error !== undefined) task.error = options.error ? String(options.error).slice(0, 1000) : '';
      if (options.result !== undefined) task.result = options.result;
      if (!Array.isArray(task.log)) task.log = [];
      task.log.push({
        at: Date.now(),
        level: finalStatus === 'DONE' ? 'info' : 'error',
        message: finalStatus === 'DONE'
          ? `任务完成，共 ${task.stepsDone}/${task.stepsTotal} 步`
          : `任务${finalStatus === 'FAILED' ? '失败' : '取消'}：${task.error || '未提供原因'}`,
      });
      finished = clone(task);
      return finished;
    });
    return finished;
  }

  function getTask(id) {
    const taskId = String(id || '');
    return readState().tasks.find((entry) => entry.id === taskId) || null;
  }

  function listTasks(options = {}) {
    const limit = clampInt(options.limit, 1, TASK_RING, 50);
    const matrixSlotId = options.matrixSlotId ? contract.assertSlotId(options.matrixSlotId) : '';
    return readState()
      .tasks
      .filter((task) => !matrixSlotId || task.matrixSlotId === matrixSlotId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }

  function ensureKey() {
    if (fs.existsSync(paths.keyFile)) {
      const text = fs.readFileSync(paths.keyFile, 'utf8').trim();
      const key = normalizeKeyMaterial(text);
      return key;
    }
    const key = crypto.randomBytes(32);
    const release = withFileLock(`${paths.keyFile}.lock`, async () => {
      if (fs.existsSync(paths.keyFile)) return;
      atomicWriteFile(paths.keyFile, `${key.toString('base64url')}\n`, { mode: 0o600 });
    }, lockOptions);
    return release.then(() => {
      if (fs.existsSync(paths.keyFile)) {
        return normalizeKeyMaterial(fs.readFileSync(paths.keyFile, 'utf8').trim());
      }
      return key;
    });
  }

  function readKeySync() {
    if (!fs.existsSync(paths.keyFile)) {
      const key = crypto.randomBytes(32);
      atomicWriteFile(paths.keyFile, `${key.toString('base64url')}\n`, { mode: 0o600 });
      return key;
    }
    return normalizeKeyMaterial(fs.readFileSync(paths.keyFile, 'utf8').trim());
  }

  function readCredentialsFile() {
    const raw = readJsonFile(paths.credentialsFile, null);
    if (!raw || typeof raw !== 'object') return { version: 1, updatedAt: 0, entries: {} };
    return {
      version: Number(raw.version) || 1,
      updatedAt: Number(raw.updatedAt) || 0,
      entries: raw.entries && typeof raw.entries === 'object' ? raw.entries : {},
    };
  }

  async function setCredentials(matrixSlotId, payload, options2 = {}) {
    const slotId = contract.assertSlotId(matrixSlotId);
    if (payload === undefined || payload === null) {
      throw createError('凭据内容不能为空', 'credentials_required', 400);
    }
    const key = await ensureKey();
    const plaintext = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const sealed = encryptWithKey(key, plaintext, aadFor(slotId));
    await withFileLock(`${paths.credentialsFile}.lock`, async () => {
      const file = readCredentialsFile();
      file.entries[slotId] = Object.assign(sealed, {
        updatedAt: Date.now(),
        source: String(options2.source || 'manual'),
      });
      file.updatedAt = Date.now();
      atomicWriteJson(paths.credentialsFile, file, { mode: 0o600 });
    }, lockOptions);
    const binding = findBindingByProfile(options2.profileId) || getBinding(slotId);
    if (binding) {
      await touchBinding(slotId, { credentialsUpdatedAt: Date.now() });
    }
    const cookieList = payload && typeof payload === 'object' && Array.isArray(payload.cookies) ? payload.cookies : [];
    const names = cookieList.map((cookie) => String((cookie && cookie.name) || '')).filter(Boolean);
    return { slotId, updatedAt: Date.now(), source: String(options2.source || 'manual'), names };
  }

  function getCredentials(matrixSlotId) {
    const slotId = contract.assertSlotId(matrixSlotId);
    const file = readCredentialsFile();
    const entry = file.entries[slotId];
    if (!entry) return null;
    const key = readKeySync();
    const plaintext = decryptWithKey(key, entry, aadFor(slotId));
    try {
      return JSON.parse(plaintext);
    } catch (cause) {
      const error = createError('凭据内容不是合法 JSON', 'credentials_corrupt', 500);
      error.cause = cause;
      throw error;
    }
  }

  function hasCredentials(matrixSlotId) {
    const file = readCredentialsFile();
    return Boolean(file.entries[String(matrixSlotId || '')]);
  }

  function getCredentialMeta(matrixSlotId) {
    const entry = readCredentialsFile().entries[String(matrixSlotId || '')];
    if (!entry) return { exists: false, updatedAt: 0, source: '' };
    return { exists: true, updatedAt: Number(entry.updatedAt) || 0, source: String(entry.source || '') };
  }

  async function deleteCredentials(matrixSlotId) {
    const slotId = contract.assertSlotId(matrixSlotId);
    let removed = false;
    await withFileLock(`${paths.credentialsFile}.lock`, async () => {
      const file = readCredentialsFile();
      if (!file.entries[slotId]) return;
      delete file.entries[slotId];
      file.updatedAt = Date.now();
      atomicWriteJson(paths.credentialsFile, file, { mode: 0o600 });
      removed = true;
    }, lockOptions);
    return removed;
  }

  function listScreenshots(slotId) {
    let entries;
    try {
      entries = fs.readdirSync(paths.screenshotsDir);
    } catch {
      return [];
    }
    return entries
      .filter((name) => name.startsWith(`${slotId}-`))
      .map((name) => {
        const file = path.join(paths.screenshotsDir, name);
        let stat = null;
        try { stat = fs.statSync(file); } catch { /* raced */ }
        return { file, name, size: stat ? stat.size : 0, mtimeMs: stat ? stat.mtimeMs : 0 };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
  }

  async function saveScreenshot(matrixSlotId, base64, options2 = {}) {
    const slotId = contract.assertSlotId(matrixSlotId);
    const extension = String(options2.extension || 'png').toLowerCase().replace(/^\./, '');
    if (!SCREENSHOT_EXTENSIONS.has(extension)) {
      throw createError(`不支持的截图扩展名：${extension}`, 'invalid_extension', 400);
    }
    const text = String(base64 || '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
    if (!text || !/^[A-Za-z0-9+/=]+$/.test(text)) {
      throw createError('截图内容不是合法的 base64', 'invalid_screenshot', 400);
    }
    const buffer = Buffer.from(text, 'base64');
    if (!buffer.length) throw createError('截图内容为空', 'invalid_screenshot', 400);
    const createdAt = Date.now();
    const file = path.join(paths.screenshotsDir, `${slotId}-${createdAt}.${extension}`);
    atomicWriteFile(file, buffer, { mode: 0o600 });
    const retention = getSettings().screenshotRetention;
    const existing = listScreenshots(slotId);
    while (existing.length > retention) {
      const victim = existing.shift();
      try { fs.unlinkSync(victim.file); } catch { /* raced */ }
    }
    return { path: file, bytes: buffer.length, createdAt };
  }

  function snapshot() {
    const state = readState();
    return {
      settings: state.settings,
      bindings: state.bindings,
      tasks: state.tasks.slice(-50).map((task) => {
        const copy = Object.assign({}, task);
        delete copy.log;
        return copy;
      }),
      counters: state.counters,
      stateDir,
    };
  }

  return {
    stateDir,
    paths,
    load,
    snapshot,
    update,
    getSettings,
    updateSettings,
    bind,
    unbind,
    getBinding,
    findBindingByProfile,
    listBindings,
    touchBinding,
    bumpCounter,
    createTask,
    updateTask,
    appendTaskLog,
    finishTask,
    getTask,
    listTasks,
    setCredentials,
    getCredentials,
    hasCredentials,
    getCredentialMeta,
    deleteCredentials,
    saveScreenshot,
    listScreenshots,
  };
}

module.exports = {
  STATE_VERSION,
  DEFAULT_SETTINGS,
  createProfileStore,
  normalizeSettings,
  normalizeState,
  encryptWithKey,
  decryptWithKey,
  aadFor,
  normalizeKeyMaterial,
};
