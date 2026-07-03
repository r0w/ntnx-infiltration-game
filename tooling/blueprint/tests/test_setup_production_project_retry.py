"""Unit tests for setup_production_project.py's transient-retry hardening
(issue #28: a ReadTimeout on a v3 call failed the whole `Setup production
project` install task).

Retry itself is now urllib3's Retry adapter on a requests.Session (`_SESS`) —
proven to work, backoff included, in the Calm escript sandbox — so we don't
re-test the library. We test:

  1. `_make_session()` is configured the way WE intend (retries reads +
     transient 5xx, POST allowed because our v3 `/list` reads are POSTs).

  2. `create_project` recovery — the create POST is a non-idempotent mutation
     that stays on plain `requests`, so on a transport blip or duplicate-name
     rejection it must discover the project was actually created server-side and
     adopt it (and recreate cleanly if a prior ERROR-state dupe was deleted).

Like test_remove_node_retry.py we exec the source with imports removed and fakes
injected: `_SESS` (fake session for idempotent reads) + `requests` (fake for the
create mutation), so only the pure logic runs (no network, no sleep).
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


class _Queue:
    """A verb whose calls pop the next queued item; an Exception is raised,
    anything else is returned."""
    def __init__(self, items):
        self._q = list(items)
        self.calls = 0

    def __call__(self, *a, **k):
        self.calls += 1
        item = self._q.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


class FakeSession:
    """Fake `_SESS` — the retrying session used for idempotent reads."""
    def __init__(self, get=None, post=None, put=None, delete=None):
        self.get = _Queue(get or [])
        self.post = _Queue(post or [])
        self.put = _Queue(put or [])
        self.delete = _Queue(delete or [])


class FakeReq:
    """Fake `requests` — only the create mutation (plain requests.post) uses it."""
    RequestException = FakeRequestException

    def __init__(self, post=None):
        self.post = _Queue(post or [])


class FakeTime:
    def sleep(self, _n):
        pass

    def time(self):
        return 0


def _load(fake_sess, fake_req=None):
    src = SCRIPT.read_text()
    drop = ("import requests", "from requests.adapters import HTTPAdapter, Retry",
            "import urllib3", "import time", "import sys", "_SESS = _make_session()",
            "sys.exit(main())")
    body = "\n".join(
        l for l in src.splitlines()
        if l.strip() not in drop and not l.strip().startswith("urllib3.disable_warnings")
    )
    ns = {"requests": fake_req or FakeReq(), "time": FakeTime(), "_SESS": fake_sess}
    exec(compile(body, str(SCRIPT), "exec"), ns)
    return ns


# ── session config ──────────────────────────────────────────────────────────

def test_session_retry_config():
    # Build a REAL session (requests is installed in the test venv) and assert
    # OUR intended Retry config, without testing urllib3's internals.
    src = SCRIPT.read_text()
    body = "\n".join(l for l in src.splitlines() if l.strip() != "sys.exit(main())")
    ns = {}
    exec(compile(body, str(SCRIPT), "exec"), ns)
    retry = ns["_SESS"].get_adapter("https://x").max_retries
    assert {"GET", "POST"}.issubset(set(retry.allowed_methods))
    assert 503 in retry.status_forcelist and 500 in retry.status_forcelist
    assert retry.total >= 1


# ── create_project recovery ─────────────────────────────────────────────────

_HEALTHY_LIST = FakeResp(200, {"entities": [
    {"metadata": {"uuid": "proj-9"}, "status": {"state": "COMPLETE"}}
]})
_TASK_OK = FakeResp(200, {"status": "SUCCEEDED",
                          "entity_reference_list": [{"uuid": "proj-new"}]})


def test_create_project_happy_path():
    fake_req = FakeReq(post=[FakeResp(202, {"status": {"execution_context": {"task_uuid": "t1"}}})])
    sess = FakeSession(get=[_TASK_OK])
    ns = _load(sess, fake_req)
    assert ns["create_project"]("acc", "pri", "sec") == "proj-new"


def test_create_project_adopts_after_transport_blip():
    # create POST times out; the project was created server-side, so
    # find_existing_project (a _SESS.post to /projects/list) finds it.
    fake_req = FakeReq(post=[FakeRequestException("read timed out")])
    sess = FakeSession(post=[_HEALTHY_LIST])
    ns = _load(sess, fake_req)
    assert ns["create_project"]("acc", "pri", "sec") == "proj-9"
    assert fake_req.post.calls == 1
    assert sess.post.calls == 1


def test_create_project_adopts_on_duplicate_name():
    # Live shape on PC 7.5 (DM3-POC013): HTTP 400, reason DUPLICATE_ENTITY.
    dup = FakeResp(400, text='{"reason":"DUPLICATE_ENTITY","message":'
                            '"Project name production already exists."}')
    ns = _load(FakeSession(post=[_HEALTHY_LIST]), FakeReq(post=[dup]))
    assert ns["create_project"]("acc", "pri", "sec") == "proj-9"


def test_create_project_recreates_after_error_state_dupe():
    # Duplicate rejection, but find_existing_project found an ERROR-state project,
    # deleted it, and returned None (empty list). The loop must recreate rather
    # than raise (Gemini review). create#1 dup -> list(empty) -> create#2 ok.
    dup = FakeResp(400, text='{"reason":"DUPLICATE_ENTITY"}')
    ok = FakeResp(202, {"status": {"execution_context": {"task_uuid": "t2"}}})
    fake_req = FakeReq(post=[dup, ok])
    sess = FakeSession(post=[FakeResp(200, {"entities": []})],
                       get=[FakeResp(200, {"status": "SUCCEEDED",
                                           "entity_reference_list": [{"uuid": "proj-fresh"}]})])
    ns = _load(sess, fake_req)
    assert ns["create_project"]("acc", "pri", "sec") == "proj-fresh"


def test_create_project_survives_blip_during_recovery_lookup():
    # create POST blips, and the recovery find_existing_project ALSO blips
    # (persistent outage) — it must be swallowed so the loop retries the create
    # rather than aborting. iter1: create raises + lookup raises -> continue;
    # iter2: create 202 -> task SUCCEEDED.
    fake_req = FakeReq(post=[
        FakeRequestException("blip 1"),
        FakeResp(202, {"status": {"execution_context": {"task_uuid": "t3"}}}),
    ])
    sess = FakeSession(
        post=[FakeRequestException("lookup blip")],
        get=[FakeResp(200, {"status": "SUCCEEDED",
                            "entity_reference_list": [{"uuid": "proj-retry"}]})],
    )
    ns = _load(sess, fake_req)
    assert ns["create_project"]("acc", "pri", "sec") == "proj-retry"


def test_create_project_does_not_treat_not_found_as_duplicate():
    # A 422 "subnet does not exist" must NOT be mistaken for a duplicate (the
    # old "EXIST" token matched "does not exist") — it's a genuine failure.
    ns = _load(FakeSession(), FakeReq(post=[
        FakeResp(422, text='{"message":"Referenced subnet does not exist"}')]))
    try:
        ns["create_project"]("acc", "pri", "sec")
        assert False, "expected a genuine failure, not duplicate-adoption"
    except Exception as e:
        assert "create project failed" in str(e)


def test_create_project_raises_on_genuine_failure():
    # A 400 that isn't a duplicate and isn't a subnet-lag 404 is fatal.
    ns = _load(FakeSession(), FakeReq(post=[FakeResp(400, text="malformed body")]))
    try:
        ns["create_project"]("acc", "pri", "sec")
        assert False, "expected create_project to raise on a genuine 400"
    except Exception as e:
        assert "create project failed" in str(e)
