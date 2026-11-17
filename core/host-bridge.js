'use strict';

/*
 * Host bridge: the ShardX launcher only runs on Windows, while this
 * extension may itself run inside WSL2. Everything Windows-specific lives
 * here so the rest of the codebase only ever talks to `context.apiBase`.
 *
 * The resolution order is deliberately boring and testable:
 *   1. explicit `SHARDX_API_BASE` / `options.apiBase`
 *   2. WSL2 default gateway (the Windows host) or 127.0.0.1
 *   3. launcher settings from %APPDATA%\shardx-launcher\settings.json
 *      (or the WSL mirror under /mnt/c/Users/<user>/AppData/Roaming)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SETTINGS_DIR_NAME = 'shardx-launcher';
const SETTINGS_FILE_NAME = 'settings.json';

function isWslHost(options = {}) {
  const env = options.env || process.env;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  let release = options.release;
  if (release === undefined) {
    try { release = os.release(); } catch { release = ''; }
  }
  if (String(release || '').toLowerCase().includes('microsoft')) return true;
  let procVersion = options.procVersion;
  if (procVersion === undefined) {
    try { procVersion = fs.readFileSync('/proc/version', 'utf8'); } catch { procVersion = ''; }
  }
  return String(procVersion || '').toLowerCase().includes('microsoft');
}

function parseProcNetRoute(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const destination = parts[1];
    const gatewayHex = parts[2];
    const flagsHex = parts[3];
    if (destination !== '00000000') continue;
    const flags = Number.parseInt(flagsHex, 16);
    if (!Number.isFinite(flags) || (flags & 0x2) === 0) continue;
    if (!/^[0-9a-fA-F]{8}$/.test(gatewayHex)) continue;
    const bytes = [
      Number.parseInt(gatewayHex.slice(6, 8), 16),
      Number.parseInt(gatewayHex.slice(4, 6), 16),
      Number.parseInt(gatewayHex.slice(2, 4), 16),
      Number.parseInt(gatewayHex.slice(0, 2), 16),
    ];
    return bytes.join('.');
  }
  return '';
}

function parseIpRoute(text) {
  const match = /default\s+via\s+([0-9a-fA-F:.]+)/.exec(String(text || ''));
  return match ? match[1] : '';
}

function parseResolvConf(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^\s*nameserver\s+([0-9a-fA-F:.]+)\s*$/.exec(line);
    if (match) return match[1];
  }
  return '';
}

function detectDefaultGateway(options = {}) {
  const readFileSync = options.readFileSync || ((file) => fs.readFileSync(file, 'utf8'));
  const routeText = options.procNetRoute;
  if (routeText !== undefined) {
    const parsed = parseProcNetRoute(routeText);
    if (parsed) return parsed;
  }
  if (!options.skipProcNetRoute) {
    try {
      const parsed = parseProcNetRoute(readFileSync('/proc/net/route'));
      if (parsed) return parsed;
    } catch { /* not Linux or unreadable */ }
  }
  if (!options.skipIpRoute) {
    const execFile = options.execFileSync || execFileSync;
    try {
      const output = execFile('ip', ['route'], { encoding: 'utf8', timeout: 3000 });
      const parsed = parseIpRoute(output);
      if (parsed) return parsed;
    } catch { /* iproute2 missing */ }
  }
  if (!options.skipResolvConf) {
    try {
      const parsed = parseResolvConf(readFileSync('/etc/resolv.conf'));
      if (parsed) return parsed;
    } catch { /* ignore */ }
  }
  return '';
}

function windowsPathToWsl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('/')) return text;
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(text);
  if (!match) return text;
  const drive = match[1].toLowerCase();
  const rest = match[2].replace(/\\/g, '/');
  return `/mnt/${drive}/${rest}`;
}

