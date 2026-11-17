'use strict';

/* ShardX Matrix panel — vanilla, no build step, no bundler. */

const API = '/api/v1/shardx';
const WS_PATH = '/api/v1/shardx/ws';

/* --------------------------------------------------------------- host bridge */
/* 在 OpenChamber 里运行时，面板装在一个 sandbox iframe 中，CSP 不允许直连
   127.0.0.1，必须通过 postMessage 让宿主代发请求；单独打开时仍走 fetch。 */

const guest = {
  active: window.parent !== window,
  seq: 0,
  pending: new Map(),
};

const BRIDGE_CHANNEL = 'openchamber.sdk';
const BRIDGE_VERSION = 1;
const BRIDGE_TIMEOUT = 45000;

function bridgeCall(type, payload) {
  return new Promise((resolve, reject) => {
    const id = `shardx-panel-${++guest.seq}-${Date.now()}`;
    const timer = setTimeout(() => {
      guest.pending.delete(id);
      const error = new Error('宿主未响应');
      error.code = 'HOST_TIMEOUT';
      reject(error);
    }, BRIDGE_TIMEOUT);
    guest.pending.set(id, { resolve, reject, timer });
    window.parent.postMessage({ channel: BRIDGE_CHANNEL, v: BRIDGE_VERSION, type, id, payload }, '*');
  });
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || data.channel !== BRIDGE_CHANNEL) return;
  if (data.type === 'ready') return;
  if (!data.id) return;
  const pending = guest.pending.get(data.id);
  if (!pending) return;
  guest.pending.delete(data.id);
  clearTimeout(pending.timer);
  if (data.ok) {
    pending.resolve(data.payload);
  } else {
    const error = new Error(data.error || '宿主调用失败');
    error.code = data.code || 'HOST_ERROR';
    pending.reject(error);
  }
});

function guestRequest(pathname, options) {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return bridgeCall('service-request', {
    method: options.method || 'GET',
    path: pathname,
    body,
  });
}

function decodeResult(result) {
  const status = Number(result && result.status) || 200;
  let payload = {};
  if (result && result.body) {
    try {
      payload = JSON.parse(result.body);
    } catch {
      payload = {};
    }
  }
  return { status, payload };
}

const state = {
  slots: new Map(),
  selected: null,
  events: [],
  profiles: [],
  bindTarget: null,
  filter: { q: '', plane: 'ALL', state: 'ALL' },
  ws: null,
  wsBackoff: 800,
  wsTimer: null,
  integrations: null,
  busy: new Set(),
};

const els = {
  grid: document.getElementById('grid'),
  empty: document.getElementById('empty'),
  count: document.getElementById('grid-count'),
  statBound: document.getElementById('stat-bound'),
  statRunning: document.getElementById('stat-running'),
  statTasks: document.getElementById('stat-tasks'),
  statEgress: document.getElementById('stat-egress'),
  wsDot: document.getElementById('ws-dot'),
  wsLabel: document.getElementById('ws-label'),
  lights: document.getElementById('lights'),
  query: document.getElementById('filter-query'),
  plane: document.getElementById('filter-plane'),
  stateFilter: document.getElementById('filter-state'),
  drawer: document.getElementById('drawer'),
  drawerSlot: document.getElementById('drawer-slot'),
  drawerProfile: document.getElementById('drawer-profile'),
  drawerHealth: document.getElementById('drawer-health'),
  drawerImage: document.getElementById('drawer-image'),
  drawerShotEmpty: document.getElementById('drawer-shot-empty'),
  drawerUrl: document.getElementById('drawer-url'),
  drawerLease: document.getElementById('drawer-lease'),
  feed: document.getElementById('feed'),
  quickForm: document.getElementById('quick-form'),
  quickAction: document.getElementById('quick-action'),
  quickTarget: document.getElementById('quick-target'),
  quickValue: document.getElementById('quick-value'),
  toasts: document.getElementById('toasts'),
  bindDialog: document.getElementById('bind-dialog'),
  bindSlot: document.getElementById('bind-slot'),
  bindPort: document.getElementById('bind-port'),
  bindSearch: document.getElementById('bind-search'),
  bindNote: document.getElementById('bind-note'),
  profileList: document.getElementById('profile-list'),
  taskDialog: document.getElementById('task-dialog'),
  taskSlot: document.getElementById('task-slot'),
  taskSteps: document.getElementById('task-steps'),
  taskNote: document.getElementById('task-note'),
  taskRun: document.getElementById('task-run'),
  settingsDialog: document.getElementById('settings-dialog'),
  settingsNote: document.getElementById('settings-note'),
  version: document.getElementById('service-version'),
};

/* ------------------------------------------------------------------ utils */

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function timeOf(ms) {
  const date = new Date(ms || Date.now());
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

async function api(pathname, options = {}) {
  let status = 200;
  let payload = {};
  if (guest.active) {
    let result;
    try {
      result = await guestRequest(pathname, options);
    } catch (error) {
      throw error;
    }
    const decoded = decodeResult(result);
    status = decoded.status;
    payload = decoded.payload;
  } else {
    const init = { method: options.method || 'GET', headers: { Accept: 'application/json' } };
    if (options.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    const response = await fetch(`${pathname}`, init);
    status = response.status;
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
  }
  if (status >= 400 || payload.ok === false) {
    const detail = payload.error || {};
    const error = new Error(detail.message || `HTTP ${status}`);
    error.code = detail.code || `http_${status}`;
    error.status = status;
    throw error;
  }
  return payload;
}

function toast(message, tone = 'info', ttl = 3600) {
  const node = document.createElement('div');
  node.className = `toast ${tone}`;
  node.textContent = message;
  els.toasts.append(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 220);
  }, ttl);
}

