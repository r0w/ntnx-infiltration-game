"""Guards the retry wiring on get_cluster.py — the FIRST install task, where a
single transient blip (a ReadTimeout, à la issue #28) used to kill the whole
deploy before CLUSTERUUID was even set.

get_cluster.py is a flat top-to-bottom escript (no main()), so we exec the
source with the module-level imports / sys.exit removed and a fake `requests`
injected, capturing stdout to assert it still emits CLUSTERUUID.
"""
import io
from contextlib import redirect_stdout
from pathlib import Path

SCRIPT = Path(__file__).parent.parent / "scripts" / "get_cluster.py"


class FakeRequestException(Exception):
    pass


class FakeResp:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.text = text
        self.ok = status_code < 400

    def json(self):
        return self._payload


class FakeRequests:
    RequestException = FakeRequestException

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


def _run(fake):
    src = SCRIPT.read_text()
    drop = ("import requests", "import sys", "import time")
    body = "\n".join(
        l for l in src.splitlines()
        if l.strip() not in drop and not l.strip().startswith("sys.exit")
    )

    class _Sys:
        def exit(self, *_):
            raise SystemExit
    ns = {"requests": fake, "sys": _Sys(), "time": type("T", (), {"sleep": staticmethod(lambda _n: None)})()}
    out = io.StringIO()
    try:
        with redirect_stdout(out):
            exec(compile(body, str(SCRIPT), "exec"), ns)
    except SystemExit:
        pass
    return out.getvalue()


def test_get_cluster_happy_path():
    out = _run(FakeRequests([FakeResp(200, _AOS)]))
    assert "CLUSTERUUID=cluster-uuid-1" in out
    assert "CLUSTERNAME=DM3-POC013" in out


def test_get_cluster_retries_transient_blip():
    fake = FakeRequests([FakeRequestException("read timed out"), FakeResp(200, _AOS)])
    out = _run(fake)
    assert fake.get_calls == 2
    assert "CLUSTERUUID=cluster-uuid-1" in out
