'use strict';

/*
 * ShardX Local API client.
 *
 * Authentication is a locally minted HS256 JWT: `key = settings.api_secret`,
 * claims `{sub:'shardx-api', iat, exp}`. The launcher rotates its secret when
 * the automation panel is toggled, so a 401 triggers exactly one settings
 * reload and one retry.
 *
 * Everything that changes a browser's network identity lives here:
 * `ensureSlotProxy()` creates the loopback proxy that points at the matrix
 * egress port, `alignProfileToLease()` patches proxy + timezone/locale, and
 * `waitForCdp()` resolves the DevTools endpoint of the started profile.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const contract = require('../core/contract');
const hostBridge = require('../core/host-bridge');
const { requestJson } = require('./http-client');

const DEFAULT_TIMEOUT_MS = 15000;
const START_TIMEOUT_MS = 90000;
const TOKEN_TTL_SECONDS = 3600;
const TOKEN_REFRESH_MS = 50 * 60 * 1000;

/*
 * Egress leases only carry a country code. Chrome refuses to start with a
 * timezone that does not belong to the country of the exit IP, so keep a
 * compact mapping and fall back to UTC for anything unknown.
 */
const COUNTRY_TIMEZONE = Object.freeze({
  US: 'America/New_York',
  CA: 'America/Toronto',
  MX: 'America/Mexico_City',
  BR: 'America/Sao_Paulo',
  AR: 'America/Argentina/Buenos_Aires',
  CL: 'America/Santiago',
  GB: 'Europe/London',
  IE: 'Europe/Dublin',
  DE: 'Europe/Berlin',
  FR: 'Europe/Paris',
  NL: 'Europe/Amsterdam',
  BE: 'Europe/Brussels',
  CH: 'Europe/Zurich',
  AT: 'Europe/Vienna',
  IT: 'Europe/Rome',
  ES: 'Europe/Madrid',
  PT: 'Europe/Lisbon',
  PL: 'Europe/Warsaw',
  CZ: 'Europe/Prague',
  RO: 'Europe/Bucharest',
  SE: 'Europe/Stockholm',
  NO: 'Europe/Oslo',
  FI: 'Europe/Helsinki',
  DK: 'Europe/Copenhagen',
  UA: 'Europe/Kyiv',
  RU: 'Europe/Moscow',
  TR: 'Europe/Istanbul',
  IL: 'Asia/Jerusalem',
  AE: 'Asia/Dubai',
  SA: 'Asia/Riyadh',
  EG: 'Africa/Cairo',
  ZA: 'Africa/Johannesburg',
  NG: 'Africa/Lagos',
  KE: 'Africa/Nairobi',
  IN: 'Asia/Kolkata',
  PK: 'Asia/Karachi',
  BD: 'Asia/Dhaka',
  LK: 'Asia/Colombo',
  NP: 'Asia/Kathmandu',
  TH: 'Asia/Bangkok',
  VN: 'Asia/Ho_Chi_Minh',
  ID: 'Asia/Jakarta',
  MY: 'Asia/Kuala_Lumpur',
  SG: 'Asia/Singapore',
  PH: 'Asia/Manila',
  HK: 'Asia/Hong_Kong',
  TW: 'Asia/Taipei',
  JP: 'Asia/Tokyo',
  KR: 'Asia/Seoul',
  CN: 'Asia/Shanghai',
  AU: 'Australia/Sydney',
  NZ: 'Pacific/Auckland',
});

const COUNTRY_LOCALE = Object.freeze({
  US: 'en-US',
  GB: 'en-GB',
  CA: 'en-CA',
  AU: 'en-AU',
  NZ: 'en-NZ',
  IE: 'en-IE',
  DE: 'de-DE',
  FR: 'fr-FR',
  NL: 'nl-NL',
  BE: 'nl-BE',
  CH: 'de-CH',
  AT: 'de-AT',
  IT: 'it-IT',
  ES: 'es-ES',
  PT: 'pt-PT',
  BR: 'pt-BR',
  MX: 'es-MX',
  AR: 'es-AR',
  CL: 'es-CL',
  PL: 'pl-PL',
  CZ: 'cs-CZ',
  RO: 'ro-RO',
  SE: 'sv-SE',
  NO: 'nb-NO',
  FI: 'fi-FI',
  DK: 'da-DK',
  UA: 'uk-UA',
  RU: 'ru-RU',
  TR: 'tr-TR',
  IL: 'he-IL',
  AE: 'ar-AE',
  SA: 'ar-SA',
  EG: 'ar-EG',
  ZA: 'en-ZA',
  NG: 'en-NG',
  KE: 'en-KE',
  IN: 'en-IN',
  PK: 'en-PK',
  BD: 'bn-BD',
  LK: 'si-LK',
  NP: 'ne-NP',
  TH: 'th-TH',
  VN: 'vi-VN',
  ID: 'id-ID',
  MY: 'ms-MY',
  SG: 'en-SG',
  PH: 'en-PH',
  HK: 'zh-HK',
  TW: 'zh-TW',
  JP: 'ja-JP',
  KR: 'ko-KR',
  CN: 'zh-CN',
});

