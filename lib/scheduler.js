'use strict';

/*
 * Human-pace scheduling for browser automation.
 *
 * Every pointer/keyboard action the matrix performs waits for a Poisson-ish
 * delay inside `[poissonMinMs, poissonMaxMs]` (400-1800 ms by default), with
 * an optional stable per-slot phase offset so 250 slots never act on the same
 * millisecond. Typing is paced per character.
 *
 * The batch scheduler is the generic one used by the sibling extensions: one
 * in-flight key at a time, bounded concurrency, deterministic phase spread.
 */

const DEFAULT_MIN_MS = 400;
const DEFAULT_MAX_MS = 1800;
const DEFAULT_TYPE_MIN_MS = 45;
const DEFAULT_TYPE_MAX_MS = 130;

function hash32(text) {
  let hash = 2166136261;
  const value = String(text);
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function phaseOffset(key, baseMs) {
  const base = Math.max(1, Number(baseMs) || 1);
  return hash32(key) % base;
}

function poissonDelay(meanMs, random = Math.random) {
  const mean = Math.max(1, Number(meanMs) || 1);
  let u = Number(random());
  if (!(u > 0) || u >= 1) u = 0.5;
  return Math.max(0, Math.round(-Math.log(1 - u) * mean));
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function nextDelay(key, baseMs, options = {}) {
  const base = Math.max(1, Number(baseMs) || 1);
  const random = options.random || Math.random;
  const min = options.jitterMin === undefined ? -0.25 : Number(options.jitterMin);
  const max = options.jitterMax === undefined ? 0.35 : Number(options.jitterMax);
  const jitter = min + random() * (max - min);
  const delay = base * (1 + jitter) + phaseOffset(key, base);
  return Math.max(0, Math.round(delay));
}

/**
 * Randomised human delay for one browser action.
 * Uses an exponential draw around the midpoint, clipped to the range, plus a
 * small stable phase based on the slot id so cards do not fire in lockstep.
 */
function actionDelay(key, options = {}) {
  const minMs = Math.max(0, Number(options.minMs === undefined ? DEFAULT_MIN_MS : options.minMs) || 0);
  const maxMs = Math.max(minMs, Number(options.maxMs === undefined ? DEFAULT_MAX_MS : options.maxMs) || minMs);
  const random = options.random || Math.random;
  const mean = (minMs + maxMs) / 2;
  let value = poissonDelay(mean, random);
  const jitter = Number(options.phaseJitterMs === undefined ? 0 : options.phaseJitterMs);
  if (key && jitter > 0) value += phaseOffset(key, jitter);
  return Math.round(clamp(value, minMs, maxMs));
}

function typeDelay(options = {}) {
  const minMs = Math.max(0, Number(options.typeMinMs === undefined ? DEFAULT_TYPE_MIN_MS : options.typeMinMs) || 0);
  const maxMs = Math.max(minMs, Number(options.typeMaxMs === undefined ? DEFAULT_TYPE_MAX_MS : options.typeMaxMs) || minMs);
  const random = options.random || Math.random;
  return Math.round(minMs + random() * (maxMs - minMs));
}

function sleep(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (!value) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, value);
    if (timer.unref) timer.unref();
  });
}

function isAbortError(error) {
  return Boolean(error && (error.code === 'ABORT_ERR' || error.name === 'AbortError'));
}

/**
 * Sequential step runner with per-step action delay, freeze barrier and
 * cancellation. `onStep` receives (step, index) and owns the actual work.
 */
