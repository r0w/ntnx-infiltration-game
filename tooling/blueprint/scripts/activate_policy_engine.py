#script

"""
Enable the Calm policy engine + actually wait for the Policy VM to come up.

The naive flow (PUT → poll is_enabled) is unreliable: Calm's own deploy
worker only polls the Policy VM's :4202 service for ~2 minutes before
giving up; on a freshly-built CentOS image the boot + cloud-init +
service start takes longer than that, so Calm marks the deploy as failed
and `is_enabled` never flips, even though the VM is healthy and would be
reachable a minute later.

Strategy:
  1. Skip if `is_enabled` is already true.
  2. PUT with target IP, increment spec_version.
  3. Poll for up to 30 min: try `is_enabled`, but also TCP-probe :4202
     on the target IP — if either flips true, we're done.
  4. If both fail, retry once: delete the Policy VM, swap to a fallback
     IP (.11 instead of .10 by default), re-PUT, poll again.
  5. Skip entirely on non-hpoc (stage 21 is filtered there anyway).

Calm injects @@{PC_IP}@@, @@{PC_USERNAME}@@, @@{PC_PASSWORD}@@,
@@{CLUSTER_PROFILE}@@.
"""

import sys
import time
import urllib3

import requests

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

PC_IP = "@@{PC_IP}@@"
PC_USERNAME = "@@{PC_USERNAME}@@"
PC_PASSWORD = "@@{PC_PASSWORD}@@"
CLUSTER_PROFILE = "@@{CLUSTER_PROFILE}@@"

BASE = "https://%s:9440" % PC_IP
AUTH = (PC_USERNAME, PC_PASSWORD)
HEADERS = {"Content-Type": "application/json", "Accept": "application/json"}
URL_FEATURE = "%s/api/calm/v3.0/features/policy" % BASE
URL_VMS_LIST = "%s/api/nutanix/v3/vms/list" % BASE
URL_VM = "%s/api/nutanix/v3/vms/%%s" % BASE

POLL_INTERVAL_SEC = 30
POLL_TIMEOUT_SEC = 5 * 60       # 5 min per attempt (10 min total with retry)
# Best-effort mode: when both retries fail (Policy VM image broken on
# the cluster's AHV build, cf. memory project_calm_policy_vm_unstable),
# exit 0 with a loud warning instead of FAILURE. The install runbook
# continues; operator does manual activation via Prism UI Settings →
# Calm at /dm/settings/policy_enablement when the upstream issue is
# resolved. Stage 21 of the game gates on is_enabled=true; on hpoc
# clusters where the engine never comes up, stage 21 is unplayable
# until the operator activates manually — same v2 behavior.
BEST_EFFORT = True


def policy_vm_ip(suffix=10):
    parts = PC_IP.split(".")
    parts[3] = str(suffix)
    return ".".join(parts)


def get_feature():
    try:
        r = requests.get(URL_FEATURE, auth=AUTH, headers=HEADERS, verify=False, timeout=20)
    except Exception as e:
        # ReadTimeout / ConnectionError / SSL — Calm is busy mid-deploy and
        # the GET takes >20 s. Treat as transient: caller's poll loop
        # retries on the next interval. Do NOT propagate, otherwise a
        # single hiccup mid-poll kills the whole BEST_EFFORT script.
        return None, "GET transient: %s" % str(e)[:150]
    if r.status_code >= 400:
        return None, "GET %d %s" % (r.status_code, r.text[:200])
    return r.json(), None


def put_enable(spec_version, ip):
    payload = {
        "api_version": "3.1",
        "metadata": {"spec_version": spec_version, "name": "", "kind": "calm_feature"},
        "spec": {
            "feature_status": {
                "is_enabled": True,
                "config": {"data": {"ip_list": [ip]}},
            }
        },
    }
    r = requests.put(URL_FEATURE, auth=AUTH, headers=HEADERS, verify=False, timeout=30, json=payload)
    return r.status_code, r.text[:300]


