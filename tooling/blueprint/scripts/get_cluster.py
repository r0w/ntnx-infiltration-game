#script

import sys
import requests

pc_ip = '@@{PC_IP}@@'
pc_user = '@@{PC_USERNAME}@@'
pc_pwd = '@@{PC_PASSWORD}@@'

headers = {
    "Accept": "application/json",
    "Content-Type": "application/json",
}

url = "https://%s:9440/api/clustermgmt/v4.0/config/clusters" % pc_ip

response = requests.get(url, headers=headers, verify=False, auth=(pc_user, pc_pwd))

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

response_data = response.json()
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
