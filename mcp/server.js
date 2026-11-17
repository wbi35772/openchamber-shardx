#!/usr/bin/env node
'use strict';

/*
 * OpenChamber ShardX matrix MCP server.
 *
 * Transport:
 *   node mcp/server.js            JSON-RPC over STDIO (default)
 *   node mcp/server.js --sse      MCP SSE transport on 127.0.0.1:19885
 *
 * The server is a thin client of `service/main.js` on 127.0.0.1:19884, which
 * keeps exactly one orchestrator that owns the browsers and the profile store.
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');

const contract = require('../core/contract');
const { requestJson } = require('../lib/http-client');

const SERVER_NAME = 'shardx-matrix';
const SERVER_VERSION = '2.0.0';
const PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_SERVICE_BASE = `http://127.0.0.1:${contract.SHARDX_SERVICE_PORT}`;
const DEFAULT_SSE_PORT = contract.SHARDX_MCP_SSE_PORT;

const SLOT_SCHEMA = {
  type: 'string',
  pattern: '^slot-\\d{3}$',
  description: '矩阵槽位 ID，slot-001..slot-250（对应代理端口 24001-24250）',
};

const STEP_SCHEMA = {
  type: 'object',
  description: '一个浏览器动作。支持 goto/click/fill/press/scroll/wait/extract/assertText/screenshot/eval/hover',
  properties: {
    action: {
      type: 'string',
      enum: ['goto', 'navigate', 'click', 'fill', 'press', 'scroll', 'wait', 'observe', 'snapshot', 'extract', 'assertText', 'assert', 'screenshot', 'eval', 'hover'],
    },
    url: { type: 'string', description: 'goto 目标 URL' },
    ref: { type: 'string', description: 'page_observe 返回的 e1..eN 引用' },
    selector: { type: 'string', description: 'CSS 选择器（ref 缺失时使用）' },
    text: { type: 'string', description: 'fill 的输入内容 / wait/assert 的文本' },
    value: { type: 'string', description: 'fill / wait / extract 的通用值' },
    key: { type: 'string', description: 'press 的按键，如 Enter / Tab' },
    x: { type: 'number' },
    y: { type: 'number' },
    deltaX: { type: 'number' },
    deltaY: { type: 'number' },
    attribute: { type: 'string', description: 'extract 时要读的属性' },
    expression: { type: 'string', description: 'eval 的 JS 表达式' },
    ms: { type: 'number', description: 'wait 的毫秒数' },
    timeoutMs: { type: 'number' },
    retries: { type: 'number', description: '失败重试次数 1-5' },
    continueOnError: { type: 'boolean' },
    as: { type: 'string', description: '把结果写入 results 的键名' },
    submit: { type: 'boolean', description: 'fill 后是否按 Enter' },
    clear: { type: 'boolean', description: 'fill 前是否清空输入框' },
  },
  required: ['action'],
};

const TOOLS = Object.freeze([
  {
    name: 'shardx_slot_launch',
    title: '启动矩阵槽位',
    description: '在指定矩阵槽位启动绑定好的 ShardX Profile：先取 egress 租约，把 Profile 代理对齐到 127.0.0.1:24000+index、按出口国家对齐时区/语言，再启动浏览器并用 CDP 接管。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        matrixSlotId: SLOT_SCHEMA,
        startUrl: { type: 'string', description: '启动后打开的首个页面，默认使用全局设置' },
      },
      required: ['matrixSlotId'],
    },
  },
  {
    name: 'shardx_page_observe',
    title: '观测页面',
    description: '返回当前页面的语义快照：URL、标题、可见文本、ARIA 树，以及带稳定 e1..eN 引用和坐标的可操作元素列表。动作前先观测，点击用 ref 最稳。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { matrixSlotId: SLOT_SCHEMA },
      required: ['matrixSlotId'],
    },
  },
  {
    name: 'shardx_page_act',
    title: '页面动作',
    description: '在已启动的槽位里执行单个动作（点击、输入、按键、滚动、等待、提取、断言、截图、eval、hover）。动作按泊松延迟 400-1800ms 执行，并受 egress 换血冻结屏障约束。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: Object.assign({ matrixSlotId: SLOT_SCHEMA }, STEP_SCHEMA.properties),
      required: ['matrixSlotId', 'action'],
    },
  },
  {
    name: 'shardx_task_run',
    title: '执行任务序列',
    description: '在一个槽位里顺序执行多步任务，返回完整的任务记录（状态、每步结果、日志）。每一步之间自动加入人类化延迟，冻结期间自动等待，失败可按 retries 重试。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        matrixSlotId: SLOT_SCHEMA,
        steps: { type: 'array', minItems: 1, maxItems: 200, items: STEP_SCHEMA },
        source: { type: 'string', description: '任务来源标记，默认 mcp' },
      },
      required: ['matrixSlotId', 'steps'],
    },
  },
  {
    name: 'shardx_slot_close',
    title: '休眠矩阵槽位',
    description: '断开 CDP、停止 ShardX Profile 并把槽位状态置为 STOPPED，但保留 slot↔profile 绑定、Cookie 和任务历史。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        matrixSlotId: SLOT_SCHEMA,
        keepUrl: { type: 'boolean', description: '保留最后访问的 URL 记录' },
      },
      required: ['matrixSlotId'],
    },
  },
]);

function toolList() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

function textResult(payload, isError = false) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text }], isError };
}

function requireSlot(args) {
  const slotId = String(args && (args.matrixSlotId || args.matrix_slot_id) || '').trim();
  if (!contract.indexForSlotId(slotId)) {
    throw Object.assign(new Error('matrixSlotId 必须是 slot-001..slot-250'), {
      code: 'invalid_slot',
      status: 400,
    });
  }
  return slotId;
}

function pickActStep(args) {
  const step = {};
  for (const key of Object.keys(STEP_SCHEMA.properties)) {
    if (args[key] !== undefined) step[key] = args[key];
  }
  return step;
}

function discoveryPaths(env) {
  const paths = [];
  const explicit = String(env.SHARDX_MATRIX_SERVICE_DISCOVERY || '').trim();
  if (explicit) paths.push(explicit);
  const dataDir = String(env.OPENCHAMBER_SERVICE_DATA_DIR || '').trim();
  if (dataDir) paths.push(path.join(dataDir, 'service.json'));
  paths.push(path.join(os.homedir(), '.openchamber-shardx-matrix', 'run', 'service.json'));
  return Array.from(new Set(paths));
}

function readDiscovery(env) {
  for (const file of discoveryPaths(env)) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!record || !record.url) continue;
    if (record.pid) {
      try {
        process.kill(record.pid, 0);
      } catch {
        continue;
      }
    }
    return { url: String(record.url), token: record.token ? String(record.token) : '' };
  }
  return null;
}

function createMcpServer(options = {}) {
  const env = options.env || process.env;
  const explicitBase = options.serviceBaseUrl || env.SHARDX_MATRIX_SERVICE_URL || '';
  const explicitToken = String(options.token !== undefined
    ? options.token
    : (env.OPENCHAMBER_SERVICE_TOKEN || '')).trim();
  const request = options.request || requestJson;
  const log = typeof options.log === 'function' ? options.log : () => {};
  let lastTarget = null;

  function resolveTarget() {
    if (explicitBase) {
      return {
        base: contract.normalizeServiceBase(explicitBase, DEFAULT_SERVICE_BASE),
        token: explicitToken,
      };
    }
    const discovered = readDiscovery(env);
    const target = discovered
      ? {
        base: contract.normalizeServiceBase(discovered.url, DEFAULT_SERVICE_BASE),
        token: explicitToken || discovered.token,
      }
      : lastTarget || { base: DEFAULT_SERVICE_BASE, token: explicitToken };
    lastTarget = target;
    return target;
  }

  async function serviceCall(method, pathname, body) {
    const target = resolveTarget();
    const headers = { Accept: 'application/json' };
    if (target.token) headers.Authorization = `Bearer ${target.token}`;
    const response = await request(`${target.base}${pathname}`, {
      method,
      headers,
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
      timeoutMs: Number(options.timeoutMs) || 120000,
      allowNon2xx: true,
    });
    const payload = response.body && typeof response.body === 'object'
      ? response.body
      : { ok: false, error: { code: `http_${response.status}`, message: response.text || 'empty response' } };
    if (response.status < 200 || response.status >= 300 || payload.ok === false) {
      const detail = payload.error || {};
      throw Object.assign(
        new Error(detail.message || `${method} ${pathname} -> ${response.status}`),
        { code: detail.code || `http_${response.status}`, status: response.status },
      );
    }
    return payload;
  }

  async function callTool(name, args) {
    const input = args && typeof args === 'object' ? args : {};
    if (name === 'shardx_slot_launch') {
      return serviceCall('POST', '/api/v1/shardx/profile/launch', {
        matrixSlotId: requireSlot(input),
        startUrl: input.startUrl,
      });
    }
    if (name === 'shardx_page_observe') {
      return serviceCall('POST', '/api/v1/shardx/page/observe', {
        matrixSlotId: requireSlot(input),
      });
    }
    if (name === 'shardx_page_act') {
      const step = pickActStep(input);
      if (step.action === undefined) {
        throw Object.assign(new Error('page_act 需要 action'), { code: 'action_required', status: 400 });
      }
      return serviceCall('POST', '/api/v1/shardx/page/act', Object.assign(step, {
        matrixSlotId: requireSlot(input),
      }));
    }
    if (name === 'shardx_task_run') {
      const steps = Array.isArray(input.steps) ? input.steps : [];
      if (!steps.length) {
        throw Object.assign(new Error('task_run 需要至少一个步骤'), { code: 'steps_required', status: 400 });
      }
      return serviceCall('POST', '/api/v1/shardx/task/execute', {
        matrixSlotId: requireSlot(input),
        steps,
        source: String(input.source || 'mcp'),
      });
    }
    if (name === 'shardx_slot_close') {
      return serviceCall('POST', '/api/v1/shardx/profile/close', {
        matrixSlotId: requireSlot(input),
        keepUrl: input.keepUrl === true,
      });
    }
    throw Object.assign(new Error(`未知工具：${name}`), { code: 'unknown_tool', status: 404 });
  }

  async function handle(message) {
    if (!message || typeof message !== 'object') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
    const id = hasId ? message.id : null;
    const method = String(message.method || '');
    const params = message.params && typeof message.params === 'object' ? message.params : {};

    if (!method) {
      return hasId
        ? { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } }
        : null;
    }

    if (method.startsWith('notifications/')) return null;

    try {
      if (method === 'initialize') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            instructions: 'ShardX 矩阵浏览器：用 shardx_slot_launch 启动槽位，shardx_page_observe 观测，shardx_page_act / shardx_task_run 执行动作，shardx_slot_close 休眠。槽位与代理端口固定为 24000+序号。',
          },
        };
      }
      if (method === 'ping') {
        return { jsonrpc: '2.0', id, result: {} };
      }
      if (method === 'tools/list') {
        return { jsonrpc: '2.0', id, result: { tools: toolList() } };
      }
      if (method === 'tools/call') {
        const name = String(params.name || '');
        try {
          const payload = await callTool(name, params.arguments || {});
          const isError = payload && payload.ok === false;
          return { jsonrpc: '2.0', id, result: textResult(payload, Boolean(isError)) };
        } catch (error) {
          return {
            jsonrpc: '2.0',
            id,
            result: textResult(
              { ok: false, error: { code: error.code || 'tool_failed', message: error.message } },
              true,
            ),
          };
        }
      }
      if (method === 'resources/list') {
        return { jsonrpc: '2.0', id, result: { resources: [] } };
      }
      if (method === 'prompts/list') {
        return { jsonrpc: '2.0', id, result: { prompts: [] } };
      }
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    } catch (error) {
      log(`[mcp] ${method} 失败：${error.message}`);
      return { jsonrpc: '2.0', id, error: { code: -32603, message: error.message || 'Internal error' } };
    }
  }

  return {
    handle,
    callTool,
    get serviceBase() {
      return resolveTarget().base;
    },
    tools: toolList(),
  };
}

/* ------------------------------------------------------------------------- */
/* STDIO transport                                                           */
/* ------------------------------------------------------------------------- */

