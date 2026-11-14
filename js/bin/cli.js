#!/usr/bin/env node
'use strict';
const { beat, ENV_URL } = require('../lib');

const HELP = `autocare-heartbeat: tell AutoCare how a run went

Usage
  autocare-heartbeat [--url <address>] [--latency <ms>]            the run succeeded
  autocare-heartbeat [--url <address>] --fail "what went wrong"     the run failed

The address comes from --url or from ${ENV_URL}. It holds your monitor's
secret, so prefer the environment variable: a command line can be read by
other users of the machine.

Exit status: 0 sent, 1 not sent, 2 bad usage.
`;

async function main(argv) {
  const run = {};
  let url;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => { if (i + 1 >= argv.length) usage(`${a} needs a value`); i += 1; return argv[i]; };
    if (a === '--help' || a === '-h') { process.stdout.write(HELP); return 0; }
    else if (a === '--url') url = value();
    else if (a === '--fail') { run.status = 'failure'; run.error = value(); }
    else if (a === '--latency') {
      const n = Number(value());
      if (!Number.isFinite(n) || n < 0) usage('--latency is a number of milliseconds');
      run.latencyMs = n;
    } else usage(`unknown option ${a}`);
  }
  let result;
  try { result = await beat(url, run); } catch (err) { usage(err.message); }
  if (result.ok) { process.stdout.write(`sent${result.health ? `, monitor is ${result.health}` : ''}\n`); return 0; }
  process.stderr.write(`autocare-heartbeat: ${result.error}\n`);
  return 1;
}

function usage(message) {
  process.stderr.write(`autocare-heartbeat: ${message}\n`);
  process.exit(2);
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
