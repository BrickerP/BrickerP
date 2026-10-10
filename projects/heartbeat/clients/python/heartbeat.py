"""Zero-dependency Python client for heartbeat (dead-man's switch + p95 gate).

Only the standard library is used (urllib), so this file can be copied next
to a cron job or bot without a virtualenv.

    from heartbeat import beat, timed, span, Heartbeat

    beat(URL, TOKEN, duration_ms=2400)                 # one-off report

    @timed(URL, TOKEN)                                  # measure + report a function
    def scan_batch(): ...

    with span(URL, TOKEN) as s:                         # measure + report a block
        s.meta["rows"] = 123
        ...

    hb = Heartbeat(URL, TOKEN)                          # bound helper
    hb.beat(duration_ms=12)

Guarantees:
- Network problems (DNS, refused, timeout, 5xx, 401...) are logged through the
  ``heartbeat`` logger and swallowed; ``beat()`` returns ``None``. The host job
  never crashes because the monitor is unreachable.
- An exception raised inside ``span``/``timed`` is reported as ``status="fail"``
  (with the exception type and message in ``meta.error``) and then re-raised.
- ``URL`` may be the monitor URL (``.../v1/monitors/<id>``) or the beat URL;
  ``/beat`` is appended when missing. ``url``/``token`` fall back to the
  ``HEARTBEAT_URL`` / ``HEARTBEAT_TOKEN`` environment variables.

Command line:

    python heartbeat.py URL TOKEN [--duration-ms N] [--status ok|fail] [--meta JSON]
    python heartbeat.py URL TOKEN -- <command> [args...]    # time a command
"""

from __future__ import annotations

import asyncio
import functools
import inspect
import json
import logging
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Awaitable, Callable, Dict, Mapping, Optional, TypeVar

__all__ = ["beat", "timed", "span", "Span", "Heartbeat", "DEFAULT_TIMEOUT", "beat_url"]
__version__ = "0.1.0"

log = logging.getLogger("heartbeat")

DEFAULT_TIMEOUT = 5.0
USER_AGENT = f"heartbeat-python/{__version__}"
_VALID_STATUS = ("ok", "fail")
_MAX_ERROR_CHARS = 500

F = TypeVar("F", bound=Callable[..., Any])


def beat_url(url: str) -> str:
    """Normalise a monitor or beat URL to the ``/beat`` endpoint."""
    url = url.strip().rstrip("/")
    return url if url.endswith("/beat") else f"{url}/beat"


def _resolve(url: Optional[str], token: Optional[str]) -> Optional[tuple]:
    url = url or os.environ.get("HEARTBEAT_URL")
    token = token or os.environ.get("HEARTBEAT_TOKEN")
    if not url or not token:
        log.warning("heartbeat: no url/token configured (pass them or set HEARTBEAT_URL/HEARTBEAT_TOKEN); skipping beat")
        return None
    return url, token


