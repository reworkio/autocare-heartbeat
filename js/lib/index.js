'use strict';
/**
 * AutoCare heartbeat client.
 *
 * An automation tells AutoCare how each run went by posting to its monitor's
 * heartbeat address. That address holds the monitor's secret, so it is
 * treated as a credential here: it is never logged and never put in an error.
 *
 * A heartbeat must not break the automation it reports on. beat() does not
 * throw for a network or server failure; it returns { ok: false, error }.
 */

const ENV_URL = 'AUTOCARE_HEARTBEAT_URL';
const DEFAULTS = { timeoutMs: 10000, retries: 2, retryDelayMs: 500 };
const MAX_ERROR = 500;

/** The address without its secret, for messages. */
function redact(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/');
    if (parts.length > 1 && parts[parts.length - 1]) parts[parts.length - 1] = '***';
    return `${u.origin}${parts.join('/')}`;
  } catch {
    return '(not a web address)';
  }
}

function resolveUrl(url) {
  const value = url || process.env[ENV_URL];
  if (!value) throw new TypeError(`No heartbeat address: pass one, or set ${ENV_URL}.`);
  let u;
  try { u = new URL(value); } catch { throw new TypeError('The heartbeat address is not a web address.'); }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new TypeError('The heartbeat address must be https: it carries the monitor\'s secret.');
  }
  return value;
}

/** What is posted. Only what was given is sent. */
function payload(run = {}) {
  const failed = run.status === 'failure' || (run.status === undefined && run.error !== undefined && run.error !== null);
  const body = { status: failed ? 'failure' : 'success' };
  if (typeof run.latencyMs === 'number' && Number.isFinite(run.latencyMs) && run.latencyMs >= 0) body.latency_ms = Math.round(run.latencyMs);
  if (failed && run.error !== undefined && run.error !== null) {
    const message = run.error instanceof Error ? run.error.message : String(run.error);
    body.error_message = message.slice(0, MAX_ERROR);
  }
  return body;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Report one run.
 *
 *   beat(url)                              the run succeeded
 *   beat(url, { latencyMs: 840 })          and took this long
 *   beat(url, { error: err })              the run failed
 *
 * `url` may be left out when AUTOCARE_HEARTBEAT_URL is set. Options:
 * timeoutMs, retries, retryDelayMs, fetch (for tests).
 *
 * Resolves to { ok: true, health } or { ok: false, status?, error }. It
 * retries a network failure and a 5xx, never a 4xx: a wrong address or a
 * monitor that is not active will not come right by asking again.
 */
async function beat(url, run = {}, options = {}) {
  if (url !== null && typeof url === 'object') return beat(undefined, url, run);
  const target = resolveUrl(url);
  const opts = { ...DEFAULTS, ...options };
  const send = opts.fetch || globalThis.fetch;
  if (typeof send !== 'function') throw new TypeError('This runtime has no fetch. Use Node 18 or later, or pass options.fetch.');
  const body = JSON.stringify(payload(run));
  let last = { ok: false, error: 'not sent' };
  for (let attempt = 0; attempt <= opts.retries; attempt += 1) {
    if (attempt > 0) await sleep(opts.retryDelayMs * 2 ** (attempt - 1));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await send(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        return { ok: true, health: typeof data.health === 'string' ? data.health : undefined };
      }
      last = {
        ok: false, status: res.status,
        error: res.status === 404 ? 'AutoCare does not know this heartbeat address. Copy it again from the monitor.'
          : res.status === 400 ? 'This monitor is not active, so the heartbeat was not counted.'
            : `AutoCare answered ${res.status}.`,
      };
      if (res.status < 500) return last;
    } catch (err) {
      last = { ok: false, error: err && err.name === 'AbortError' ? `No answer within ${opts.timeoutMs} ms.` : `Could not reach ${redact(target)}.` };
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

/**
 * Run `fn`, time it, and report how it went. The result or the error of
 * `fn` passes through unchanged; a heartbeat that could not be sent never
 * replaces either.
 */
async function monitored(url, fn, options = {}) {
  if (typeof url === 'function') return monitored(undefined, url, fn || {});
  const target = resolveUrl(url);
  const started = Date.now();
  try {
    const result = await fn();
    await beat(target, { latencyMs: Date.now() - started }, options);
    return result;
  } catch (err) {
    await beat(target, { latencyMs: Date.now() - started, error: err }, options);
    throw err;
  }
}

module.exports = { beat, monitored, payload, redact, ENV_URL };
