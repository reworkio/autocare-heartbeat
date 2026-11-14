'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { beat, monitored, payload, redact } = require('../lib');

/** A stand-in for AutoCare: answers from `script`, one entry per request. */
function server(script) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, type: req.headers['content-type'], body: raw ? JSON.parse(raw) : null });
      const step = script[Math.min(seen.length - 1, script.length - 1)];
      if (step === 'hang') return;
      res.writeHead(step.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(step.body || {}));
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({
      seen, url: `http://127.0.0.1:${srv.address().port}/api/v1/autocare/webhook/42/s3cret-value`,
      close: () => new Promise((done) => { srv.closeAllConnections(); srv.close(done); }),
    }));
  });
}
const OK = { status: 200, body: { status: 'ok', health: 'healthy' } };
const fast = { retryDelayMs: 1 };

test('a success is one POST of {status: success}, and the health comes back', async () => {
  const s = await server([OK]);
  assert.deepStrictEqual(await beat(s.url), { ok: true, health: 'healthy' });
  assert.deepStrictEqual(s.seen, [{ method: 'POST', url: '/api/v1/autocare/webhook/42/s3cret-value', type: 'application/json', body: { status: 'success' } }]);
  await s.close();
});

test('the payload carries only what was given, in the names AutoCare reads', () => {
  assert.deepStrictEqual(payload(), { status: 'success' });
  assert.deepStrictEqual(payload({ latencyMs: 840.6 }), { status: 'success', latency_ms: 841 });
  assert.deepStrictEqual(payload({ error: new Error('CRM said 401') }), { status: 'failure', error_message: 'CRM said 401' });
  assert.deepStrictEqual(payload({ status: 'failure' }), { status: 'failure' });
  assert.deepStrictEqual(payload({ status: 'success', error: 'ignored' }), { status: 'success' });
  assert.deepStrictEqual(payload({ latencyMs: -5 }), { status: 'success' });
  assert.strictEqual(payload({ error: 'x'.repeat(2000) }).error_message.length, 500);
});

test('a 5xx and a dropped connection are retried; a 4xx is not', async () => {
  const flaky = await server([{ status: 503 }, { status: 502 }, OK]);
  assert.deepStrictEqual(await beat(flaky.url, {}, fast), { ok: true, health: 'healthy' });
  assert.strictEqual(flaky.seen.length, 3);
  await flaky.close();

  const down = await server([{ status: 500 }]);
  const gaveUp = await beat(down.url, {}, fast);
  assert.deepStrictEqual([gaveUp.ok, gaveUp.status, down.seen.length], [false, 500, 3]);
  await down.close();

  for (const [status, words] of [[404, /does not know this heartbeat address/], [400, /not active/]]) {
    const s = await server([{ status }]);
    const r = await beat(s.url, {}, fast);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, words);
    assert.strictEqual(s.seen.length, 1, `a ${status} was retried`);
    await s.close();
  }
});

test('nothing listening, or no answer in time, is reported and never thrown', async () => {
  const s = await server([OK]);
  const dead = s.url;
  await s.close();
  const r = await beat(dead, {}, { retries: 1, retryDelayMs: 1 });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Could not reach/);

  const slow = await server(['hang']);
  const t = await beat(slow.url, {}, { retries: 0, timeoutMs: 50 });
  assert.deepStrictEqual(t, { ok: false, error: 'No answer within 50 ms.' });
  await slow.close();
});

test('the secret is never in a message', async () => {
  assert.strictEqual(redact('https://api.example.com/api/v1/autocare/webhook/42/s3cret-value'), 'https://api.example.com/api/v1/autocare/webhook/42/***');
  const s = await server([OK]);
  const dead = s.url;
  await s.close();
  const r = await beat(dead, {}, { retries: 0 });
  assert.ok(!r.error.includes('s3cret-value'), r.error);
});

test('an address that is missing, malformed or not https is refused before anything is sent', async () => {
  const saved = process.env.AUTOCARE_HEARTBEAT_URL;
  delete process.env.AUTOCARE_HEARTBEAT_URL;
  await assert.rejects(beat(), /No heartbeat address/);
  await assert.rejects(beat('not a url'), /not a web address/);
  await assert.rejects(beat('http://api.example.com/api/v1/autocare/webhook/1/abc'), /must be https/);
  const s = await server([OK]);
  process.env.AUTOCARE_HEARTBEAT_URL = s.url;
  assert.strictEqual((await beat()).ok, true);
  assert.strictEqual((await beat({ error: 'boom' })).ok, true);
  assert.deepStrictEqual(s.seen[1].body, { status: 'failure', error_message: 'boom' });
  await s.close();
  if (saved === undefined) delete process.env.AUTOCARE_HEARTBEAT_URL; else process.env.AUTOCARE_HEARTBEAT_URL = saved;
});

test('monitored: the result and the error pass through, and each is reported with its time', async () => {
  const s = await server([OK]);
  assert.strictEqual(await monitored(s.url, async () => 'done'), 'done');
  await assert.rejects(monitored(s.url, async () => { throw new Error('sheet not found'); }), /sheet not found/);
  assert.strictEqual(s.seen[0].body.status, 'success');
  assert.ok(Number.isInteger(s.seen[0].body.latency_ms));
  assert.deepStrictEqual([s.seen[1].body.status, s.seen[1].body.error_message], ['failure', 'sheet not found']);
  await s.close();
  // A heartbeat that cannot be sent does not replace the run's own result.
  assert.strictEqual(await monitored(s.url, async () => 7, { retries: 0 }), 7);
});

const cli = (args, env) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'cli.js'), ...args], { env: { ...process.env, ...env } });
  let out = ''; let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  child.on('close', (code) => resolve({ code, out, err }));
});

test('cli: success, failure, and bad usage', async () => {
  const s = await server([OK]);
  const ok = await cli(['--latency', '120'], { AUTOCARE_HEARTBEAT_URL: s.url });
  assert.deepStrictEqual([ok.code, ok.out], [0, 'sent, monitor is healthy\n']);
  const failed = await cli(['--url', s.url, '--fail', 'CRM said 401'], {});
  assert.strictEqual(failed.code, 0);
  assert.deepStrictEqual(s.seen.map((r) => r.body), [{ status: 'success', latency_ms: 120 }, { status: 'failure', error_message: 'CRM said 401' }]);
  await s.close();
  assert.strictEqual((await cli(['--nope'], {})).code, 2);
  assert.strictEqual((await cli([], { AUTOCARE_HEARTBEAT_URL: '' })).code, 2);
  const unsent = await cli(['--url', s.url], {});
  assert.strictEqual(unsent.code, 1);
  assert.ok(!unsent.err.includes('s3cret-value'));
});