function runStdio(server) {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  let chain = Promise.resolve();

  function write(message) {
    if (!message) return;
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  rl.on('line', (line) => {
    const text = String(line || '').trim();
    if (!text) return;
    chain = chain.then(async () => {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      if (Array.isArray(message)) {
        const responses = [];
        for (const item of message) {
          const response = await server.handle(item);
          if (response) responses.push(response);
        }
        if (responses.length) write(responses);
        return;
      }
      write(await server.handle(message));
    }).catch((error) => {
      write({ jsonrpc: '2.0', id: null, error: { code: -32603, message: error.message } });
    });
  });

  rl.on('close', () => {
    process.exit(0);
  });
}

/* ------------------------------------------------------------------------- */
/* SSE transport                                                             */
/* ------------------------------------------------------------------------- */

function runSse(server, options = {}) {
  const port = Number(options.port) || DEFAULT_SSE_PORT;
  const host = options.host || '127.0.0.1';
  const sessions = new Map();

  const httpServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${host}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      const body = Buffer.from(JSON.stringify({
        ok: true,
        service: 'shardx-mcp',
        version: SERVER_VERSION,
        transport: 'sse',
        sessions: sessions.size,
        upstream: server.serviceBase,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(body.length) });
      res.end(body);
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/sse' || url.pathname === '/')) {
      const sessionId = crypto.randomBytes(12).toString('hex');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);
      const keepAlive = setInterval(() => {
        try { res.write(': keep-alive\n\n'); } catch { /* closed */ }
      }, 15000);
      if (keepAlive.unref) keepAlive.unref();
      sessions.set(sessionId, { res, keepAlive });
      req.on('close', () => {
        clearInterval(keepAlive);
        sessions.delete(sessionId);
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/messages') {
      const sessionId = String(url.searchParams.get('sessionId') || '');
      const session = sessions.get(sessionId);
      if (!session) {
        const body = Buffer.from(JSON.stringify({ ok: false, error: { code: 'session_missing', message: '未知的 SSE 会话' } }));
        res.writeHead(404, { 'Content-Type': 'application/json', 'Content-Length': String(body.length) });
        res.end(body);
        return;
      }
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 8 * 1024 * 1024) chunks.push(chunk);
      });
      req.on('end', async () => {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        let message;
        try {
          message = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          session.res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n\n`);
          return;
        }
        const response = await server.handle(message);
        if (!response) return;
        try {
          session.res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
        } catch { /* closed */ }
      });
      return;
    }

    const body = Buffer.from('Not found');
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Content-Length': String(body.length) });
    res.end(body);
  });

  return new Promise((resolve, reject) => {
    httpServer.on('error', reject);
    httpServer.listen(port, host, () => {
      const address = httpServer.address();
      const actual = address && address.port ? address.port : port;
      resolve({ server: httpServer, port: actual, url: `http://${host}:${actual}/sse` });
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const log = (line) => {
    if (process.env.SHARDX_MCP_LOG === '1') console.error(`${new Date().toISOString()} ${line}`);
  };
  const server = createMcpServer({ log });

  if (argv.includes('--sse')) {
    const portIndex = argv.indexOf('--port');
    const port = portIndex >= 0 && argv[portIndex + 1] ? Number(argv[portIndex + 1]) : DEFAULT_SSE_PORT;
    const started = await runSse(server, { port });
    console.error(`[mcp] ShardX matrix MCP SSE 监听 ${started.url}（上游 ${server.serviceBase}）`);
    return;
  }
  runStdio(server);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[mcp] 启动失败：${error && error.stack ? error.stack : error}`);
    process.exit(1);
  });
}

module.exports = {
  createMcpServer,
  runStdio,
  runSse,
  toolList,
  TOOLS,
  SERVER_NAME,
  SERVER_VERSION,
  PROTOCOL_VERSION,
  DEFAULT_SERVICE_BASE,
  DEFAULT_SSE_PORT,
  main,
};