function wslPathToWindows(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const match = /^\/mnt\/([A-Za-z])\/(.*)$/.exec(text);
  if (!match) return text;
  const drive = match[1].toUpperCase();
  const rest = match[2].replace(/\//g, '\\');
  return `${drive}:\\${rest}`;
}

function readDirSafe(dir, readdirSync = fs.readdirSync) {
  try { return readdirSync(dir); } catch { return []; }
}

function existsDefault(file, existsSync = fs.existsSync) {
  try { return Boolean(existsSync(file)); } catch { return false; }
}

/**
 * Every plausible `%APPDATA%` (Roaming) directory, native and WSL2.
 */
function windowsAppDataCandidates(options = {}) {
  const env = options.env || process.env;
  const home = options.home === undefined ? os.homedir() : options.home;
  const existsSync = options.existsSync || fs.existsSync;
  const readdirSync = options.readdirSync || fs.readdirSync;
  const candidates = [];
  const push = (value) => {
    const text = String(value || '').trim();
    if (!text) return;
    if (!candidates.includes(text)) candidates.push(text);
  };

  if (env.APPDATA) push(env.APPDATA);
  if (home) push(path.join(home, 'AppData', 'Roaming'));

  const wsl = options.isWsl === undefined ? isWslHost({ env }) : options.isWsl;
  if (wsl) {
    for (const entry of readDirSafe('/mnt/c/Users', readdirSync)) {
      if (entry === 'Public' || entry === 'Default' || entry === 'Default User' || entry === 'All Users') continue;
      push(path.join('/mnt/c/Users', entry, 'AppData', 'Roaming'));
    }
    try {
      const execFile = options.execFileSync || execFileSync;
      const output = String(execFile('cmd.exe', ['/c', 'echo %APPDATA%'], { encoding: 'utf8', timeout: 3000 }) || '').trim();
      if (output && !output.includes('%APPDATA%')) push(windowsPathToWsl(output));
    } catch { /* cmd.exe not reachable */ }
  }

  const appData = env.LOCALAPPDATA;
  if (appData) push(appData);

  return candidates.filter((candidate) => {
    if (!candidate) return false;
    if (!options.onlyExisting) return true;
    return existsDefault(candidate, existsSync);
  });
}

function launcherSettingsCandidates(options = {}) {
  const env = options.env || process.env;
  const home = options.home === undefined ? os.homedir() : options.home;
  const list = [];
  const push = (file, source) => {
    if (!file) return;
    if (list.some((item) => item.path === file)) return;
    list.push({ path: file, source });
  };

  if (options.settingsPath) push(options.settingsPath, 'explicit');
  if (env.SHARDX_LAUNCHER_SETTINGS) push(env.SHARDX_LAUNCHER_SETTINGS, 'env');

  const appDataList = options.appDataCandidates || windowsAppDataCandidates(options);
  for (const dir of appDataList) {
    push(path.join(dir, SETTINGS_DIR_NAME, SETTINGS_FILE_NAME), dir.startsWith('/mnt/') ? 'wsl-appdata' : 'appdata');
  }
  if (home) push(path.join(home, `.${SETTINGS_DIR_NAME}`, SETTINGS_FILE_NAME), 'home');

  return list;
}

function resolveLauncherSettingsPath(options = {}) {
  const existsSync = options.existsSync || fs.existsSync;
  const candidates = launcherSettingsCandidates(options);
  for (const entry of candidates) {
    if (existsDefault(entry.path, existsSync)) return entry.path;
  }
  return candidates.length ? candidates[0].path : '';
}

function readLauncherSettings(options = {}) {
  const existsSync = options.existsSync || fs.existsSync;
  const readFileSync = options.readFileSync || ((file) => fs.readFileSync(file, 'utf8'));
  const candidates = options.settingsPath
    ? [{ path: options.settingsPath, source: 'explicit' }, ...launcherSettingsCandidates(options)]
    : launcherSettingsCandidates(options);

  let chosen = '';
  for (const entry of candidates) {
    if (existsDefault(entry.path, existsSync)) {
      chosen = entry.path;
      break;
    }
  }
  if (!chosen) {
    const error = new Error(
      '找不到 ShardX 启动器设置文件。先启动 ShardX，或设置 SHARDX_LAUNCHER_SETTINGS 指向 settings.json。',
    );
    error.code = 'launcher_settings_missing';
    error.candidates = candidates.map((entry) => entry.path);
    throw error;
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(chosen, 'utf8'));
  } catch (cause) {
    const error = new Error(`ShardX 启动器设置文件不是合法 JSON：${chosen}`);
    error.code = 'launcher_settings_invalid';
    error.cause = cause;
    throw error;
  }

  const apiPort = Number(raw && raw.api_port);
  const apiSecret = String((raw && raw.api_secret) || '').trim();
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
    const error = new Error(`ShardX 启动器设置里的 api_port 无效：${JSON.stringify(raw && raw.api_port)}`);
    error.code = 'launcher_settings_invalid';
    throw error;
  }
  if (!apiSecret) {
    const error = new Error('ShardX 启动器设置里的 api_secret 为空，请在启动器里开启自动化 API。');
    error.code = 'launcher_settings_invalid';
    throw error;
  }

  return {
    apiPort,
    apiSecret,
    dataRoot: String((raw && raw.data_root) || ''),
    path: chosen,
    raw: raw || {},
  };
}

function normalizeBase(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.replace(/\/+$/, '');
}

