'use strict';

/*
 * Minimal JSON HTTP client built on the `node:http` / `node:https` modules.
 * Never uses global fetch, so it works inside any host process and can be
 * pointed at loopback services without proxy interference.
 */

const http = require('node:http');
const https = require('node:https');

const DEFAULT_TIMEOUT_MS = 8000;

class HttpError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'HttpError';
    if (options.code) this.code = options.code;
    if (options.status) this.status = options.status;
    if (options.body !== undefined) this.body = options.body;
    if (options.cause) this.cause = options.cause;
    if (options.url) this.url = options.url;
  }
}

function requestJson(rawUrl, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(options.timeoutMs);
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(rawUrl);
    } catch (cause) {
      reject(new HttpError(`无效的 URL：${rawUrl}`, { code: 'invalid_url', cause, url: rawUrl }));
      return;
    }
    const secure = url.protocol === 'https:';
    const transport = secure ? https : http;
    const headers = Object.assign({ Accept: 'application/json' }, options.headers || {});
    let body = null;
    if (options.body !== undefined && options.body !== null) {
      body = Buffer.isBuffer(options.body) ? options.body : Buffer.from(
        typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
        'utf8',
      );
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
    }
    if (body) headers['Content-Length'] = String(body.length);

    const request = transport.request({
      protocol: secure ? 'https:' : 'http:',
      hostname: url.hostname,
      port: url.port || (secure ? 443 : 80),
      path: `${url.pathname || '/'}${url.search || ''}`,
      method,
      headers,
      servername: secure ? url.hostname : undefined,
      rejectUnauthorized: options.rejectUnauthorized !== false,
    });

    let settled = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(new HttpError(`请求超时（${timeoutMs}ms）：${rawUrl}`, {
        code: 'timeout',
        url: rawUrl,
      }));
    }, timeoutMs) : null;

    function finish() {
      if (timer) clearTimeout(timer);
    }

    request.on('error', (cause) => {
      if (settled) return;
      settled = true;
      finish();
      reject(new HttpError(`请求失败：${rawUrl}（${cause.code || cause.message}）`, {
        code: cause.code || 'request_failed',
        cause,
        url: rawUrl,
      }));
    });

    request.on('response', (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 8 * 1024 * 1024) chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        finish();
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        let parseError = null;
        if (text) {
          try { parsed = JSON.parse(text); } catch (cause) { parseError = cause; }
        }
        const status = Number(response.statusCode) || 0;
        if (options.allowNon2xx === true || (status >= 200 && status < 300)) {
          resolve({ status, headers: response.headers, body: parsed, text, parseError });
          return;
        }
        const remoteMessage = parsed && parsed.error && parsed.error.message
          ? parsed.error.message
          : (parsed && parsed.message) || text.slice(0, 300) || `HTTP ${status}`;
        const code = parsed && parsed.error && parsed.error.code
          ? parsed.error.code
          : `http_${status}`;
        reject(new HttpError(`${method} ${url.pathname} -> ${status}: ${remoteMessage}`, {
          status,
          code,
          body: parsed === null ? text : parsed,
          url: rawUrl,
        }));
      });
    });

    if (body) request.write(body);
    request.end();
  });
}

async function probe(url, options = {}) {
  const started = Date.now();
  try {
    const response = await requestJson(url, Object.assign({ timeoutMs: 3000 }, options));
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      latencyMs: Date.now() - started,
      url,
      body: response.body,
    };
  } catch (error) {
    return {
      ok: false,
      status: error.status || 0,
      latencyMs: Date.now() - started,
      url,
      error: error.message,
      code: error.code || 'unreachable',
    };
  }
}

module.exports = { requestJson, probe, HttpError, DEFAULT_TIMEOUT_MS };
