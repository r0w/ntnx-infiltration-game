#script
"""Enable Policy Engine once, or monitor activation already in progress.

Downloads and service startup have separate bounded polling budgets. A timeout
is not evidence that changing the VM's IP or deleting it will help.
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
POLL_INTERVAL_SEC = 30
# Poll counts also bound execution inside Calm's restricted Python runtime.
DOWNLOAD_POLLS = 120
STARTUP_POLLS = 30
TOTAL_POLLS = DOWNLOAD_POLLS + STARTUP_POLLS
BEST_EFFORT = True


def get_feature():
    try:
        r = requests.get(URL_FEATURE, auth=AUTH, headers=HEADERS, verify=False, timeout=20)
        r.raise_for_status()
        return r.json(), None
    except (requests.RequestException, ValueError) as exc:
        return None, "Cannot read Policy Engine status: %s" % str(exc)[:150]


def feature_state(feature):
    feature = feature or {}
    status = ((feature.get('status') or {}).get('feature_status') or {})
    config = status.get('config') or {}
    enabled = ((feature.get('spec') or {}).get('feature_status') or {}).get('is_enabled') is True
    return enabled, config.get('state'), config.get('state_message') or ''


def downloading(message):
    return 'download' in message.lower()


def put_enable(spec_version, ip):
    payload = {
        "api_version": "3.1",
        "metadata": {"spec_version": spec_version, "name": "", "kind": "calm_feature"},
        "spec": {"feature_status": {"is_enabled": True,
                 "config": {"data": {"ip_list": [ip]}}}},
    }
    r = requests.put(URL_FEATURE, auth=AUTH, headers=HEADERS, verify=False,
                     timeout=30, json=payload)
    r.raise_for_status()


def wait_until_ready():
    download_polls = 0
    startup_polls = 0
    last = None
    for _ in range(TOTAL_POLLS):
        feature, err = get_feature()
        enabled, state, message = feature_state(feature)
        if enabled and state in (None, 'COMPLETED'):
            print('[ready] Policy Engine is enabled; approval-policy stages are ready.')
            return True
        if state in ('ERROR', 'FAILURE'):
            print('[not ready] Policy Engine activation failed: %s' % message)
            return False
        key = (enabled, state, message, err)
        if key != last:
            print('[waiting] Policy Engine state=%s enabled=%s: %s' %
                  (state, enabled, err or message))
            last = key
        # Failed reads consume the total budget, without guessing the phase.
        if not err:
            if downloading(message):
                download_polls += 1
                if download_polls >= DOWNLOAD_POLLS:
                    print('[not ready] Image download polling limit reached; existing activation left running.')
                    return False
            else:
                startup_polls += 1
                if startup_polls >= STARTUP_POLLS:
                    print('[not ready] Service startup polling limit reached; no new activation submitted.')
                    return False
        time.sleep(POLL_INTERVAL_SEC)
    print('[not ready] Status polling limit reached; check the existing activation in Prism Central.')
    return False


def attempt():
    feature, err = get_feature()
    if err:
        print('[not ready] %s; no activation submitted.' % err)
        return False
    if not isinstance(feature, dict) or not isinstance(((feature.get('spec') or {}).get('feature_status') or {}).get('is_enabled'), bool):
        print('[not ready] Policy Engine enablement status is missing; no activation submitted.')
        return False
    enabled, state, message = feature_state(feature)
    if enabled and state in (None, 'COMPLETED'):
        print('[ready] Policy Engine is already enabled.')
        return True
    if state in ('ERROR', 'FAILURE'):
        print('[not ready] Existing activation failed: %s. Review it in Prism Central before retrying.' % message)
        return False
    if state in ('RUNNING', 'QUEUED', 'PENDING') or downloading(message) or enabled:
        print('[resume] Monitoring existing Policy Engine activation.')
    elif state in (None, 'DISABLED', 'COMPLETED'):
        ip = '.'.join(PC_IP.split('.')[:3] + ['10'])
        put_enable(feature.get('metadata', {}).get('spec_version', 0), ip)
        print('[started] Policy Engine activation submitted once.')
    else:
        print('[not ready] Unrecognized Policy Engine state %r; review in Prism Central.' % state)
        return False
    return wait_until_ready()


def main():
    if CLUSTER_PROFILE != 'hpoc':
        print('[skip] Policy Engine is only required for the hpoc profile.')
        return 0
    try:
        if attempt():
            return 0
    except (requests.RequestException, ValueError) as exc:
        # A lost PUT response is ambiguous: do not submit it again.
        print('[not ready] Activation request/status could not be confirmed: %s' % str(exc)[:200])
    print('[best-effort WARN] Installation may continue, but Policy Engine is NOT confirmed ready. '
          'Approval-policy stages require it. Open Prism Central > Settings > Calm '
          '(/dm/settings/policy_enablement), inspect download or startup progress, '
          'and confirm activation completes before starting those stages. '
          'No Policy VM was deleted and no fallback IP was tried.')
    return 0 if BEST_EFFORT else 1


sys.exit(main())
