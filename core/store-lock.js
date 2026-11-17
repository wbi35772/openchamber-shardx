'use strict';

/*
 * Zero-platform storage primitives shared by every OpenChamber matrix
 * extension.
 *
 * - in-process promise mutex
 * - cross-process lock file (`open 'wx'`, PID liveness, heartbeat takeover)
 * - atomic replace with Windows/WSL2 EPERM/EBUSY retry
 * - runtime.db through the built-in `node:sqlite` driver when available
 *
 * Nothing in this file knows about ShardX or the panel.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOST = os.hostname();
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);
const RENAME_ATTEMPTS = 5;

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

async function sleep(ms) {
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer.unref) timer.unref();
  });
}

function createMutex() {
  let tail = Promise.resolve();
  return {
    run(fn) {
      const next = tail.then(fn, fn);
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}

const mutexes = new Map();

function mutexFor(key) {
  if (!mutexes.has(key)) mutexes.set(key, createMutex());
  return mutexes.get(key);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function readLockInfo(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function removeStaleOwnedLock(lockPath, staleMs) {
  let stat;
  try {
    stat = fs.statSync(lockPath);
  } catch {
    return true;
  }
  const info = readLockInfo(lockPath);
  if (info && info.host === HOST && !pidAlive(info.pid)) {
    try { fs.unlinkSync(lockPath); } catch { /* raced */ }
    return true;
  }
  const heartbeat = info ? Date.parse(info.heartbeatAt || info.startedAt || '') : NaN;
  if (Number.isFinite(heartbeat) && Date.now() - heartbeat > staleMs) {
    try { fs.unlinkSync(lockPath); } catch { /* raced */ }
    return true;
  }
  if (Date.now() - stat.mtimeMs > staleMs) {
    try { fs.unlinkSync(lockPath); } catch { /* raced */ }
    return true;
  }
  return false;
}

function removeStaleLock(lockPath, staleMs) {
  let stat;
  try {
    stat = fs.statSync(lockPath);
  } catch {
    return true;
  }
  const info = readLockInfo(lockPath);
  if (info && info.host === HOST && !pidAlive(info.pid)) {
    try { fs.unlinkSync(lockPath); } catch { /* raced */ }
    return true;
  }
  if (Date.now() - stat.mtimeMs > staleMs) {
    try { fs.unlinkSync(lockPath); } catch { /* raced */ }
    return true;
  }
  return false;
}

/**
 * Acquire a cross-process lock by creating `lockPath` exclusively.
 * Resolves with a release function; rejects after `timeoutMs`.
 */
async function acquireFileLock(lockPath, options = {}) {
  const timeoutMs = options.timeoutMs === undefined ? 15000 : Number(options.timeoutMs);
  const staleMs = options.staleMs === undefined ? 30000 : Number(options.staleMs);
  const retryMs = options.retryMs === undefined ? 25 : Number(options.retryMs);
  const started = Date.now();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      const info = { pid: process.pid, host: HOST, startedAt: new Date().toISOString() };
      fs.writeFileSync(fd, JSON.stringify(info));
      fs.closeSync(fd);
      let released = false;
      return function release() {
        if (released) return;
        released = true;
        try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
      };
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
      if (!error || error.code !== 'EEXIST') throw error;
      if (removeStaleLock(lockPath, staleMs)) continue;
      if (Date.now() - started >= timeoutMs) {
        throw Object.assign(new Error(`lock timeout: ${lockPath}`), { code: 'lock_timeout' });
      }
      await sleep(retryMs);
    }
  }
}

/**
 * Cross-process lock with an owner token and heartbeat. A long task keeps its
 * lock alive while a crashed owner is reclaimed after `staleMs`.
 */