def beat(
    url: Optional[str] = None,
    token: Optional[str] = None,
    duration_ms: Optional[float] = None,
    status: str = "ok",
    meta: Optional[Mapping[str, Any]] = None,
    *,
    timeout: float = DEFAULT_TIMEOUT,
) -> Optional[Dict[str, Any]]:
    """POST one beat. Returns the parsed JSON response, or ``None`` on any network/HTTP error.

    ``status`` must be ``"ok"`` or ``"fail"``; anything else is a programming
    error and raises ``ValueError`` (that is not a network failure).
    """
    if status not in _VALID_STATUS:
        raise ValueError(f"status must be one of {_VALID_STATUS}, got {status!r}")
    resolved = _resolve(url, token)
    if resolved is None:
        return None
    url, token = resolved

    payload: Dict[str, Any] = {"status": status}
    if duration_ms is not None:
        payload["durationMs"] = float(duration_ms)
    if meta:
        payload["meta"] = dict(meta)
    try:
        body = json.dumps(payload, default=str).encode("utf-8")
    except (TypeError, ValueError) as exc:
        log.warning("heartbeat: meta is not JSON-serialisable (%s); sending without meta", exc)
        payload.pop("meta", None)
        body = json.dumps(payload).encode("utf-8")

    request = urllib.request.Request(
        beat_url(url),
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read(300).decode("utf-8", "replace")
        except Exception:  # pragma: no cover - best effort only
            pass
        log.warning("heartbeat: %s returned HTTP %s %s", request.full_url, exc.code, detail.strip())
        return None
    except (urllib.error.URLError, socket.timeout, TimeoutError, OSError, ValueError) as exc:
        log.warning("heartbeat: could not reach %s: %s", request.full_url, exc)
        return None
    except Exception:  # noqa: BLE001 - the host job must never die because of monitoring
        log.exception("heartbeat: unexpected error while reporting to %s", request.full_url)
        return None

    if not raw:
        return {}
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {"result": parsed}


class Span:
    """Measures a block of code and reports it on exit.

    Attributes available inside the block: ``meta`` (dict, sent with the beat),
    ``status`` (``"ok"`` unless an exception escapes or ``fail()`` is called).
    After the block: ``duration_ms`` and ``result`` (the server response or ``None``).
    """

    def __init__(
        self,
        url: Optional[str] = None,
        token: Optional[str] = None,
        *,
        meta: Optional[Mapping[str, Any]] = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self.url = url
        self.token = token
        self.timeout = timeout
        self.meta: Dict[str, Any] = dict(meta or {})
        self.status = "ok"
        self.started: Optional[float] = None
        self.duration_ms: Optional[float] = None
        self.result: Optional[Dict[str, Any]] = None

    def fail(self, reason: Any = None) -> None:
        """Mark the span as failed without raising."""
        self.status = "fail"
        if reason is not None:
            self.meta.setdefault("error", str(reason)[:_MAX_ERROR_CHARS])

    def start(self) -> "Span":
        self.started = time.perf_counter()
        return self

    def stop(self) -> float:
        started = self.started if self.started is not None else time.perf_counter()
        self.duration_ms = round((time.perf_counter() - started) * 1000.0, 3)
        return self.duration_ms

    def record_exception(self, exc: BaseException) -> None:
        self.status = "fail"
        self.meta.setdefault("error", f"{type(exc).__name__}: {exc}"[:_MAX_ERROR_CHARS])

    def report(self) -> Optional[Dict[str, Any]]:
        if self.duration_ms is None:
            self.stop()
        self.result = beat(
            self.url,
            self.token,
            duration_ms=self.duration_ms,
            status=self.status,
            meta=self.meta or None,
            timeout=self.timeout,
        )
        return self.result

    def __enter__(self) -> "Span":
        return self.start()

    def __exit__(self, exc_type, exc, tb) -> bool:
        self.stop()
        if exc is not None:
            self.record_exception(exc)
        self.report()
        return False  # never swallow the block's exception


def span(
    url: Optional[str] = None,
    token: Optional[str] = None,
    *,
    meta: Optional[Mapping[str, Any]] = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> Span:
    """``with span(url, token) as s:`` measures the block and reports it."""
    return Span(url, token, meta=meta, timeout=timeout)


def timed(
    url: Optional[str] = None,
    token: Optional[str] = None,
    *,
    meta: Optional[Mapping[str, Any]] = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> Callable[[F], F]:
    """Decorator: time each call and report it. Works for sync and ``async def`` functions.

    For coroutines the HTTP call runs in a worker thread so the event loop is
    not blocked while the beat is sent.
    """

    def decorate(fn: F) -> F:
        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                s = Span(url, token, meta=meta, timeout=timeout).start()
                try:
                    return await fn(*args, **kwargs)
                except BaseException as exc:
                    s.record_exception(exc)
                    raise
                finally:
                    s.stop()
                    loop = asyncio.get_running_loop()
                    await asyncio.shield(loop.run_in_executor(None, s.report))

            return async_wrapper  # type: ignore[return-value]

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            with Span(url, token, meta=meta, timeout=timeout):
                return fn(*args, **kwargs)

        return wrapper  # type: ignore[return-value]

    return decorate


class Heartbeat:
    """A monitor URL and token bound together: ``hb.beat()``, ``hb.span()``, ``@hb.timed()``."""

    def __init__(self, url: Optional[str] = None, token: Optional[str] = None, *, timeout: float = DEFAULT_TIMEOUT) -> None:
        self.url = url
        self.token = token
        self.timeout = timeout

    def beat(
        self,
        duration_ms: Optional[float] = None,
        status: str = "ok",
        meta: Optional[Mapping[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        return beat(self.url, self.token, duration_ms=duration_ms, status=status, meta=meta, timeout=self.timeout)

    def span(self, *, meta: Optional[Mapping[str, Any]] = None) -> Span:
        return Span(self.url, self.token, meta=meta, timeout=self.timeout)

    def timed(self, *, meta: Optional[Mapping[str, Any]] = None) -> Callable[[F], F]:
        return timed(self.url, self.token, meta=meta, timeout=self.timeout)


def _main(argv: list) -> int:
    import argparse

    # Everything after a literal "--" is the command to time; argparse never sees it.
    command: list = []
    if "--" in argv:
        split = argv.index("--")
        argv, command = argv[:split], argv[split + 1 :]

    parser = argparse.ArgumentParser(
        prog="heartbeat.py",
        description="Send a beat, or time a command and report it.",
        epilog="Append '-- <command> [args...]' to time a command and report its exit code.",
    )
    parser.add_argument("url", help="monitor URL (https://host/v1/monitors/<id>) or beat URL")
    parser.add_argument("token", help="beat token")
    parser.add_argument("--duration-ms", type=float, default=None)
    parser.add_argument("--status", choices=_VALID_STATUS, default="ok")
    parser.add_argument("--meta", default=None, help="JSON object to attach")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    args = parser.parse_args(argv)

    meta: Dict[str, Any] = {}
    if args.meta:
        try:
            parsed = json.loads(args.meta)
        except ValueError as exc:
            parser.error(f"--meta is not valid JSON: {exc}")
        if not isinstance(parsed, dict):
            parser.error("--meta must be a JSON object")
        meta.update(parsed)

    if command:
        with Span(args.url, args.token, meta={**meta, "command": command[0]}, timeout=args.timeout) as s:
            code = subprocess.call(command)
            s.meta["exitCode"] = code
            if code != 0:
                s.fail(f"exit code {code}")
        return code

    result = beat(args.url, args.token, args.duration_ms, args.status, meta or None, timeout=args.timeout)
    if result is None:
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":  # pragma: no cover
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    sys.exit(_main(sys.argv[1:]))
