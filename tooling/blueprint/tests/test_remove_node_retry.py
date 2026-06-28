"""Unit tests for remove_node.attempt_remove — the retry-decision core.

The live validation on DM3-POC013 only exercised the *happy* path: the
Files container was near-empty, so the precheck passed on the first POST
and the node went straight to TO_BE_REMOVED. The EC-blocked → retry path
(what makes issue #7's fix robust on a data-heavy Files cluster) was
never hit live. These tests cover it by driving attempt_remove with a
mocked `requests`, asserting it classifies each task outcome correctly:

  202 + task FAILED on EC error   -> 'ec_blocked'  (retryable)
  202 + task FAILED on other error -> 'failed'     (fatal)
  202 + task still RUNNING         -> 'started'     (precheck passed)
  202 + task SUCCEEDED             -> 'started'
  POST >= 400                      -> 'failed'
  202 + no task extId              -> 'started'

remove_node.py ends in `sys.exit(main())` and imports requests/urllib3 at
module level; we exec the source with those lines removed and inject a
fake `requests` so only the pure decision logic runs (no network).
"""
from pathlib import Path

SCRIPT = Path(__file__).parent.parent / "scripts" / "remove_node.py"

REAL_EC_ERROR = (
    "Remove Node prechecks failed with errors:\n"
    "Cluster will not have enough NODES to meet Erasure Code settings on "
    "container 'NutanixManagementShare'. Cannot mark node for removal"
)


class FakeResp:
    def __init__(self, status_code, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text

    def json(self):
        return self._payload


class FakeRequests:
    """Routes POST -> post_resp, GET -> task_resp (the task-poll calls)."""
    def __init__(self, post_resp, task_resp=None):
        self._post_resp = post_resp
        self._task_resp = task_resp
        self.post_calls = 0
        self.get_calls = 0

    def post(self, *a, **k):
        self.post_calls += 1
        return self._post_resp

    def get(self, *a, **k):
        self.get_calls += 1
        return self._task_resp


def _load(fake_requests):
    src = SCRIPT.read_text()
    drop = ("import requests", "import urllib3", "sys.exit(main())")
    body = "\n".join(
        l for l in src.splitlines()
        if l.strip() not in drop and not l.strip().startswith("urllib3.disable_warnings")
    )
    ns = {"requests": fake_requests}
    exec(compile(body, str(SCRIPT), "exec"), ns)
    return ns


def _accepted_with_task(task_payload):
    """202 POST returning a task ref, plus the task body GET returns."""
    post = FakeResp(202, {"data": {"extId": "ergon:abc-123"}})
    task = FakeResp(200, {"data": task_payload})
    return FakeRequests(post, task)


def test_ec_blocked_task_is_retryable():
    fake = _accepted_with_task({"status": "FAILED", "legacyErrorMessage": REAL_EC_ERROR})
    ns = _load(fake)
    assert ns["attempt_remove"]("node-uuid") == "ec_blocked"


def test_non_ec_failure_is_fatal():
    fake = _accepted_with_task(
        {"status": "FAILED", "legacyErrorMessage": "Host unreachable; VMM 503"}
    )
    ns = _load(fake)
    assert ns["attempt_remove"]("node-uuid") == "failed"


def test_running_task_means_started():
    fake = _accepted_with_task({"status": "RUNNING"})
    ns = _load(fake)
    assert ns["attempt_remove"]("node-uuid") == "started"


def test_succeeded_task_means_started():
    fake = _accepted_with_task({"status": "SUCCEEDED"})
    ns = _load(fake)
    assert ns["attempt_remove"]("node-uuid") == "started"


def test_post_4xx_is_fatal():
    fake = FakeRequests(FakeResp(409, {}, text="conflict"))
    ns = _load(fake)
    assert ns["attempt_remove"]("node-uuid") == "failed"


def test_accepted_without_task_ref_means_started():
    fake = FakeRequests(FakeResp(202, {"data": {}}))
    ns = _load(fake)
    assert ns["attempt_remove"]("node-uuid") == "started"
