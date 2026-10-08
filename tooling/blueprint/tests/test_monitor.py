"""Calm can return other applications' logs unless both filters are sent."""
import importlib.util
from pathlib import Path


def test_monitor_reads_only_selected_application_and_action(monkeypatch):
    monkeypatch.setenv("PC_ENDPOINT", "https://pc.invalid:9440")
    monkeypatch.setenv("PC_PASSWORD", "test")
    path = Path(__file__).parents[1] / "monitor.py"
    spec = importlib.util.spec_from_file_location("monitor_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    root = {"metadata": {"uuid": "current", "creation_time": "20"},
            "status": {"type": "action_runlog", "action_reference": {"name": "action_create"}}}
    older = {"metadata": {"uuid": "older", "creation_time": "10"},
             "status": {"type": "action_runlog", "action_reference": {"name": "action_create"}}}
    child = {"metadata": {"uuid": "child"}, "status": {"state": "SUCCESS"}}
    calls = []

    class Reply:
        ok = True
        def __init__(self, entries): self.entries = entries
        def json(self): return {"entities": self.entries}
        def raise_for_status(self): pass

    def api(method, path, **kwargs):
        calls.append((method, path, kwargs["json"]))
        return Reply([older, root] if len(calls) == 1 else [child])

    monkeypatch.setattr(module, "api", api)
    assert module.list_runlogs("my-app") == [root, child]
    assert calls[0][2]["filter"] == "application_reference==my-app"
    assert calls[1][2]["filter"] == "root_reference==current"
