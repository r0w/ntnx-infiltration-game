#script

import sys
import requests
from requests.adapters import HTTPAdapter, Retry

pc_ip = '@@{PC_IP}@@'
pc_user = '@@{PC_USERNAME}@@'
pc_pwd = '@@{PC_PASSWORD}@@'

headers = {
    "Accept": "application/json",
    "Content-Type": "application/json",
}


def _make_session():
    """Retrying session — this is the first install task, so a single
    blip here would otherwise kill the deploy before CLUSTERUUID is set."""
    retry = Retry(total=4, connect=4, read=4, backoff_factor=0.5,
                  status_forcelist=(500, 502, 503, 504), raise_on_status=False)
    s = requests.Session()
    adapter = HTTPAdapter(max_retries=retry)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s


_SESS = _make_session()

url = "https://%s:9440/api/clustermgmt/v4.0/config/clusters" % pc_ip

response = _SESS.get(url, headers=headers, verify=False,
                     auth=(pc_user, pc_pwd), timeout=30)

# Explicit auth / HTTP error handling — a wrong PC password otherwise blew up
# downstream as a bare `KeyError: 'data'` (the 401 body has no 'data' key),
# which read as a cryptic Exit code=255 in the runlog.
if response.status_code in (401, 403):
    print("[FAIL] PC authentication failed (HTTP %d) for user '%s' on %s." %
          (response.status_code, pc_user, pc_ip))
    print("       Check the 'Prism Central username' / 'Prism Central password' launch values.")
    sys.exit(1)
if not response.ok:
    print("[FAIL] GET clusters returned HTTP %d: %s" % (response.status_code, response.text[:300]))
    sys.exit(1)

try:
    response_data = response.json()
except Exception as e:
    print("[FAIL] clusters response is not valid JSON (%s): %s" % (e, response.text[:300]))
    sys.exit(1)
if 'data' not in response_data:
    print("[FAIL] unexpected clusters response (no 'data' key): %s" % response.text[:300])
    sys.exit(1)

# NOTE: the success path must use break, NOT an exit-zero call. The sandbox's
# exit helper is a NO-OP on code 0 (it only raises on a non-zero code), so an
# early exit-0 would fall through to the FAIL branch below. Only the not-found
# and error paths exit (non-zero -> real failure).
found = False
for cluster in response_data['data']:
    if "AOS" in cluster['config']['clusterFunction']:
        print("CLUSTERNAME=" + cluster['name'])
        print("CLUSTERUUID=" + cluster['extId'])
        found = True
        break

if not found:
    print("[FAIL] no AOS cluster found in the clusters response on %s." % pc_ip)
    sys.exit(1)