function pushEvent(level, message, slotId) {
  state.events.unshift({
    at: Date.now(),
    level: level || 'info',
    message: String(message || ''),
    slotId: slotId || '',
  });
  if (state.events.length > 160) state.events.length = 160;
  renderFeed();
}

/* ------------------------------------------------------------- health math */

function healthTone(healthState) {
  const value = String(healthState || '').toUpperCase();
  if (['ACTIVE', 'HEALTHY', 'READY', 'OK', 'BOUND'].includes(value)) return 'ok';
  if (['ROTATING', 'DEGRADED', 'WARMING', 'QUARANTINED', 'PENDING', 'LAUNCHING'].includes(value)) return 'warn';
  if (['BLOCKED', 'DEAD', 'FAILED', 'ERROR', 'OFFLINE'].includes(value)) return 'bad';
  return 'info';
}

function egressPercent(slot) {
  if (!slot.bound) return 0;
  const tone = healthTone(slot.healthState);
  if (tone === 'ok') return 100;
  if (tone === 'warn') return 56;
  if (tone === 'bad') return 12;
  return 4;
}

function taskPercent(slot) {
  if (!slot.task) return 0;
  const total = Number(slot.task.stepsTotal) || 0;
  if (!total) return slot.task.status === 'DONE' ? 100 : 0;
  const done = Number(slot.task.stepsDone) || 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

function badgeClass(tone) {
  return tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : tone === 'bad' ? 'bad' : 'info';
}

function fingerprintOf(slot) {
  const fp = slot.egressFingerprint || {};
  const exitIp = fp.exitIp || '';
  const asn = fp.asn ? (String(fp.asn).toUpperCase().startsWith('AS') ? String(fp.asn).toUpperCase() : `AS${fp.asn}`) : '';
  return { exitIp, asn, prefix: fp.ipv6Prefix64 || '', leaseId: fp.leaseId || slot.leaseId || '', updatedAt: fp.updatedAt || 0 };
}

/* ---------------------------------------------------------------- filtering */

function matches(slot) {
  const { q, plane, state: stateFilter } = state.filter;
  if (plane !== 'ALL' && String(slot.routingPlane || '') !== plane) return false;
  const browserState = String((slot.browser && slot.browser.state) || 'STOPPED');
  const tone = healthTone(slot.healthState);
  if (stateFilter === 'BOUND' && !slot.bound) return false;
  if (stateFilter === 'RUNNING' && !(browserState === 'RUNNING' || browserState === 'LAUNCHING')) return false;
  if (stateFilter === 'ROTATING' && !(String(slot.healthState).toUpperCase() === 'ROTATING' || (slot.browser && slot.browser.frozen))) return false;
  if (stateFilter === 'BLOCKED' && tone !== 'bad') return false;
  if (stateFilter === 'FREE' && slot.bound) return false;
  if (!q) return true;
  const fp = fingerprintOf(slot);
  const haystack = [
    slot.matrixSlotId,
    slot.egressPort,
    slot.profileId,
    slot.profileName,
    slot.routingPlane,
    slot.healthState,
    browserState,
    fp.exitIp,
    fp.asn,
    fp.leaseId,
  ].join(' ').toLowerCase();
  return q.split(/\s+/).every((token) => haystack.includes(token));
}

/* ------------------------------------------------------------------ render */

function slotCard(slot) {
  const slotId = slot.matrixSlotId;
  const fp = fingerprintOf(slot);
  const tone = healthTone(slot.healthState);
  const browserState = String((slot.browser && slot.browser.state) || 'STOPPED');
  const running = browserState === 'RUNNING' || browserState === 'LAUNCHING';
  const badge = slot.bound ? (browserState === 'LAUNCHING' ? 'LAUNCHING' : slot.healthState || 'UNKNOWN') : 'FREE';
  const taskLabel = slot.task ? `${slot.task.stepsDone}/${slot.task.stepsTotal || '?'}` : '';
  const card = document.createElement('article');
  card.className = `slot${slot.bound ? '' : ' free'}${running ? ' running' : ''}${String(slot.healthState).toUpperCase() === 'ROTATING' ? ' rotating' : ''}${tone === 'bad' ? ' blocked' : ''}`;
  card.dataset.slot = slotId;
  card.dataset.tone = tone;
  if (state.selected === slotId) card.classList.add('selected');

  const profileLine = slot.bound
    ? `<span class="name" title="${escapeHtml(slot.profileName)}">${escapeHtml(slot.profileName || '未命名 Profile')}</span><span class="id">${escapeHtml(slot.profileId)}</span>`
    : '<span class="name">空槽位</span><span class="id">等待绑定 Profile</span>';

  const actions = slot.bound
    ? `<button class="btn small wide ${running ? 'danger' : 'primary'}" data-act="${running ? 'close' : 'launch'}">${running ? '休眠' : '启动'}</button>
       <button class="btn small" data-act="task">任务</button>
       <button class="btn small" data-act="bind">换绑</button>`
    : `<button class="btn small wide primary" data-act="bind">绑定 Profile</button>
       <button class="btn small" data-act="launch" disabled>启动</button>`;

  card.innerHTML = `
    <div class="slot-head">
      <span class="slot-id">${escapeHtml(slotId)}</span>
      <span class="slot-port">${escapeHtml(slot.egressPort)}</span>
      <span class="badge ${slot.bound ? badgeClass(tone) : ''}">${escapeHtml(badge)}</span>
    </div>
    <div class="slot-profile${slot.bound ? '' : ' free'}">${profileLine}</div>
    <div class="tracks">
      <div class="track"><span class="fill egress ${tone === 'warn' ? 'warn' : tone === 'bad' ? 'bad' : ''}" style="width:${egressPercent(slot)}%"></span></div>
      <div class="track"><span class="fill task" style="width:${taskPercent(slot)}%"></span></div>
      <div class="labels"><span>${slot.bound ? '出口' : '空闲'}</span><span>${taskLabel || '任务'}</span></div>
    </div>
    <div class="slot-meta">
      <span class="ip" title="${escapeHtml(fp.exitIp)}">${escapeHtml(fp.exitIp || (slot.bound ? '未取得出口' : '—'))}</span>
      <span class="asn">${escapeHtml(fp.asn)}</span>
      <span class="plane">${escapeHtml(shortPlane(slot.routingPlane))}</span>
    </div>
    <div class="slot-actions">${actions}</div>
  `;
  return card;
}

function shortPlane(plane) {
  const value = String(plane || '');
  if (value === 'FIXED_RESIDENTIAL') return 'FIXED';
  if (value === 'CONTROL_PLANE') return 'CTRL';
  return 'ELASTIC';
}

function renderGrid() {
  const list = [...state.slots.values()]
    .filter(matches)
    .sort((a, b) => a.matrixSlotId.localeCompare(b.matrixSlotId));
  const fragment = document.createDocumentFragment();
  for (const slot of list) fragment.append(slotCard(slot));
  els.grid.replaceChildren(fragment);
  els.empty.hidden = list.length > 0;
  els.count.textContent = list.length === state.slots.size
    ? `${state.slots.size} 个槽位`
    : `${list.length} / ${state.slots.size} 个槽位`;
}

function updateCard(slot) {
  const existing = els.grid.querySelector(`[data-slot="${slot.matrixSlotId}"]`);
  if (!existing) return;
  existing.replaceWith(slotCard(slot));
}

function refreshStats() {
  let bound = 0;
  let running = 0;
  let tasks = 0;
  let healthy = 0;
  for (const slot of state.slots.values()) {
    if (slot.bound) bound += 1;
    if (slot.browser && (slot.browser.state === 'RUNNING' || slot.browser.state === 'LAUNCHING')) running += 1;
    if (slot.task && slot.task.status === 'RUNNING') tasks += 1;
    if (slot.bound && healthTone(slot.healthState) === 'ok') healthy += 1;
  }
  els.statBound.textContent = String(bound);
  els.statRunning.textContent = String(running);
  els.statTasks.textContent = String(tasks);
  els.statEgress.textContent = bound ? `${healthy}/${bound}` : '0';
}

/* ------------------------------------------------------------------ drawer */

function openDrawer(slotId) {
  if (!state.slots.has(slotId)) return;
  if (state.selected !== slotId) {
    els.drawerImage.hidden = true;
    els.drawerImage.removeAttribute('src');
    els.drawerShotEmpty.hidden = false;
  }
  state.selected = slotId;
  els.drawer.hidden = false;
  for (const node of els.grid.querySelectorAll('.slot.selected')) node.classList.remove('selected');
  const card = els.grid.querySelector(`[data-slot="${slotId}"]`);
  if (card) card.classList.add('selected');
  updateDrawer();
  renderFeed();
}

function closeDrawer() {
  els.drawer.hidden = true;
  state.selected = null;
  renderFeed();
}

function updateDrawer() {
  if (!state.selected) return;
  const slot = state.slots.get(state.selected);
  if (!slot) return;
  const fp = fingerprintOf(slot);
  const tone = healthTone(slot.healthState);
  els.drawerSlot.textContent = slot.matrixSlotId;
  els.drawerProfile.textContent = slot.bound ? `${slot.profileName || slot.profileId} · ${slot.profileId}` : '未绑定 Profile';
  els.drawerHealth.textContent = slot.bound ? (slot.healthState || 'UNKNOWN') : 'FREE';
  els.drawerHealth.className = `badge ${slot.bound ? badgeClass(tone) : ''}`;
  els.drawerUrl.textContent = slot.browser && slot.browser.pageUrl ? slot.browser.pageUrl : 'about:blank';
  els.drawerLease.textContent = fp.exitIp
    ? `${fp.exitIp}${fp.asn ? ` · ${fp.asn}` : ''}${fp.leaseId ? ` · ${fp.leaseId}` : ''}`
    : '无租约';
}

function renderFeed() {
  const selected = state.selected;
  const list = state.events.filter((event) => !selected || !event.slotId || event.slotId === selected).slice(0, 60);
  const fragment = document.createDocumentFragment();
  for (const event of list) {
    const item = document.createElement('li');
    item.className = event.level === 'warn' ? 'warn' : event.level === 'error' || event.level === 'bad' ? 'bad' : event.level === 'ok' ? 'ok' : '';
    item.innerHTML = `<span class="t">${timeOf(event.at)}</span><span class="m">${escapeHtml((event.slotId ? `${event.slotId} · ` : '') + event.message)}</span>`;
    fragment.append(item);
  }
  if (!list.length) {
    const item = document.createElement('li');
    item.innerHTML = '<span class="t">--:--:--</span><span class="m">等待事件：启动、观测或换血时这里会滚动</span>';
    fragment.append(item);
  }
  els.feed.replaceChildren(fragment);
}

/* --------------------------------------------------------------- slot data */

function mergeSlots(slots) {
  for (const slot of slots) {
    if (!slot || !slot.matrixSlotId) continue;
    state.slots.set(slot.matrixSlotId, slot);
  }
  refreshStats();
}

async function loadSlots() {
  const payload = await api(`${API}/slots`);
  state.slots.clear();
  mergeSlots(payload.slots || []);
  renderGrid();
  if (state.selected) updateDrawer();
}

async function loadIntegrations() {
  try {
    const payload = await api(`${API}/integrations`);
    state.integrations = payload;
    for (const service of payload.services || []) {
      const node = els.lights.querySelector(`[data-service="${service.id}"]`);
      if (!node) continue;
      node.dataset.ok = service.ok ? '1' : '0';
      node.dataset.busy = '0';
      node.title = `${service.label || service.id} · ${service.ok ? '在线' : '离线'} · ${service.latencyMs}ms${service.error ? ` · ${service.error}` : ''}`;
    }
  } catch (error) {
    pushEvent('warn', `集成探测失败：${error.message}`);
  }
}

function markLightsUnknown() {
  for (const node of els.lights.querySelectorAll('.light')) {
    node.dataset.busy = '1';
    node.dataset.ok = '';
  }
}

els.lights.addEventListener('click', (event) => {
  const node = event.target.closest('.light');
  if (!node || !state.integrations) return;
  const service = (state.integrations.services || []).find((item) => item.id === node.dataset.service);
  if (!service) return;
  toast(`${service.label} · ${service.ok ? '在线' : '离线'} · ${service.latencyMs}ms${service.error ? ` · ${service.error}` : ''}`, service.ok ? 'ok' : 'bad', 5000);
});

/* ---------------------------------------------------------------- actions */

async function withBusy(slotId, key, fn) {
  const id = `${slotId}:${key}`;
  if (state.busy.has(id)) return;
  state.busy.add(id);
  try {
    return await fn();
  } finally {
    state.busy.delete(id);
  }
}

async function launchSlot(slotId) {
  return withBusy(slotId, 'launch', async () => {
    pushEvent('info', '请求启动', slotId);
    const payload = await api(`${API}/profile/launch`, { method: 'POST', body: { matrixSlotId: slotId } });
    if (payload.slot) {
      const previous = state.slots.get(slotId) || {};
      state.slots.set(slotId, payload.slot);
      if (previous.bound !== undefined) updateCard(payload.slot);
      updateDrawer();
      refreshStats();
    }
    toast(`${slotId} 已启动`, 'ok');
    pushEvent('ok', '浏览器已启动并接管', slotId);
  }).catch((error) => {
    pushEvent('error', error.message, slotId);
    toast(`${slotId} 启动失败：${error.message}`, 'bad', 6000);
    throw error;
  });
}

async function closeSlot(slotId) {
  return withBusy(slotId, 'close', async () => {
    const payload = await api(`${API}/profile/close`, { method: 'POST', body: { matrixSlotId: slotId } });
    if (payload.slot) {
      state.slots.set(slotId, payload.slot);
      updateCard(payload.slot);
      updateDrawer();
      refreshStats();
    }
    toast(`${slotId} 已休眠`, 'ok');
    pushEvent('ok', '已休眠，绑定与 Cookie 保留', slotId);
  }).catch((error) => {
    pushEvent('error', error.message, slotId);
    toast(`${slotId} 休眠失败：${error.message}`, 'bad', 6000);
    throw error;
  });
}

async function observeSlot(slotId) {
  return withBusy(slotId, 'observe', async () => {
    const payload = await api(`${API}/page/observe`, { method: 'POST', body: { matrixSlotId: slotId } });
    const snapshot = payload.snapshot || {};
    const elements = Array.isArray(snapshot.elements) ? snapshot.elements.length : 0;
    pushEvent('ok', `观测 ${snapshot.title || snapshot.url || '页面'} · ${elements} 个可操作元素`, slotId);
    toast(`${snapshot.title || snapshot.url || '页面'} · ${elements} 元素`, 'ok');
    return snapshot;
  }).catch((error) => {
    pushEvent('error', error.message, slotId);
    toast(`观测失败：${error.message}`, 'bad', 5000);
    throw error;
  });
}

async function screenshotSlot(slotId) {
  return withBusy(slotId, 'shot', async () => {
    const payload = await api(`${API}/page/screenshot`, { method: 'POST', body: { matrixSlotId: slotId } });
    if (payload.dataUrl) {
      els.drawerImage.src = payload.dataUrl;
      els.drawerImage.hidden = false;
      els.drawerShotEmpty.hidden = true;
      pushEvent('ok', '已抓取页面截图', slotId);
    }
    return payload;
  }).catch((error) => {
    pushEvent('error', `截图失败：${error.message}`, slotId);
    toast(`截图失败：${error.message}`, 'bad', 5000);
    throw error;
  });
}

/* -------------------------------------------------------------- bind modal */

async function openBind(slotId) {
  state.bindTarget = slotId;
  const slot = state.slots.get(slotId);
  els.bindSlot.textContent = slotId;
  els.bindPort.textContent = String(slot ? slot.egressPort : 24000 + Number(String(slotId).slice(-3)));
  els.bindNote.textContent = '正在读取 ShardX Profile…';
  els.bindSearch.value = '';
  els.profileList.replaceChildren();
  if (typeof els.bindDialog.showModal === 'function') els.bindDialog.showModal();
  else els.bindDialog.setAttribute('open', '');
  try {
    const payload = await api(`${API}/profiles?refresh=1`);
    state.profiles = payload.profiles || [];
    els.bindNote.textContent = state.profiles.length ? '点击一个 Profile 立即绑定' : 'ShardX 里没有可用 Profile';
    renderProfiles();
  } catch (error) {
    els.bindNote.textContent = `读取失败：${error.message}`;
  }
}

function renderProfiles() {
  const query = els.bindSearch.value.trim().toLowerCase();
  const list = state.profiles.filter((profile) => {
    if (!query) return true;
    return `${profile.name || ''} ${profile.id} ${profile.notes || ''}`.toLowerCase().includes(query);
  });
  const fragment = document.createDocumentFragment();
  for (const profile of list) {
    const boundElsewhere = profile.bound && profile.matrixSlotId !== state.bindTarget;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'profile-item';
    button.dataset.profileId = profile.id;
    button.dataset.profileName = profile.name || '';
    button.disabled = boundElsewhere;
    button.innerHTML = `
      <span class="pi-main">
        <span class="pi-name">${escapeHtml(profile.name || '未命名')}${profile.running ? ' · 运行中' : ''}</span>
        <span class="pi-id">${escapeHtml(profile.id)}</span>
      </span>
      <span class="pi-tags">
        ${boundElsewhere ? `<span class="badge warn">${escapeHtml(profile.matrixSlotId)}</span>` : ''}
        ${profile.bound && !boundElsewhere ? '<span class="badge ok">当前</span>' : ''}
        ${profile.running ? '<span class="badge info">RUN</span>' : ''}
      </span>
    `;
    fragment.append(button);
  }
  if (!list.length) {
    const note = document.createElement('p');
    note.className = 'modal-note';
    note.textContent = '没有匹配的 Profile';
    fragment.append(note);
  }
  els.profileList.replaceChildren(fragment);
}

els.bindSearch.addEventListener('input', renderProfiles);

els.profileList.addEventListener('click', async (event) => {
  const item = event.target.closest('.profile-item');
  if (!item || item.disabled) return;
  const slotId = state.bindTarget;
  els.bindNote.textContent = '绑定中…';
  try {
    const payload = await api(`${API}/slots/${slotId}/bind`, {
      method: 'POST',
      body: { profileId: item.dataset.profileId, profileName: item.dataset.profileName, source: 'panel' },
    });
    if (payload.slot) {
      state.slots.set(slotId, payload.slot);
      updateCard(payload.slot);
      updateDrawer();
      refreshStats();
    }
    toast(`${slotId} 已绑定 ${item.dataset.profileName || item.dataset.profileId}`, 'ok');
    pushEvent('ok', `绑定 Profile ${item.dataset.profileId}`, slotId);
    els.bindDialog.close('bound');
  } catch (error) {
    els.bindNote.textContent = `绑定失败：${error.message}`;
    toast(`绑定失败：${error.message}`, 'bad', 5000);
  }
});

/* -------------------------------------------------------------- task modal */

function openTask(slotId) {
  const slot = state.slots.get(slotId);
  if (!slot || !slot.bound) {
    toast('先给槽位绑定 Profile', 'warn');
    return;
  }
  els.taskSlot.textContent = slotId;
  els.taskNote.textContent = 'JSON 数组，至少一步；点击开始会等待换血屏障';
  els.taskSteps.value = JSON.stringify([
    { action: 'goto', url: slot.browser && slot.browser.pageUrl ? slot.browser.pageUrl : 'https://example.com' },
    { action: 'observe' },
  ], null, 2);
  els.taskRun.disabled = false;
  if (typeof els.taskDialog.showModal === 'function') els.taskDialog.showModal();
  else els.taskDialog.setAttribute('open', '');
}

els.taskDialog.addEventListener('submit', async (event) => {
  const submitter = event.submitter;
  if (!submitter || submitter.value !== 'run') return;
  event.preventDefault();
  const slotId = els.taskSlot.textContent;
  let steps;
  try {
    steps = JSON.parse(els.taskSteps.value);
  } catch (error) {
    els.taskNote.textContent = `JSON 解析失败：${error.message}`;
    return;
  }
  if (!Array.isArray(steps) || !steps.length) {
    els.taskNote.textContent = 'steps 必须是非空数组';
    return;
  }
  els.taskRun.disabled = true;
  els.taskNote.textContent = `执行中…（${steps.length} 步）`;
  pushEvent('info', `任务开始 · ${steps.length} 步`, slotId);
  try {
    const payload = await api(`${API}/task/execute`, {
      method: 'POST',
      body: { matrixSlotId: slotId, steps, source: 'panel' },
    });
    const task = payload.task || {};
    pushEvent(
      task.status === 'DONE' ? 'ok' : task.status === 'CANCELLED' ? 'warn' : 'error',
      `任务 ${task.id || ''} ${task.status || '完成'} · ${task.stepsDone || steps.length}/${task.stepsTotal || steps.length}`,
      slotId,
    );
    toast(`任务 ${task.status || '完成'}`, task.status === 'DONE' ? 'ok' : 'warn', 5000);
    els.taskDialog.close('done');
    await loadSlots();
  } catch (error) {
    els.taskNote.textContent = `执行失败：${error.message}`;
    pushEvent('error', error.message, slotId);
    toast(`任务失败：${error.message}`, 'bad', 6000);
  } finally {
    els.taskRun.disabled = false;
  }
});

/* ------------------------------------------------------------ quick action */

function stepFromQuick() {
  const action = els.quickAction.value;
  const target = els.quickTarget.value.trim();
  const value = els.quickValue.value;
  const step = { action };
  const isRef = /^e\d+$/i.test(target);
  if (target) {
    if (isRef) step.ref = target;
    else if (action === 'goto' || action === 'navigate') step.url = target;
    else step.selector = target;
  }
  if (action === 'goto') {
    if (!step.url) step.url = target || 'about:blank';
  }
  if (action === 'fill') step.text = value;
  if (action === 'press') step.key = value || target || 'Enter';
  if (action === 'scroll') step.deltaY = Number(value) || 600;
  if (action === 'wait') {
    step.ms = Number(value) || 1000;
    if (target && !isRef) step.text = target;
  }
  if (action === 'extract' && value) step.attribute = value;
  if (action === 'assertText') step.text = value;
  if (action === 'eval') step.expression = value || target;
  return step;
}

els.quickForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const slotId = state.selected;
  if (!slotId) return;
  const step = stepFromQuick();
  pushEvent('info', `动作 ${step.action}${step.ref ? ` ${step.ref}` : step.selector ? ` ${step.selector}` : ''}`, slotId);
  try {
    const payload = await api(`${API}/page/act`, { method: 'POST', body: Object.assign({ matrixSlotId: slotId }, step) });
    const result = payload.result;
    const text = result && result.value !== undefined ? String(result.value).slice(0, 180) : 'ok';
    pushEvent('ok', `${step.action} → ${text}`, slotId);
    toast(`${step.action} 完成`, 'ok');
    if (['goto', 'click', 'press', 'scroll'].includes(step.action)) {
      const current = state.slots.get(slotId);
      if (current && current.browser) {
        current.browser.pageUrl = (result && result.url) || current.browser.pageUrl;
      }
      updateDrawer();
    }
  } catch (error) {
    pushEvent('error', `${step.action} 失败：${error.message}`, slotId);
    toast(`动作失败：${error.message}`, 'bad', 5000);
  }
});