function createStepRunner(options = {}) {
  const random = options.random || Math.random;
  const minMs = options.minMs === undefined ? DEFAULT_MIN_MS : Number(options.minMs);
  const maxMs = options.maxMs === undefined ? DEFAULT_MAX_MS : Number(options.maxMs);
  const barrier = typeof options.barrier === 'function' ? options.barrier : null;
  const onStep = typeof options.onStep === 'function' ? options.onStep : null;
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};

  async function run(key, steps, context = {}) {
    const list = Array.isArray(steps) ? steps : [];
    const results = [];
    for (let index = 0; index < list.length; index += 1) {
      if (context.signal && context.signal.aborted) {
        const error = new Error('任务已取消');
        error.code = 'ABORT_ERR';
        throw error;
      }
      if (barrier) await barrier(index);
      const delayMs = actionDelay(key, { minMs, maxMs, random });
      await sleep(delayMs);
      const step = list[index];
      onLog(`第 ${index + 1}/${list.length} 步：${describeStep(step)}`, { stepIndex: index, delayMs });
      try {
        const value = onStep ? await onStep(step, index, context) : { skipped: true };
        results.push({ index, step: describeStep(step), ok: true, value, delayMs });
      } catch (error) {
        if (isAbortError(error)) throw error;
        results.push({
          index,
          step: describeStep(step),
          ok: false,
          error: error && error.message ? error.message : String(error),
          delayMs,
        });
        if (step && (step.continueOnError === true)) continue;
        const wrapped = new Error(
          `第 ${index + 1} 步失败（${describeStep(step)}）：${error && error.message ? error.message : String(error)}`,
        );
        wrapped.code = 'step_failed';
        wrapped.stepIndex = index;
        wrapped.results = results;
        throw wrapped;
      }
    }
    return results;
  }

  return { run, actionDelay: (key) => actionDelay(key, { minMs, maxMs, random }) };
}

function describeStep(step) {
  if (!step || typeof step !== 'object') return '空步骤';
  const action = String(step.action || 'unknown');
  switch (action) {
    case 'goto':
      return `打开 ${step.url || ''}`;
    case 'click':
      return `点击 ${step.ref || step.selector || step.text || ''}`;
    case 'fill':
      return `在 ${step.ref || step.selector || ''} 输入 ${step.text === undefined ? '' : String(step.text).slice(0, 40)}`;
    case 'press':
      return `按键 ${step.key || 'Enter'}`;
    case 'scroll':
      return `滚动 ${step.deltaY === undefined ? step.y || 600 : step.deltaY}`;
    case 'wait':
      return `等待 ${step.ms || step.timeoutMs || 0}ms${step.selector ? ` 直到 ${step.selector}` : ''}`;
    case 'extract':
      return `提取 ${step.ref || step.selector || 'visibleText'}`;
    case 'assertText':
      return `断言文本包含 ${String(step.expect || step.text || '').slice(0, 40)}`;
    case 'screenshot':
      return '截图';
    case 'evaluate':
      return '执行页面脚本';
    default:
      return action;
  }
}

function createScheduler(options = {}) {
  const baseMs = Number(options.baseMs) || 60000;
  const concurrency = Math.max(1, Number(options.concurrency) || 4);
  const random = options.random || Math.random;
  const runTask = options.run;

  async function runBatch(entries) {
    const queue = (entries || []).filter((entry) => entry && entry.enabled !== false);
    const inFlight = new Set();
    const results = [];
    let index = 0;

    async function worker() {
      for (;;) {
        const current = index;
        index += 1;
        if (current >= queue.length) return;
        const entry = queue[current];
        const key = String(entry.key);
        if (inFlight.has(key)) {
          results.push({ key, skipped: true, reason: 'in-flight' });
          continue;
        }
        inFlight.add(key);
        try {
          const task = entry.run || runTask;
          if (typeof task !== 'function') throw new Error(`no task for ${key}`);
          const value = await task(entry);
          results.push({ key, ok: true, value });
        } catch (error) {
          results.push({ key, ok: false, error: error && error.message ? error.message : String(error) });
        } finally {
          inFlight.delete(key);
        }
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }

  function plan(keys) {
    return (keys || []).map((key) => ({
      key: String(key),
      delayMs: nextDelay(key, baseMs, { random }),
      phaseMs: phaseOffset(key, baseMs),
    }));
  }

  return { baseMs, concurrency, runBatch, plan };
}

module.exports = {
  createScheduler,
  createStepRunner,
  nextDelay,
  phaseOffset,
  hash32,
  poissonDelay,
  actionDelay,
  typeDelay,
  sleep,
  describeStep,
  DEFAULT_MIN_MS,
  DEFAULT_MAX_MS,
  DEFAULT_TYPE_MIN_MS,
  DEFAULT_TYPE_MAX_MS,
};