async function acquireOwnedLock(lockPath, options = {}) {
  const timeoutMs = options.timeoutMs === undefined ? 0 : Number(options.timeoutMs);
  const staleMs = options.staleMs === undefined ? 20 * 60 * 1000 : Number(options.staleMs);
  const heartbeatMs = options.heartbeatMs === undefined ? 10000 : Number(options.heartbeatMs);
  const retryMs = options.retryMs === undefined ? 25 : Number(options.retryMs);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const startedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  function info() {
    return { pid: process.pid, host: HOST, token, startedAt, heartbeatAt: new Date().toISOString() };
  }

  function beat() {
    try {
      const current = readLockInfo(lockPath);
      if (current && current.token !== token) return false;
      atomicWriteJson(lockPath, info(), { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(info()));
      fs.closeSync(fd);
      let released = false;
      let timer = null;
      if (heartbeatMs > 0) {
        timer = setInterval(beat, heartbeatMs);
        if (timer.unref) timer.unref();
      }
      return {
        owned: true,
        token,
        beat,
        release() {
          if (released) return;
          released = true;
          if (timer) clearInterval(timer);
          const current = readLockInfo(lockPath);
          if (current && current.token === token) {
            try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
          }
        },
      };
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
      if (!error || error.code !== 'EEXIST') throw error;
      if (removeStaleOwnedLock(lockPath, staleMs)) continue;
      if (Date.now() >= deadline) {
        throw Object.assign(new Error(`lock busy: ${lockPath}`), { code: 'lock_busy' });
      }
      await sleep(retryMs);
    }
  }
}

async function withFileLock(lockPath, fn, options = {}) {
  const release = await acquireFileLock(lockPath, options);
  try {
    return await fn();
  } finally {
    release();
  }
}

/*
 * Windows and WSL2 drvfs can transiently hold a rename target open: antivirus,
 * the search indexer or another watcher returns EPERM/EBUSY even though the
 * source is valid. Retry with a short synchronous backoff before surfacing it.
 */
function renameWithRetry(from, to) {
  let lastError = null;
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!error || !RENAME_RETRY_CODES.has(error.code)) throw error;
      if (attempt < RENAME_ATTEMPTS - 1) sleepSync(15 * (attempt + 1));
    }
  }
  throw lastError;
}

function atomicWriteFile(file, content, options = {}) {
  const mode = options.mode === undefined ? 0o600 : options.mode;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  try {
    renameWithRetry(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw error;
  }
  try { fs.chmodSync(file, mode); } catch { /* ignore on Windows */ }
  return file;
}

function atomicWriteJson(file, value, options = {}) {
  return atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`, options);
}

function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
  try { fs.chmodSync(dir, mode); } catch { /* ignore on Windows */ }
  return dir;
}

/**
 * Serialize read-modify-write on a state file: in-process mutex plus a
 * cross-process lock file.
 */
async function withStateLock(stateFile, fn, options = {}) {
  const key = path.resolve(stateFile);
  return mutexFor(key).run(() => withFileLock(`${key}.lock`, fn, options));
}

class RuntimeDb {
  constructor(file, options = {}) {
    const sqlite = options.sqlite || require('node:sqlite');
    if (!sqlite || typeof sqlite.DatabaseSync !== 'function') {
      throw new Error('node:sqlite DatabaseSync is unavailable (Node >= 22.5 required)');
    }
    this.file = file;
    this.table = options.table || 'runtime';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new sqlite.DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.table} (` +
        'key TEXT PRIMARY KEY, kind TEXT NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL)',
    );
    this.putStmt = this.db.prepare(
      `INSERT INTO ${this.table} (key, kind, updated_at, data) VALUES (?, ?, ?, ?) ` +
        'ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, updated_at = excluded.updated_at, data = excluded.data',
    );
    this.getStmt = this.db.prepare(`SELECT key, kind, updated_at, data FROM ${this.table} WHERE key = ?`);
    this.delStmt = this.db.prepare(`DELETE FROM ${this.table} WHERE key = ?`);
    this.listStmt = this.db.prepare(
      `SELECT key, kind, updated_at, data FROM ${this.table} ORDER BY updated_at DESC LIMIT ?`,
    );
    this.listKindStmt = this.db.prepare(
      `SELECT key, kind, updated_at, data FROM ${this.table} WHERE kind = ? ORDER BY updated_at DESC LIMIT ?`,
    );
  }

  put(key, value, options = {}) {
    const kind = options.kind || 'snapshot';
    this.putStmt.run(String(key), String(kind), Date.now(), JSON.stringify(value));
    return value;
  }

  get(key) {
    const row = this.getStmt.get(String(key));
    if (!row) return null;
    return { key: row.key, kind: row.kind, updatedAt: row.updated_at, value: JSON.parse(row.data) };
  }

  delete(key) {
    this.delStmt.run(String(key));
  }

  list(options = {}) {
    const limit = Number.isInteger(options.limit) ? options.limit : 200;
    const rows = options.kind ? this.listKindStmt.all(String(options.kind), limit) : this.listStmt.all(limit);
    return rows.map((row) => ({
      key: row.key,
      kind: row.kind,
      updatedAt: row.updated_at,
      value: JSON.parse(row.data),
    }));
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

module.exports = {
  createMutex,
  mutexFor,
  pidAlive,
  acquireFileLock,
  acquireOwnedLock,
  withFileLock,
  withStateLock,
  atomicWriteFile,
  atomicWriteJson,
  readJsonFile,
  ensureDir,
  sleep,
  sleepSync,
  renameWithRetry,
  RuntimeDb,
  removeStaleLock,
  removeStaleOwnedLock,
};
