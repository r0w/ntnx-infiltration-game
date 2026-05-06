#script

import requests 

pc_ip='@@{PC_IP}@@'
pc_user='@@{PC_USERNAME}@@'
pc_pwd='@@{PC_PASSWORD}@@'

headers = {
    "Accept": "application/json",
    "Content-Type": "application/json"
}
 
url="https://%s:9440/api/clustermgmt/v4.0/config/clusters" % pc_ip

response = requests.get(url, headers=headers, verify=False, auth=(pc_user, pc_pwd))
response_data = response.json()

for cluster in response_data['data']:
    if "AOS" in cluster['config']['clusterFunction']:
        print("CLUSTERNAME="+cluster['name'])
        print("CLUSTERUUID="+cluster['extId'])
        break