function resolveHostContext(options = {}) {
  const env = options.env || process.env;
  const isWsl = options.isWsl === undefined ? isWslHost({ env }) : Boolean(options.isWsl);
  const explicitBase = normalizeBase(options.apiBase || env.SHARDX_API_BASE || '');

  const settingsPath = resolveLauncherSettingsPath({ ...options, env, isWsl });
  const candidates = launcherSettingsCandidates({ ...options, env, isWsl });
  const matched = candidates.find((entry) => entry.path === settingsPath);
  const settingsPathSource = matched ? matched.source : (settingsPath ? 'fallback' : 'none');

  if (explicitBase) {
    let apiHost = '127.0.0.1';
    let apiPort = 0;
    try {
      const parsed = new URL(explicitBase);
      apiHost = parsed.hostname;
      apiPort = parsed.port ? Number(parsed.port) : 0;
    } catch {
      apiHost = explicitBase.replace(/^https?:\/\//, '').split(':')[0] || '127.0.0.1';
    }
    return {
      isWsl,
      hostIp: apiHost,
      apiHost,
      apiBase: explicitBase,
      apiBaseHasPort: Boolean(apiPort),
      settingsPath,
      settingsPathSource,
      platform: process.platform,
      source: 'explicit',
    };
  }

  const hostIp = isWsl ? (detectDefaultGateway(options) || '127.0.0.1') : '127.0.0.1';
  return {
    isWsl,
    hostIp,
    apiHost: hostIp,
    apiBase: `http://${hostIp}`,
    apiBaseHasPort: false,
    settingsPath,
    settingsPathSource,
    platform: process.platform,
    source: isWsl ? 'wsl-gateway' : 'loopback',
  };
}

function readDevToolsActivePort(profileId, options = {}) {
  const id = String(profileId || '').trim();
  if (!id || /[\\/\r\n]/.test(id)) return null;
  const launcherSettings = options.launcherSettings || null;
  const context = options.context || resolveHostContext(options);
  const existsSync = options.existsSync || fs.existsSync;
  const readFileSync = options.readFileSync || ((file) => fs.readFileSync(file, 'utf8'));
  const home = options.home === undefined ? os.homedir() : options.home;

  const dirs = [];
  const dataRoot = launcherSettings && launcherSettings.dataRoot ? launcherSettings.dataRoot : '';
  if (dataRoot) {
    const mirrored = context.isWsl ? windowsPathToWsl(dataRoot) : dataRoot;
    dirs.push({ file: path.join(mirrored, 'user-data', id, 'DevToolsActivePort'), source: 'data-root' });
    dirs.push({ file: path.join(mirrored, id, 'DevToolsActivePort'), source: 'data-root-flat' });
  }
  for (const appData of windowsAppDataCandidates(options)) {
    dirs.push({ file: path.join(appData, 'shardx', 'user-data', id, 'DevToolsActivePort'), source: 'appdata' });
  }
  if (home) {
    dirs.push({ file: path.join(home, '.shardx', 'user-data', id, 'DevToolsActivePort'), source: 'home' });
  }

  for (const entry of dirs) {
    if (!existsDefault(entry.file, existsSync)) continue;
    let text;
    try { text = readFileSync(entry.file); } catch { continue; }
    const lines = String(text || '').split(/\r?\n/);
    const port = Number(lines[0]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const wsPath = String(lines[1] || '').trim() || '/devtools/browser';
    const host = context.apiHost || '127.0.0.1';
    return {
      port,
      wsPath,
      wsUrl: `ws://${host}:${port}${wsPath.startsWith('/') ? wsPath : `/${wsPath}`}`,
      source: entry.source,
      file: entry.file,
    };
  }
  return null;
}

function describeHost(options = {}) {
  const context = resolveHostContext(options);
  const launcherFound = existsDefault(context.settingsPath, options.existsSync || fs.existsSync);
  let note;
  if (context.isWsl && context.source === 'wsl-gateway') {
    note = `WSL2 检测到 Windows 宿主网关 ${context.hostIp}，ShardX 走宿主侧 API。`;
  } else if (context.source === 'explicit') {
    note = `使用显式 ShardX API 地址 ${context.apiBase}。`;
  } else {
    note = '本机 Windows 直连 127.0.0.1 上的 ShardX 启动器。';
  }
  if (!launcherFound) note += ' 尚未找到 shardx-launcher/settings.json，请先启动 ShardX。';
  return {
    platform: context.platform,
    release: os.release(),
    isWsl: context.isWsl,
    home: os.homedir(),
    appDataCandidates: windowsAppDataCandidates(options),
    settingsPath: context.settingsPath,
    settingsPathSource: context.settingsPathSource,
    launcherFound,
    note,
  };
}

module.exports = {
  SETTINGS_DIR_NAME,
  SETTINGS_FILE_NAME,
  isWslHost,
  parseProcNetRoute,
  parseIpRoute,
  parseResolvConf,
  detectDefaultGateway,
  windowsPathToWsl,
  wslPathToWindows,
  windowsAppDataCandidates,
  launcherSettingsCandidates,
  resolveLauncherSettingsPath,
  readLauncherSettings,
  resolveHostContext,
  readDevToolsActivePort,
  describeHost,
};