class ShardxError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ShardxError';
    if (options.code) this.code = options.code;
    if (options.status) this.status = options.status;
    if (options.body !== undefined) this.body = options.body;
    if (options.cause) this.cause = options.cause;
  }
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of ['items', 'data', 'list', 'profiles', 'folders', 'proxies', 'running']) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function mintToken(secret, ttlSeconds = TOKEN_TTL_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ sub: 'shardx-api', iat: now, exp: now + ttlSeconds })).toString('base64url');
  const signature = crypto
    .createHmac('sha256', Buffer.from(String(secret), 'utf8'))
    .update(`${header}.${claims}`)
    .digest('base64url');
  return `${header}.${claims}.${signature}`;
}

function decodeTokenPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function wsUrlOf(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const cdp = payload.cdp && typeof payload.cdp === 'object' ? payload.cdp : {};
  return String(
    cdp.web_socket_debugger_url
    || cdp.webSocketDebuggerUrl
    || payload.web_socket_debugger_url
    || payload.webSocketDebuggerUrl
    || cdp.ws_url
    || payload.wsUrl
    || '',
  );
}

function timezoneForCountry(country) {
  const code = String(country || '').toUpperCase();
  return COUNTRY_TIMEZONE[code] || 'UTC';
}

function localeForCountry(country) {
  const code = String(country || '').toUpperCase();
  return COUNTRY_LOCALE[code] || 'en-US';
}

