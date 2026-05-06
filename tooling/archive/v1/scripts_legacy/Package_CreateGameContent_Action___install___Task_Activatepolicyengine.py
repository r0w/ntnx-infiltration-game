#script

import requests

pc_ip="@@{PC_IP}@@"
pc_user="@@{PC_USERNAME}@@"
pc_pwd="@@{PC_PASSWORD}@@"

headers = {
        "Content-Type": "application/json",
        "Accept": "application/json"
    }


ip_parts = pc_ip.split('.')
ip_parts[3] = "10"

policyIp = '.'.join(ip_parts)

# Get Account
payload = {
    "api_version": "3.1",
    "metadata": {
        "spec_version": 0,
        "name": "",
        "kind": "calm_feature"
    },
    "spec": {
        "feature_status": {
            "is_enabled": True,
            "config": {
                "data": {
                    "ip_list": [
                        policyIp
                    ]
                }
            }
        }
    }
}

url="https://%s:9440/api/calm/v3.0/features/policy" % (pc_ip)

response = requests.put(url, json=payload, headers=headers, verify=False, auth=(pc_user, pc_pwd))
response_data=response.json()

exit(0)