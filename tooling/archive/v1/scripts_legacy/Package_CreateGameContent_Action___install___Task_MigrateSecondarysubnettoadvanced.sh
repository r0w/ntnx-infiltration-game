#!/bin/bash 

cd ~/.calm

source venv/bin/activate

python <<EOF

import requests
import ntnx_networking_py_client
import uuid

pc_ip="@@{PC_IP}@@"
pc_user="@@{PC_USERNAME}@@"
pc_pwd="@@{PC_PASSWORD}@@"
subnetName="@@{SECONDARY_SUBNET}@@"

# Get subnet UUID
# Configure the client
config = ntnx_networking_py_client.Configuration()
config.host = pc_ip
config.port = 9440
config.max_retry_attempts = 3
config.backoff_factor = 3
config.username = pc_user
config.password = pc_pwd
config.verify_ssl = False

client = ntnx_networking_py_client.ApiClient(configuration=config)
subnets_api = ntnx_networking_py_client.SubnetsApi(api_client=client)

response=subnets_api.list_subnets(_filter="name eq '" + subnetName + "'")
myData = response.to_dict()

# Check if we got an id
if myData['data']!=None:
    subnetUUID=myData['data'][0]['ext_id']
    
# get etag
response=subnets_api.get_subnet_by_id(subnetUUID)
etag=client.get_etag(response)

# Migrate it
url="https://%s:9440/api/networking/v4.0.b2/config/\$actions/migrate-subnets" % pc_ip

headers = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Ntnx-Request-Id": str(uuid.uuid4()),
    "If-Match": etag
}

payload = {
    "subnets":
        [
            {
            "subnetUuid": subnetUUID
            }
        ]
    }

response = requests.post(url, headers=headers, json=payload, auth=(pc_user, pc_pwd), verify=False)
print("Call RC :",response.status_code)
EOF
