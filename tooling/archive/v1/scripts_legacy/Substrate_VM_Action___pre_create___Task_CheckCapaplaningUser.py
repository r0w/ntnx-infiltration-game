#script

import requests 

pc_ip='@@{OLDPC}@@'
pc_user='@@{OLDPC_USER}@@'
pc_pwd='@@{PLANNER_PASSWORD}@@'

headers = {
    "Accept": "application/json",
    "Content-Type": "application/json"
}
 
url="https://%s:9440/api/nutanix/v3/vms/list" % pc_ip

payload = {
    "kind": "vm"
}

response = requests.post(url, json=payload, headers=headers, verify=False, auth=(pc_user, pc_pwd))
response_data = json.loads(response.text)

if response.ok:
    print("Ok")
    exit(0)
else:
    print("Planner password seems to be incorrect. Please delete this app, then redploy it with the good password.")
    exit(2)