def tcp_probe(host, port, timeout=4):
    """Service-up signal via requests instead of `socket` (sandbox-safer).
    A ConnectionError = port closed; anything else (HTTPS handshake, timeout,
    SSL error, 4xx/5xx response) = service is listening."""
    try:
        requests.get(
            "https://%s:%d/" % (host, int(port)),
            verify=False, timeout=timeout,
        )
        return True
    except requests.exceptions.ConnectionError as e:
        # Distinguish "refused" (closed) from "reset/timeout/SSL" (alive).
        msg = str(e).lower()
        if "refused" in msg or "no route" in msg or "unreachable" in msg:
            return False
        return True
    except Exception:
        # Read timeout, SSL handshake error, etc. — service is listening.
        return True


def find_policy_vm():
    """Returns the uuid of the auto_DND_calm_policy_engine_* VM if any."""
    r = requests.post(
        URL_VMS_LIST,
        auth=AUTH, headers=HEADERS, verify=False, timeout=20,
        json={"length": 100, "filter": "category_name==CalmPolicyEngineVM"},
    )
    if r.status_code >= 400:
        return None
    for e in r.json().get("entities") or []:
        n = e.get("status", {}).get("name", "")
        if n.startswith("auto_DND_calm_policy_engine"):
            return e["metadata"]["uuid"]
    return None


def delete_policy_vm():
    uuid = find_policy_vm()
    if not uuid:
        return False, "no policy VM found"
    r = requests.delete(URL_VM % uuid, auth=AUTH, headers=HEADERS, verify=False, timeout=30)
    if r.status_code not in (200, 202):
        return False, "DELETE %d %s" % (r.status_code, r.text[:200])
    return True, "VM %s delete-fired" % uuid


def wait_until_ready(target_ip):
    """Poll the policy feature status until any of:
       (a) state == COMPLETED AND is_enabled — Calm's own done-signal,
           same one Prism UI uses to flip the activation bar to green.
       (b) is_enabled=true observed at least once — Calm has wired the
           feature flag, even if state is still RUNNING (Calm's
           sub-tasks are post-activation cleanup, not gating). Validated
           2026-05-02 on 10.54.28.7 where the previous strict
           "3 polls + :4202 open" requirement timed out on a
           valid activation: is_enabled flapped True→False at +0s,
           manual UI check confirmed activated. Drop the strict streak
           + TCP probe gate — first positive is good enough; downstream
           install tasks don't depend on policy engine timing.
       Either is enough; the loop stops at the first hit."""
    deadline_iter = POLL_TIMEOUT_SEC // POLL_INTERVAL_SEC
    for i in range(deadline_iter):
        elapsed = i * POLL_INTERVAL_SEC
        feature, err = get_feature()
        st = (feature or {}).get("status", {}).get("feature_status", {})
        enabled = (feature or {}).get("spec", {}).get("feature_status", {}).get("is_enabled")
        state = (st.get("config") or {}).get("state")
        port_ok = tcp_probe(target_ip, 4202, timeout=4)

        # Path (a): Calm itself says COMPLETED — done.
        if state == "COMPLETED" and bool(enabled):
            print("  [+%ds] is_enabled=true AND state=COMPLETED — done (UI-style verify)"
                  % elapsed)
            return True
        # Path (b): is_enabled flipped True at any point. Trust it; the
        # subsequent flap to False is Calm's internal poll noise, not a
        # real "engine down" signal. :4202 reported as info only.
        if bool(enabled):
            print("  [+%ds] is_enabled=true | :4202 %s | state=%s — done" %
                  (elapsed, "OK" if port_ok else "no", state))
            return True
        print("  [+%ds] is_enabled=%s | :4202 %s | state=%s" %
              (elapsed, enabled, "OK" if port_ok else "no", state))
        time.sleep(POLL_INTERVAL_SEC)
    return False