/* -------------------------------------------------------------- bulk tools */

async function runPool(items, concurrency, worker) {
  const queue = [...items];
  const results = [];
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        results.push({ item, ok: true, value: await worker(item) });
      } catch (error) {
        results.push({ item, ok: false, error: error.message });
      }
    }
  });
  await Promise.all(runners);
  return results;
}

document.getElementById('btn-launch').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const targets = [...state.slots.values()].filter((slot) => slot.bound).map((slot) => slot.matrixSlotId);
  if (!targets.length) {
    toast('没有已绑定的槽位可以启动', 'warn');
    return;
  }
  button.disabled = true;
  button.textContent = `启动中 0/${targets.length}`;
  pushEvent('info', `批量启动 ${targets.length} 个槽位`);
  let done = 0;
  const results = await runPool(targets, 3, async (slotId) => {
    const payload = await api(`${API}/profile/launch`, { method: 'POST', body: { matrixSlotId: slotId } });
    done += 1;
    button.textContent = `启动中 ${done}/${targets.length}`;
    if (payload.slot) {
      state.slots.set(slotId, payload.slot);
      updateCard(payload.slot);
      refreshStats();
    }
    return payload;
  });
  button.disabled = false;
  button.textContent = '全部启动';
  const failed = results.filter((item) => !item.ok);
  pushEvent(failed.length ? 'warn' : 'ok', `批量启动完成：${results.length - failed.length}/${targets.length} 成功`);
  toast(`批量启动完成：${results.length - failed.length}/${targets.length}`, failed.length ? 'warn' : 'ok', 5000);
});

