"""Unit tests for remove_node.py's EC-X precheck detection.

The retry loop in `Remove 4th host on HPoC` hinges on telling an
erasure-coding precheck block (retryable — Curator is still un-coding
strips) apart from a real failure (fatal). That decision is two pure
helpers, `_task_failure_text` + `_is_ec_block`, matched against the
task's `legacyErrorMessage` / `errorMessages`. If a refactor changes the
matched string, the step would silently stop retrying and stall on a
4-node Files HPoC again (issue #7). These tests lock the behavior using
the real error text captured live on DM3-POC013.

The script ends in `sys.exit(main())`; its module level is only string
constants + defs (no network at import), so we exec the source with that
one line removed to get the helpers without running the install task.
"""
from pathlib import Path

SCRIPT = Path(__file__).parent.parent / "scripts" / "remove_node.py"


def _load_helpers():
    src = SCRIPT.read_text()
    body = "\n".join(l for l in src.splitlines() if l.strip() != "sys.exit(main())")
    ns: dict = {}
    exec(compile(body, str(SCRIPT), "exec"), ns)
    return ns


HELPERS = _load_helpers()
_is_ec_block = HELPERS["_is_ec_block"]
_task_failure_text = HELPERS["_task_failure_text"]

# The exact legacyErrorMessage a 4-node Files HPoC returns (DM3-POC013).
REAL_EC_ERROR = (
    "Remove Node prechecks failed with errors:\n"
    "Cluster will not have enough NODES to meet Erasure Code settings on "
    "container 'NutanixManagementShare'. Cannot mark node for removal"
)


def test_real_ec_error_is_detected():
    assert _is_ec_block(REAL_EC_ERROR) is True


def test_ec_match_is_case_insensitive():
    assert _is_ec_block("ERASURE CODE settings not met") is True
    assert _is_ec_block("erasure coding strip width") is True


def test_unrelated_failure_is_not_ec_block():
    assert _is_ec_block("Host is unreachable; VMM returned 503") is False
    assert _is_ec_block("prechecks failed: insufficient memory") is False


def test_empty_or_none_is_not_ec_block():
    assert _is_ec_block("") is False
    assert _is_ec_block(None) is False


def test_failure_text_concatenates_legacy_and_messages():
    task = {
        "legacyErrorMessage": REAL_EC_ERROR,
        "errorMessages": [
            {"message": "Operation failed due to legacy error"},
            "a bare string message",
        ],
    }
    text = _task_failure_text(task)
    assert "Erasure Code settings" in text
    assert "legacy error" in text
    assert "a bare string message" in text


def test_real_task_shape_classifies_as_ec_block():
    """End to end on the captured task body: text extraction feeding the
    EC matcher must flag it retryable."""
    task = {
        "status": "FAILED",
        "legacyErrorMessage": REAL_EC_ERROR,
        "errorMessages": [{"message": "TSKS-20801", "severity": "ERROR"}],
    }
    assert _is_ec_block(_task_failure_text(task)) is True


def test_failure_text_handles_missing_fields():
    assert _task_failure_text({}) == ""
    assert _is_ec_block(_task_failure_text({})) is False
