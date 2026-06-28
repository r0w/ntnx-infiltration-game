"""Unit tests for setup_production_project.py's transient-retry hardening
(issue #28: a ReadTimeout on a v3 call failed the whole `Setup production
project` install task).

Two things are covered:

  1. `_retry` — the idempotent-call wrapper: returns on success, retries on a
     transport exception and on 5xx, and gives up (raises) after N attempts.

  2. `create_project` recovery — the create POST is a non-idempotent mutation,
     so it can't use `_retry`. Instead it must, on a transport blip or a
     duplicate-name rejection, discover that the project was actually created
     server-side and adopt it rather than failing the deploy.

Like test_remove_node_retry.py we exec the *source* with module-level imports
removed and fakes injected, so only the pure logic runs (no network, no sleep).
"""
from pathlib import Path

SCRIPT = Path(__file__).parent.parent / "scripts" / "setup_production_project.py"


class FakeRequestException(Exception):
    """Stand-in for requests.RequestException (ReadTimeout / ConnectionError)."""


class FakeResp:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.text = text

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise FakeRequestException("HTTP %d" % self.status_code)


class FakeRequests:
    """Programmable fake. Each verb pops the next item from its queue; an item
    that is an Exception instance is raised, anything else is returned."""

    RequestException = FakeRequestException

    def __init__(self, get=None, post=None, put=None, delete=None):
        self._q = {"get": list(get or []), "post": list(post or []),
                   "put": list(put or []), "delete": list(delete or [])}
        self.calls = {"get": 0, "post": 0, "put": 0, "delete": 0}

    def _next(self, verb, *a, **k):
        self.calls[verb] += 1
        item = self._q[verb].pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    def get(self, *a, **k):
        return self._next("get", *a, **k)

    def post(self, *a, **k):
        return self._next("post", *a, **k)

    def put(self, *a, **k):
        return self._next("put", *a, **k)

    def delete(self, *a, **k):
        return self._next("delete", *a, **k)


class FakeTime:
    """No-op sleep so retry backoff doesn't make tests slow."""
    def sleep(self, _n):
        pass

    def time(self):
        return 0


def _load(fake_requests):
    src = SCRIPT.read_text()
    drop = ("import requests", "import urllib3", "import time", "import sys",
            "sys.exit(main())")
    body = "\n".join(
        l for l in src.splitlines()
        if l.strip() not in drop and not l.strip().startswith("urllib3.disable_warnings")
    )
    ns = {"requests": fake_requests, "time": FakeTime()}
    exec(compile(body, str(SCRIPT), "exec"), ns)
    return ns


# ── _retry ────────────────────────────────────────────────────────────────

def test_retry_returns_on_first_success():
    fake = FakeRequests(get=[FakeResp(200, {"ok": True})])
    ns = _load(fake)
    r = ns["_retry"](fake.get, "url")
    assert r.status_code == 200
    assert fake.calls["get"] == 1


def test_retry_recovers_from_transport_blip():
    fake = FakeRequests(get=[FakeRequestException("read timed out"),
                             FakeResp(200, {"ok": True})])
    ns = _load(fake)
    r = ns["_retry"](fake.get, "url")
    assert r.status_code == 200
    assert fake.calls["get"] == 2


def test_retry_recovers_from_5xx():
    fake = FakeRequests(post=[FakeResp(503, text="busy"),
                              FakeResp(200, {"ok": True})])
    ns = _load(fake)
    r = ns["_retry"](fake.post, "url")
    assert r.status_code == 200
    assert fake.calls["post"] == 2


def test_retry_passes_4xx_straight_through():
    # 4xx is a real client answer, not a transient blip — return it, no retry.
    fake = FakeRequests(get=[FakeResp(404, text="nope")])
    ns = _load(fake)
    r = ns["_retry"](fake.get, "url")
    assert r.status_code == 404
    assert fake.calls["get"] == 1


def test_retry_gives_up_after_attempts():
    fake = FakeRequests(get=[FakeRequestException("boom")] * 5)
    ns = _load(fake)
    try:
        ns["_retry"](fake.get, "url", _attempts=5)
        assert False, "expected _retry to raise after exhausting attempts"
    except Exception as e:
        assert "after 5 attempts" in str(e)
    assert fake.calls["get"] == 5


# ── create_project recovery ─────────────────────────────────────────────────

_HEALTHY_LIST = FakeResp(200, {"entities": [
    {"metadata": {"uuid": "proj-9"}, "status": {"state": "COMPLETE"}}
]})


def test_create_project_happy_path():
    post = [FakeResp(202, {"status": {"execution_context": {"task_uuid": "t1"}}})]
    get = [FakeResp(200, {"status": "SUCCEEDED",
                          "entity_reference_list": [{"uuid": "proj-new"}]})]
    fake = FakeRequests(post=post, get=get)
    ns = _load(fake)
    assert ns["create_project"]("acc", "pri", "sec") == "proj-new"


def test_create_project_adopts_after_transport_blip():
    # POST to /projects times out; the project was created server-side, so
    # find_existing_project (its own POST to /projects/list) finds it.
    fake = FakeRequests(post=[FakeRequestException("read timed out"), _HEALTHY_LIST])
    ns = _load(fake)
    assert ns["create_project"]("acc", "pri", "sec") == "proj-9"
    assert fake.calls["post"] == 2


def test_create_project_adopts_on_duplicate_name():
    # Live shape on PC 7.5 (DM3-POC013): HTTP 400, reason DUPLICATE_ENTITY.
    dup = FakeResp(400, text='{"reason":"DUPLICATE_ENTITY","message":'
                            '"Project name production already exists."}')
    fake = FakeRequests(post=[dup, _HEALTHY_LIST])
    ns = _load(fake)
    assert ns["create_project"]("acc", "pri", "sec") == "proj-9"


def test_create_project_raises_on_genuine_failure():
    # A 400 that isn't a duplicate and isn't a subnet-lag 404 is fatal.
    fake = FakeRequests(post=[FakeResp(400, text="malformed body")])
    ns = _load(fake)
    try:
        ns["create_project"]("acc", "pri", "sec")
        assert False, "expected create_project to raise on a genuine 400"
    except Exception as e:
        assert "create project failed" in str(e)
