"""Guards the retry wiring on get_cluster.py — the FIRST install task, where a
single transient blip (a ReadTimeout, à la issue #28) used to kill the whole
deploy before CLUSTERUUID was set.

Retry is now urllib3's Retry adapter on `_SESS` (proven to work in the Calm
escript sandbox), so we assert OUR session config + that the flat top-to-bottom
script still parses CLUSTERUUID from a `_SESS.get`. We exec the source with
imports / sys.exit removed and a fake `_SESS` injected, capturing stdout.
"""
import io
from contextlib import redirect_stdout
from pathlib import Path

SCRIPT = Path(__file__).parent.parent / "scripts" / "get_cluster.py"


class FakeResp:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.text = text
        self.ok = status_code < 400

    def json(self):
        return self._payload


class FakeSession:
    def __init__(self, get_queue):
        self._q = list(get_queue)
        self.get_calls = 0

    def get(self, *a, **k):
        self.get_calls += 1
        item = self._q.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


_AOS = {"data": [{"name": "DM3-POC013", "extId": "cluster-uuid-1",
                  "config": {"clusterFunction": ["AOS"]}}]}


def _run(fake_sess):
    src = SCRIPT.read_text()
    drop = ("import requests", "from requests.adapters import HTTPAdapter, Retry",
            "import sys", "_SESS = _make_session()")
    body = "\n".join(
        l for l in src.splitlines()
        if l.strip() not in drop and not l.strip().startswith("sys.exit")
    )

    class _Sys:
        def exit(self, *_):
            raise SystemExit
    ns = {"_SESS": fake_sess, "sys": _Sys()}
    out = io.StringIO()
    try:
        with redirect_stdout(out):
            exec(compile(body, str(SCRIPT), "exec"), ns)
    except SystemExit:
        pass
    return out.getvalue()


def test_get_cluster_happy_path():
    fake = FakeSession([FakeResp(200, _AOS)])
    out = _run(fake)
    assert "CLUSTERUUID=cluster-uuid-1" in out
    assert "CLUSTERNAME=DM3-POC013" in out
    assert fake.get_calls == 1


def test_get_cluster_session_retry_config():
    # Build the REAL session and assert OUR intended retry config.
    src = SCRIPT.read_text()
    body = "\n".join(l for l in src.splitlines() if not l.strip().startswith("sys.exit"))
    # neutralise the actual network GET at the bottom by stopping before it
    body = body.split("url = ")[0]
    ns = {}
    exec(compile(body, str(SCRIPT), "exec"), ns)
    retry = ns["_SESS"].get_adapter("https://x").max_retries
    assert 503 in retry.status_forcelist and 500 in retry.status_forcelist
    assert retry.total >= 1