function createShardxClient(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const env = options.env || process.env;
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const store = options.store || null;
  const request = options.request || requestJson;
  const readFileSync = options.readFileSync || ((file) => fs.readFileSync(file, 'utf8'));
  const hostOptions = Object.assign({}, options.hostOptions || {}, {
    env,
    settingsPath: options.settingsPath || env.SHARDX_LAUNCHER_SETTINGS || undefined,
  });

  let cachedSettings = null;
  let cachedToken = '';
  let tokenExpiresAt = 0;
  let cachedBaseUrl = '';
  let lastError = '';
  let context = null;

  function resolveContext(force) {
    if (context && !force) return context;
    context = hostBridge.resolveHostContext(hostOptions);
    return context;
  }

  function loadSettings(force) {
    if (cachedSettings && !force) return cachedSettings;
    const ctx = resolveContext(force);
    cachedSettings = hostBridge.readLauncherSettings({
      ...hostOptions,
      settingsPath: ctx.settingsPath || hostOptions.settingsPath,
      readFileSync,
      existsSync: options.existsSync,
    });
    cachedBaseUrl = '';
    cachedToken = '';
    tokenExpiresAt = 0;
    return cachedSettings;
  }

  function baseUrl(force) {
    if (cachedBaseUrl && !force) return cachedBaseUrl;
    const ctx = resolveContext(force);
    const settings = loadSettings(force);
    if (ctx.apiBaseHasPort) {
      cachedBaseUrl = ctx.apiBase;
    } else {
      cachedBaseUrl = `${ctx.apiBase}:${settings.apiPort}`;
    }
    return cachedBaseUrl;
  }

  function token(force) {
    if (cachedToken && !force && Date.now() < tokenExpiresAt) return cachedToken;
    const settings = loadSettings(force);
    cachedToken = mintToken(settings.apiSecret);
    tokenExpiresAt = Date.now() + TOKEN_REFRESH_MS;
    return cachedToken;
  }

  function resetAuth() {
    cachedSettings = null;
    cachedToken = '';
    tokenExpiresAt = 0;
    cachedBaseUrl = '';
    context = null;
  }

  async function api(method, apiPath, callOptions = {}) {
    const retry = callOptions.retried !== true;
    const url = new URL(apiPath, `${baseUrl()}/`);
    if (callOptions.query) {
      for (const [key, value] of Object.entries(callOptions.query)) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(key, String(value));
      }
    }
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${token()}`,
    };
    let body;
    if (callOptions.body !== undefined) {
      body = callOptions.body;
      headers['Content-Type'] = 'application/json';
    }
    try {
      const response = await request(url.toString(), {
        method,
        headers,
        body,
        timeoutMs: callOptions.timeoutMs || timeoutMs,
        allowNon2xx: true,
      });
      if (response.status === 401 && retry) {
        log('[shardx] 401，重新读取启动器密钥后重试');
        resetAuth();
        return api(method, apiPath, Object.assign({}, callOptions, { retried: true }));
      }
      if (response.status < 200 || response.status >= 300) {
        const detail = response.body && (response.body.error || response.body.message || response.body.detail);
        const error = new ShardxError(
          `ShardX ${method} ${apiPath} -> ${response.status} ${String(detail || response.text || '').slice(0, 300)}`,
          {
            code: response.status === 401 ? 'shardx_unauthorized' : 'shardx_api_error',
            status: response.status,
            body: response.body,
          },
        );
        lastError = error.message;
        throw error;
      }
      lastError = '';
      return response.body === null ? {} : response.body;
    } catch (cause) {
      if (cause instanceof ShardxError) throw cause;
      const error = new ShardxError(
        `无法连接 ShardX（${baseUrl()}）：${cause && cause.message ? cause.message : String(cause)}`,
        { code: 'shardx_unreachable', status: 503, cause },
      );
      lastError = error.message;
      throw error;
    }
  }

  async function health() {
    const started = Date.now();
    try {
      const response = await request(`${baseUrl()}/health`, { timeoutMs: 3000, allowNon2xx: true });
      return {
        ok: response.status >= 200 && response.status < 300,
        latencyMs: Date.now() - started,
        status: response.status,
        body: response.body,
        baseUrl: (() => { try { return baseUrl(); } catch { return ''; } })(),
      };
    } catch (cause) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        status: 0,
        error: cause && cause.message ? cause.message : String(cause),
        baseUrl: (() => { try { return baseUrl(); } catch { return ''; } })(),
      };
    }
  }

  async function listProfiles() {
    const payload = await api('GET', '/profiles');
    return asArray(payload).map((profile) => ({
      id: String(profile.id || ''),
      name: String(profile.name || profile.id || ''),
      notes: String(profile.notes || ''),
      folder: String(profile.folder || ''),
      proxyId: String(profile.proxy_id || ''),
      running: Boolean(profile.running),
      pid: Number(profile.pid) || 0,
      lastLaunchedAt: Number(profile.last_launched_at) || 0,
      cdp: wsUrlOf(profile),
      raw: profile,
    })).filter((profile) => profile.id);
  }

  async function getProfile(profileId) {
    const id = String(profileId || '').trim();
    if (!id) throw new ShardxError('profileId 不能为空', { code: 'profile_id_required', status: 400 });
    const profile = await api('GET', `/profiles/${encodeURIComponent(id)}`);
    return profile && typeof profile === 'object' ? profile : {};
  }

  async function patchProfile(profileId, patch) {
    const id = String(profileId || '').trim();
    if (!id) throw new ShardxError('profileId 不能为空', { code: 'profile_id_required', status: 400 });
    const body = patch && typeof patch === 'object' ? patch : {};
    if (Object.keys(body).length === 0) return getProfile(id);
    const profile = await api('PATCH', `/profiles/${encodeURIComponent(id)}`, { body });
    return profile && typeof profile === 'object' ? profile : {};
  }

  async function listProxies() {
    const payload = await api('GET', '/proxies');
    return asArray(payload).map((proxy) => ({
      id: String(proxy.id || proxy.proxy_id || ''),
      name: String(proxy.name || ''),
      kind: String(proxy.kind || proxy.type || 'http'),
      host: String(proxy.host || ''),
      port: Number(proxy.port) || 0,
      raw: proxy,
    })).filter((proxy) => proxy.id);
  }

  async function createProxy(input = {}) {
    const port = Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ShardxError('代理端口必须是 1-65535', { code: 'invalid_proxy_port', status: 400 });
    }
    const host = String(input.host || '127.0.0.1');
    const body = {
      name: String(input.name || `egress-${port}`),
      kind: String(input.kind || 'http'),
      host,
      port,
      proxy: String(input.proxy || `http://${host}:${port}`),
    };
    if (input.username) body.username = String(input.username);
    if (input.password) body.password = String(input.password);
    if (input.country) body.country = String(input.country);
    const created = await api('POST', '/proxies', { body });
    const raw = created && created.proxy && typeof created.proxy === 'object' ? created.proxy : created;
    const id = String((raw && (raw.id || raw.proxy_id)) || '');
    if (!id) {
      throw new ShardxError('ShardX 创建代理后没有返回 id', { code: 'proxy_id_missing', status: 502, body: created });
    }
    return {
      id,
      name: String(raw.name || body.name),
      kind: String(raw.kind || body.kind),
      host: String(raw.host || host),
      port: Number(raw.port) || port,
      raw,
    };
  }

  async function ensureProxy(input = {}) {
    const desired = {
      name: String(input.name || `egress-${input.port}`),
      host: String(input.host || '127.0.0.1'),
      port: Number(input.port),
      kind: String(input.kind || 'http'),
    };
    if (!Number.isInteger(desired.port) || desired.port < 1 || desired.port > 65535) {
      throw new ShardxError('代理端口必须是 1-65535', { code: 'invalid_proxy_port', status: 400 });
    }
    let proxies = [];
    try {
      proxies = await listProxies();
    } catch (error) {
      log(`[shardx] 读取代理列表失败，直接创建：${error.message}`);
    }
    const byName = proxies.find((proxy) => proxy.name === desired.name);
    if (byName && byName.host === desired.host && byName.port === desired.port) {
      return Object.assign({ existing: true }, byName);
    }
    if (byName) {
      try {
        const patched = await api('PATCH', `/proxies/${encodeURIComponent(byName.id)}`, {
          body: {
            name: desired.name,
            kind: desired.kind,
            host: desired.host,
            port: desired.port,
            proxy: `http://${desired.host}:${desired.port}`,
          },
        });
        const raw = patched && patched.proxy && typeof patched.proxy === 'object' ? patched.proxy : patched;
        return {
          existing: true,
          updated: true,
          id: byName.id,
          name: desired.name,
          kind: desired.kind,
          host: desired.host,
          port: desired.port,
          raw,
        };
      } catch (error) {
        log(`[shardx] 更新代理 ${byName.id} 失败，沿用旧记录：${error.message}`);
        return Object.assign({ existing: true, stale: true }, byName);
      }
    }
    const byEndpoint = proxies.find((proxy) => proxy.host === desired.host && proxy.port === desired.port);
    if (byEndpoint) return Object.assign({ existing: true }, byEndpoint);
    return Object.assign({ existing: false }, await createProxy(desired));
  }

  async function ensureSlotProxy(matrixSlotId) {
    const slotId = contract.assertSlotId(matrixSlotId);
    const port = contract.egressPortForSlotId(slotId);
    return ensureProxy({ name: `egress-${slotId}`, host: '127.0.0.1', port, kind: 'http' });
  }

  /**
   * Patch the profile so its traffic leaves through the bound egress port and
   * its timezone/locale match the lease country. Identity fields are merged
   * into the existing fingerprint instead of replacing it.
   */
  async function alignProfileToLease(profileId, lease, proxyId) {
    const id = String(profileId || '').trim();
    let profile = {};
    try {
      profile = await getProfile(id);
    } catch (error) {
      log(`[shardx] 读取 Profile ${id} 失败，仍然写入代理：${error.message}`);
    }
    const currentFingerprint = profile && profile.fingerprint && typeof profile.fingerprint === 'object'
      ? profile.fingerprint
      : {};
    const country = String((lease && lease.country) || '').toUpperCase();
    const fingerprint = Object.assign({}, currentFingerprint, {
      timezone: timezoneForCountry(country),
      locale: localeForCountry(country),
    });
    if (lease && lease.egressFingerprint && lease.egressFingerprint.exitIp) {
      fingerprint.webrtc = 'proxy';
    }
    const patch = { fingerprint };
    if (proxyId) patch.proxy_id = String(proxyId);
    return patchProfile(id, patch);
  }

  async function startProfile(profileId, options2 = {}) {
    const id = String(profileId || '').trim();
    const body = {};
    if (options2.headless === true) body.headless = true;
    if (options2.password) body.password = String(options2.password);
    try {
      return await api('POST', `/profiles/${encodeURIComponent(id)}/start`, {
        body,
        timeoutMs: options2.timeoutMs || START_TIMEOUT_MS,
      });
    } catch (error) {
      const running = await api('GET', '/running').catch(() => null);
      const hit = asArray(running).find((item) => item && (item.id === id || item.profile_id === id));
      if (hit) return hit;
      throw error;
    }
  }

  async function stopProfile(profileId) {
    const id = String(profileId || '').trim();
    let profile = null;
    try {
      profile = await getProfile(id);
    } catch (error) {
      if (error.status === 404) return { stopped: false, skipped: true, reason: 'profile_missing' };
      throw error;
    }
    if (!profile.running) return { stopped: false, skipped: true, reason: 'not_running' };
    try {
      const result = await api('POST', `/profiles/${encodeURIComponent(id)}/stop`, { body: {} });
      return { stopped: true, result };
    } catch (error) {
      if (error.status === 404) return { stopped: true, skipped: true, reason: 'already_stopped' };
      throw error;
    }
  }

  async function runningProfiles() {
    try {
      const payload = await api('GET', '/running');
      return asArray(payload);
    } catch (error) {
      if (error.status === 404) {
        const profiles = await listProfiles();
        return profiles.filter((profile) => profile.running).map((profile) => profile.raw);
      }
      throw error;
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, ms));
      if (timer.unref) timer.unref();
    });
  }

  /**
   * Resolve the DevTools endpoint of an already-started profile. The launcher
   * sometimes returns it in the start response, sometimes only after a beat,
   * and for `--remote-debugging-port=0` the only reliable source is the
   * `DevToolsActivePort` file inside the profile directory.
   */
  async function waitForCdp(profileId, waitOptions = {}) {
    const id = String(profileId || '').trim();
    const budget = Number(waitOptions.timeoutMs) || 30000;
    const intervalMs = Number(waitOptions.intervalMs) || 250;
    const startedAt = Date.now();
    let lastProfile = null;
    let lastError = '';
    for (;;) {
      try {
        lastProfile = await getProfile(id);
      } catch (error) {
        lastError = error.message;
      }
      const direct = wsUrlOf(lastProfile);
      if (direct) return { wsUrl: direct, source: 'profile' };
      try {
        const settings = loadSettings();
        const ctx = resolveContext();
        const active = hostBridge.readDevToolsActivePort(id, {
          launcherSettings: settings,
          context: ctx,
          readFileSync,
          existsSync: options.existsSync,
        });
        if (active && active.wsUrl) return { wsUrl: active.wsUrl, source: active.source, port: active.port };
      } catch (error) {
        lastError = error.message;
      }
      if (Date.now() - startedAt >= budget) {
        throw new ShardxError(
          `Profile ${id} 在 ${budget}ms 内没有暴露 CDP 端点${lastError ? `（${lastError}）` : ''}`,
          { code: 'cdp_endpoint_missing', status: 504 },
        );
      }
      await sleep(intervalMs);
    }
  }

  function describe() {
    const ctx = (() => {
      try { return resolveContext(); } catch { return null; }
    })();
    let settings = null;
    try { settings = loadSettings(); } catch { /* reported by status */ }
    return {
      baseUrl: (() => { try { return baseUrl(); } catch { return ''; } })(),
      settingsPath: ctx ? ctx.settingsPath : '',
      settingsPathSource: ctx ? ctx.settingsPathSource : '',
      isWsl: ctx ? ctx.isWsl : false,
      hostIp: ctx ? ctx.hostIp : '',
      dataRoot: settings ? settings.dataRoot : '',
      hasSecret: Boolean(settings && settings.apiSecret),
      tokenExpiresInMs: Math.max(0, tokenExpiresAt - Date.now()),
      lastError,
    };
  }

  function reset() {
    resetAuth();
  }

  return {
    api,
    health,
    listProfiles,
    getProfile,
    patchProfile,
    listProxies,
    createProxy,
    ensureProxy,
    ensureSlotProxy,
    alignProfileToLease,
    startProfile,
    stopProfile,
    runningProfiles,
    waitForCdp,
    describe,
    reset,
    get baseUrl() {
      return (() => { try { return baseUrl(); } catch { return ''; } })();
    },
  };
}

module.exports = {
  createShardxClient,
  ShardxError,
  mintToken,
  decodeTokenPayload,
  wsUrlOf,
  asArray,
  timezoneForCountry,
  localeForCountry,
  COUNTRY_TIMEZONE,
  COUNTRY_LOCALE,
};
