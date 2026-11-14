# autocare-heartbeat

Tell [AutoCare](https://reworkio.com/autocare) how each run of your automation went, in one call.

AutoCare monitors an automation after it is delivered. It knows the automation is alive because the automation reports each run to its monitor's **heartbeat address**. These clients send that report.

## What you get

- **One call per run:** success, or failure with the reason, and how long the run took.
- **A wrapper** that times your function and reports the outcome for you.
- **Safe by default:** a heartbeat that cannot be sent never breaks your automation. It retries a network failure or a server error, then gives up quietly and tells you why.
- **The secret stays secret:** the heartbeat address contains your monitor's secret, and it is never logged or put in an error message.
- **No dependencies:** JavaScript (Node 18 or later), Python (3.9 or later, standard library only), a command-line tool, and settings for n8n, Make and `curl`.

## Before you start

Copy the heartbeat address from your monitor in AutoCare and keep it where you keep other secrets. The simplest way is an environment variable, which every client here reads:

```bash
export AUTOCARE_HEARTBEAT_URL='<paste the heartbeat address from your monitor>'
```

Anyone who has the address can report runs for your monitor, so do not commit it or paste it into a shared workflow.

## JavaScript

The package lives in the [`js`](js) folder. From a clone:

```bash
git clone https://github.com/reworkio/autocare-heartbeat
npm install ./autocare-heartbeat/js
```

```js
const { beat, monitored } = require('@reworkio/autocare-heartbeat');

// Report a run yourself
await beat();                              // succeeded
await beat({ latencyMs: 840 });            // succeeded, and took this long
await beat({ error: err });                // failed

// Or let it time and report a function for you
const rows = await monitored(async () => syncInvoices());
```

`beat` resolves to `{ ok: true, health }` or `{ ok: false, error }`. It does not throw when AutoCare cannot be reached. `monitored` returns whatever your function returns and rethrows whatever it throws.

Pass the address as the first argument if you do not use the environment variable: `beat(url, { latencyMs: 840 })`.

## Python

The package lives in the [`python`](python) folder. From the same clone:

```bash
pip install ./autocare-heartbeat/python
```

```python
from autocare_heartbeat import beat, monitored

beat()                         # succeeded
beat(latency_ms=840)           # succeeded, and took this long
beat(error=exc)                # failed

@monitored()
def sync_invoices():
    ...
```

`beat` returns a `Result` with `ok`, `health` and `error`. It does not raise when AutoCare cannot be reached.

## Command line

For a shell script or a scheduled job:

```bash
node autocare-heartbeat/js/bin/cli.js --latency 840
node autocare-heartbeat/js/bin/cli.js --fail "CRM said 401"
```

Exit status is `0` when sent, `1` when not, `2` for bad usage.

## curl

No client needed:

```bash
curl -fsS -X POST "$AUTOCARE_HEARTBEAT_URL" \
  -H 'Content-Type: application/json' \
  -d '{"status":"success","latency_ms":840}'
```

## n8n

Add an **HTTP Request** node as the last step of the workflow:

| Setting | Value |
|---|---|
| Method | `POST` |
| URL | your heartbeat address, from a credential or an environment variable |
| Send Body | on, JSON |
| Body | `{ "status": "success" }` |

To report failures, create a second workflow that starts with an **Error Trigger** node and ends with the same HTTP Request node, with the body `{ "status": "failure", "error_message": "{{ $json.execution.error.message }}" }`. Set it as the Error Workflow in the first workflow's settings.

## Make

Add an **HTTP: Make a request** module as the last step of the scenario:

| Setting | Value |
|---|---|
| URL | your heartbeat address |
| Method | `POST` |
| Body type | Raw, JSON (application/json) |
| Request content | `{"status":"success"}` |

To report failures, add an error handler route with the same module and the content `{"status":"failure","error_message":"<the error message from the failed module>"}`.

## What is sent

One `POST` with a JSON body:

| Field | Type | Meaning |
|---|---|---|
| `status` | `"success"` or `"failure"` | How the run went. Anything other than `"success"` counts as a failure |
| `latency_ms` | number, optional | How long the run took |
| `error_message` | text, optional | Why it failed. The clients send at most 500 characters |

AutoCare answers `200` with `{"status":"ok","health":"…"}`. It answers `404` for an address it does not know and `400` when the monitor is not active; the clients do not retry either.

## What to know

- **Report every run.** AutoCare flags a monitor that has gone quiet, so a heartbeat only on failure looks like silence.
- **A monitor that has never reported is "not yet reporting",** not down. The first heartbeat makes it live.
- The n8n and Make settings above use each tool's standard HTTP module. They are not packaged as installable nodes and have not been tested inside n8n or Make; the request they describe is the same one the `curl` line sends.

## Licence

MIT