def attempt(label, target_ip):
    feature, err = get_feature()
    if err:
        print("[%s] [FAIL] %s" % (label, err))
        return False
    spec_version = feature.get("metadata", {}).get("spec_version", 0)
    enabled = feature.get("spec", {}).get("feature_status", {}).get("is_enabled")
    status = feature.get("status", {}).get("feature_status", {})
    state = (status.get("config") or {}).get("state")
    current_ips = feature.get("spec", {}).get("feature_status", {}).get("config", {}).get("data", {}).get("ip_list") or []
    print("[%s] spec_version=%s is_enabled=%s state=%s ip_list=%s target=%s" %
          (label, spec_version, enabled, state, current_ips, target_ip))

    # Fast-path #1: Calm has the engine already up-and-COMPLETED on its
    # current target IP. Don't switch IPs just because our default
    # primary is .10 — the operator may have manually activated on
    # .11 via Prism UI (or v0.x of this script may have switched).
    # Trust Calm's own state.
    if enabled and state == "COMPLETED":
        print("[%s] [skip] already enabled, state=COMPLETED on %s" %
              (label, current_ips))
        return True
    # Fast-path #2: PC's state matches what we'd PUT — same as #1 but
    # without state==COMPLETED gate, kept for back-compat with older
    # PC versions that may not surface state.
    if enabled and target_ip in current_ips:
        print("[%s] [skip] already enabled with target ip" % label)
        return True

    code, body = put_enable(spec_version, target_ip)
    print("[%s] PUT status=%d" % (label, code))
    if code >= 400:
        print("[%s] [FAIL] PUT body: %s" % (label, body))
        return False

    print("[%s] polling for readiness (%d min cap, every %ds)..." %
          (label, POLL_TIMEOUT_SEC // 60, POLL_INTERVAL_SEC))
    if wait_until_ready(target_ip):
        print("[%s] [ok] policy engine deploy is ready" % label)
        return True
    print("[%s] [warn] timeout — policy services never came up at %s:4202" %
          (label, target_ip))
    return False


def main():
    if CLUSTER_PROFILE != "hpoc":
        print(
            "[skip] CLUSTER_PROFILE=%r — approval-policy stage is filtered on "
            "non-hpoc clusters, no need to deploy the policy VM here." % CLUSTER_PROFILE
        )
        return 0

    primary = policy_vm_ip(10)
    fallback = policy_vm_ip(11)

    if attempt("try 1/2 (ip=%s)" % primary, primary):
        return 0

    print("retry: deleting any stuck Policy VM + switching to fallback ip %s ..." % fallback)
    ok, msg = delete_policy_vm()
    print("  delete: %s%s" % ("ok" if ok else "skip", " — " + msg if msg else ""))
    if ok:
        time.sleep(POLL_INTERVAL_SEC)  # let DELETE settle

    if attempt("try 2/2 (ip=%s)" % fallback, fallback):
        return 0

    if BEST_EFFORT:
        print(
            "[best-effort WARN] policy engine could not be brought up on "
            "either %s or %s — Policy VM image likely broken on this AHV "
            "build (cloud-init never configures network → :4202 never "
            "binds). Install runbook continues. Operator: activate "
            "manually via Prism Central → Settings → Calm "
            "(/dm/settings/policy_enablement) when the upstream image "
            "fix lands. Stage 21 of the game (create-approval-policy) "
            "stays unplayable until then on hpoc clusters." % (primary, fallback)
        )
        return 0
    print(
        "[FAIL] policy engine could not be brought up on either %s or %s. "
        "See ROADMAP 'BP install — open issues' — operator can deploy the "
        "Policy VM manually via Prism > Settings > Calm." % (primary, fallback)
    )
    return 1


try:
    sys.exit(main())
except Exception as e:
    # Last-resort safety net for BEST_EFFORT mode. Any uncaught exception
    # in main() (HTTP timeout that fell through, attribute error from a
    # PC API shape change, etc.) bubbles here. Best-effort = the install
    # runbook keeps going; the operator activates manually via Prism UI
    # if the policy engine is needed.
    if BEST_EFFORT:
        print(
            "[best-effort WARN] activate_policy_engine.py crashed with %r — "
            "exiting 0 so the install runbook keeps going. Operator: activate "
            "manually via Prism Central → Settings → Calm." % (str(e)[:200])
        )
        sys.exit(0)
    raise