document.getElementById('btn-sleep').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = '休眠中…';
  try {
    const payload = await api(`${API}/profile/sleep-all`, { method: 'POST', body: {} });
    pushEvent('ok', `全部休眠：${payload.total || 0} 个槽位`);
    toast(`全部休眠完成（${payload.total || 0}）`, 'ok');
    await loadSlots();
  } catch (error) {
    toast(`全部休眠失败：${error.message}`, 'bad', 6000);
  } finally {
    button.disabled = false;
    button.textContent = '全部休眠';
  }
});

document.getElementById('btn-sync').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = '同步中…';
  try {
    const payload = await api(`${API}/profile/sync-proxies`, { method: 'POST', body: {} });
    pushEvent('ok', `代理同步：${payload.synced || 0}/${payload.total || 0}`);
    toast(`代理同步 ${payload.synced || 0}/${payload.total || 0}`, 'ok');
    await loadSlots();
  } catch (error) {
    toast(`代理同步失败：${error.message}`, 'bad', 6000);
  } finally {
    button.disabled = false;
    button.textContent = '同步代理';
  }
});

/* ----------------------------------------------------------------- settings */

document.getElementById('btn-settings').addEventListener('click', async () => {
  els.settingsNote.textContent = '读取中…';
  if (typeof els.settingsDialog.showModal === 'function') els.settingsDialog.showModal();
  else els.settingsDialog.setAttribute('open', '');
  try {
    const payload = await api(`${API}/settings`);
    const settings = payload.settings || {};
    document.getElementById('set-start-url').value = settings.defaultStartUrl || 'about:blank';
    document.getElementById('set-headless').value = settings.headless ? 'true' : 'false';
    document.getElementById('set-poisson-min').value = settings.poissonMinMs;
    document.getElementById('set-poisson-max').value = settings.poissonMaxMs;
    document.getElementById('set-freeze').value = settings.freezeTimeoutMs;
    document.getElementById('set-launch').value = settings.launchTimeoutMs;
    document.getElementById('set-require-lease').checked = settings.requireEgressLease !== false;
    document.getElementById('set-egress-url').value = settings.egressBusUrl || '';
    els.settingsNote.textContent = '';
  } catch (error) {
    els.settingsNote.textContent = `读取失败：${error.message}`;
  }
});

