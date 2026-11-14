"""AutoCare heartbeat client.

An automation tells AutoCare how each run went by posting to its monitor's
heartbeat address. That address holds the monitor's secret, so it is treated
as a credential here: it is never logged and never put in an error.

A heartbeat must not break the automation it reports on. ``beat`` does not
raise for a network or server failure; it returns a ``Result`` whose ``ok``
is False.

Standard library only.
"""
from __future__ import annotations

import functools
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Optional

__all__ = ["beat", "monitored", "payload", "redact", "Result", "ENV_URL"]
__version__ = "0.1.0"

ENV_URL = "AUTOCARE_HEARTBEAT_URL"
MAX_ERROR = 500


@dataclass(frozen=True)
class Result:
    ok: bool
    health: Optional[str] = None
    status: Optional[int] = None
    error: Optional[str] = None


def redact(url: str) -> str:
    """The address without its secret, for messages."""
    try:
        u = urllib.parse.urlsplit(url)
        if not u.scheme or not u.netloc:
            return "(not a web address)"
        parts = u.path.split("/")
        if len(parts) > 1 and parts[-1]:
            parts[-1] = "***"
        return f"{u.scheme}://{u.netloc}{'/'.join(parts)}"
    except ValueError:
        return "(not a web address)"


def _resolve(url: Optional[str]) -> str:
    value = url or os.environ.get(ENV_URL)
    if not value:
        raise ValueError(f"No heartbeat address: pass one, or set {ENV_URL}.")
    u = urllib.parse.urlsplit(value)
    if not u.scheme or not u.hostname:
        raise ValueError("The heartbeat address is not a web address.")
    local = u.hostname in ("localhost", "127.0.0.1")
    if u.scheme != "https" and not (u.scheme == "http" and local):
        raise ValueError("The heartbeat address must be https: it carries the monitor's secret.")
    return value


def payload(*, status: Optional[str] = None, latency_ms: Optional[float] = None, error: Any = None) -> dict:
    """What is posted. Only what was given is sent."""
    failed = status == "failure" or (status is None and error is not None)
    body: dict = {"status": "failure" if failed else "success"}
    if isinstance(latency_ms, (int, float)) and not isinstance(latency_ms, bool) and latency_ms >= 0:
        body["latency_ms"] = round(latency_ms)
    if failed and error is not None:
        body["error_message"] = str(error)[:MAX_ERROR]
    return body


def beat(url: Optional[str] = None, *, status: Optional[str] = None, latency_ms: Optional[float] = None,
         error: Any = None, timeout: float = 10.0, retries: int = 2, retry_delay: float = 0.5) -> Result:
    """Report one run.

        beat(url)                      the run succeeded
        beat(url, latency_ms=840)      and took this long
        beat(url, error=exc)           the run failed

    ``url`` may be left out when AUTOCARE_HEARTBEAT_URL is set. A network
    failure and a 5xx are retried; a 4xx is not, because a wrong address or a
    monitor that is not active will not come right by asking again.
    """
    target = _resolve(url)
    data = json.dumps(payload(status=status, latency_ms=latency_ms, error=error)).encode("utf-8")
    last = Result(ok=False, error="not sent")
    for attempt in range(retries + 1):
        if attempt:
            time.sleep(retry_delay * 2 ** (attempt - 1))
        request = urllib.request.Request(target, data=data, method="POST", headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - scheme checked in _resolve
                try:
                    health = json.loads(response.read().decode("utf-8") or "{}").get("health")
                except (ValueError, AttributeError):
                    health = None
                return Result(ok=True, health=health if isinstance(health, str) else None)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                message = "AutoCare does not know this heartbeat address. Copy it again from the monitor."
            elif e.code == 400:
                message = "This monitor is not active, so the heartbeat was not counted."
            else:
                message = f"AutoCare answered {e.code}."
            last = Result(ok=False, status=e.code, error=message)
            if e.code < 500:
                return last
        except TimeoutError:
            last = Result(ok=False, error=f"No answer within {timeout:g} seconds.")
        except (urllib.error.URLError, OSError) as e:
            timed_out = isinstance(getattr(e, "reason", None), TimeoutError)
            last = Result(ok=False, error=f"No answer within {timeout:g} seconds." if timed_out else f"Could not reach {redact(target)}.")
    return last


def monitored(url: Optional[str] = None, **options: Any) -> Callable:
    """Decorate a function: time it and report how it went.

        @monitored()
        def sync_invoices(): ...

    The function's result or exception passes through unchanged; a heartbeat
    that could not be sent never replaces either.
    """
    def decorate(fn: Callable) -> Callable:
        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            target = _resolve(url)
            started = time.monotonic()
            try:
                result = fn(*args, **kwargs)
            except BaseException as exc:
                if isinstance(exc, Exception):
                    beat(target, latency_ms=(time.monotonic() - started) * 1000, error=exc, **options)
                raise
            beat(target, latency_ms=(time.monotonic() - started) * 1000, **options)
            return result
        return wrapper
    return decorate