els.settingsDialog.addEventListener('submit', async (event) => {
  const submitter = event.submitter;
  if (!submitter || submitter.value !== 'save') return;
  event.preventDefault();
  els.settingsNote.textContent = '保存中…';
  const settings = {
    defaultStartUrl: document.getElementById('set-start-url').value.trim() || 'about:blank',
    headless: document.getElementById('set-headless').value === 'true',
    poissonMinMs: Number(document.getElementById('set-poisson-min').value) || 400,
    poissonMaxMs: Number(document.getElementById('set-poisson-max').value) || 1800,
    freezeTimeoutMs: Number(document.getElementById('set-freeze').value) || 30000,
    launchTimeoutMs: Number(document.getElementById('set-launch').value) || 60000,
    requireEgressLease: document.getElementById('set-require-lease').checked,
    egressBusUrl: document.getElementById('set-egress-url').value.trim(),
  };
  try {
    await api(`${API}/settings`, { method: 'POST', body: { settings } });
    els.settingsNote.textContent = '已保存';
    toast('设置已保存', 'ok');
    setTimeout(() => els.settingsDialog.close('saved'), 350);
  } catch (error) {
    els.settingsNote.textContent = `保存失败：${error.message}`;
  }
});

/* ------------------------------------------------------------------- WS */

function wsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}${WS_PATH}?clientId=panel-${Math.random().toString(36).slice(2, 8)}&role=panel`;
}

function setWsState(mode) {
  if (mode === 'online') {
    els.wsDot.className = 'ws-dot online';
    els.wsLabel.textContent = '实时在线';
  } else if (mode === 'connecting') {
    els.wsDot.className = 'ws-dot';
    els.wsLabel.textContent = '连接中';
  } else {
    els.wsDot.className = 'ws-dot offline';
    els.wsLabel.textContent = '已断开';
  }
}

function connectWs() {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
  setWsState('connecting');
  let socket;
  try {
    socket = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  state.ws = socket;

  socket.addEventListener('open', () => {
    state.wsBackoff = 800;
    setWsState('online');
    try { socket.send(JSON.stringify({ type: 'HELLO', role: 'panel' })); } catch { /* ignore */ }
  });

  socket.addEventListener('message', (event) => {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    handleFrame(frame);
  });

  socket.addEventListener('close', () => {
    setWsState('offline');
    scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    try { socket.close(); } catch { /* ignore */ }
  });
}

function scheduleReconnect() {
  if (state.wsTimer) return;
  const delay = state.wsBackoff;
  state.wsBackoff = Math.min(state.wsBackoff * 1.7, 12000);
  state.wsTimer = setTimeout(() => {
    state.wsTimer = null;
    connectWs();
  }, delay);
}

function handleFrame(frame) {
  if (!frame || typeof frame !== 'object') return;
  switch (frame.type) {
    case 'SERVICE_READY':
    case 'WELCOME':
      setWsState('online');
      break;
    case 'PRE_ROTATION_FREEZE':
      try { state.ws.send(JSON.stringify({ type: 'ACK_FREEZE', eventId: frame.eventId })); } catch { /* ignore */ }
      pushEvent('warn', `换血冻结${frame.reason ? ` · ${frame.reason}` : ''}`, frame.matrixSlotId);
      break;
    case 'POST_ROTATION_RESUME':
      pushEvent('ok', '换血完成，动作恢复', frame.matrixSlotId);
      break;
    case 'slot.updated':
      if (frame.slot) {
        state.slots.set(frame.slot.matrixSlotId, frame.slot);
        updateCard(frame.slot);
        if (state.selected === frame.slot.matrixSlotId) updateDrawer();
        refreshStats();
      }
      break;
    case 'slot.bound':
      if (frame.slot) {
        state.slots.set(frame.slot.matrixSlotId, frame.slot);
        updateCard(frame.slot);
        refreshStats();
      }
      break;
    case 'slot.unbound':
      loadSlots().catch(() => {});
      break;
    case 'slot.launching':
      pushEvent('info', '启动中…', frame.matrixSlotId);
      break;
    case 'slot.launched':
      pushEvent('ok', `浏览器已接管${frame.engine ? ` · ${frame.engine}` : ''}`, frame.matrixSlotId);
      break;
    case 'slot.closed':
      pushEvent('info', '已休眠', frame.matrixSlotId);
      break;
    case 'slot.failed':
      pushEvent('error', frame.message || '启动失败', frame.matrixSlotId);
      break;
    case 'task.started':
      pushEvent('info', `任务开始 · ${frame.stepsTotal || 0} 步`, frame.matrixSlotId);
      break;
    case 'task.log':
      pushEvent(frame.level === 'warn' ? 'warn' : frame.level === 'error' ? 'error' : 'info', frame.message, frame.matrixSlotId);
      break;
    case 'task.done': {
      const task = frame.task || {};
      pushEvent(task.status === 'DONE' ? 'ok' : task.status === 'CANCELLED' ? 'warn' : 'error',
        `任务 ${task.status || ''} · ${task.stepsDone || 0}/${task.stepsTotal || 0}${task.error ? ` · ${task.error}` : ''}`,
        task.matrixSlotId);
      break;
    }
    case 'rotation.freeze':
      pushEvent('warn', `出口换血：${frame.reason || 'rotation'}`, frame.matrixSlotId);
      break;
    case 'rotation.resume':
      pushEvent('ok', '出口换血完成', frame.matrixSlotId);
      break;
    case 'rotation.failed':
      pushEvent('error', `换血失败：${frame.message || ''}`, frame.matrixSlotId);
      break;
    case 'settings.updated':
      pushEvent('info', '设置已更新');
      break;
    default:
      if (frame.type && frame.type.startsWith('task.')) {
        pushEvent('info', frame.type, frame.matrixSlotId);
      }
  }
}

/* ----------------------------------------------------------------- events */

els.grid.addEventListener('click', async (event) => {
  const card = event.target.closest('.slot');
  if (!card) return;
  const slotId = card.dataset.slot;
  const action = event.target.closest('[data-act]');
  if (!action) {
    openDrawer(slotId);
    return;
  }
  event.stopPropagation();
  const kind = action.dataset.act;
  if (kind === 'bind') openBind(slotId);
  else if (kind === 'launch') launchSlot(slotId).catch(() => {});
  else if (kind === 'close') closeSlot(slotId).catch(() => {});
  else if (kind === 'task') openTask(slotId);
});

els.query.addEventListener('input', debounce(() => {
  state.filter.q = els.query.value.trim().toLowerCase();
  renderGrid();
}, 100));

els.plane.addEventListener('change', () => {
  state.filter.plane = els.plane.value;
  renderGrid();
});

els.stateFilter.addEventListener('change', () => {
  state.filter.state = els.stateFilter.value;
  renderGrid();
});

document.getElementById('drawer-close').addEventListener('click', closeDrawer);
document.getElementById('drawer-shot-btn').addEventListener('click', () => {
  if (state.selected) screenshotSlot(state.selected).catch(() => {});
});
document.getElementById('drawer-observe').addEventListener('click', () => {
  if (state.selected) observeSlot(state.selected).catch(() => {});
});
document.getElementById('quick-observe').addEventListener('click', () => {
  if (state.selected) observeSlot(state.selected).catch(() => {});
});
document.getElementById('feed-clear').addEventListener('click', () => {
  state.events = [];
  renderFeed();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !els.drawer.hidden
    && !els.bindDialog.open && !els.taskDialog.open && !els.settingsDialog.open) {
    closeDrawer();
  }
});

/* ------------------------------------------------------------------- boot */

async function boot() {
  if (guest.active) {
    els.wsDot.className = 'ws-dot online';
    els.wsLabel.textContent = '宿主桥';
  } else {
    setWsState('connecting');
  }
  markLightsUnknown();
  try {
    const health = await api('/health');
    els.version.textContent = `v${health.version || '2.0.0'}`;
  } catch { /* the API call below surfaces real failures */ }

  try {
    await loadSlots();
  } catch (error) {
    toast(`读取槽位失败：${error.message}`, 'bad', 8000);
    pushEvent('error', `读取槽位失败：${error.message}`);
  }

  if (guest.active) {
    setInterval(() => { loadSlots().catch(() => {}); }, 5000);
  } else {
    connectWs();
  }
  loadIntegrations().catch(() => {});
  setInterval(() => { loadIntegrations().catch(() => {}); }, 12000);

  pushEvent('info', guest.active ? '面板已就绪（经宿主代理轮询）' : '面板已就绪，等待槽位事件');
}

boot();
