#!/bin/bash 

cd ~/.calm

source venv/bin/activate

python <<EOF

import ntnx_lifecycle_py_client

pc_ip="@@{PC_IP}@@"
pc_user="@@{PC_USERNAME}@@"
pc_pwd="@@{PC_PASSWORD}@@"

# Configure the client
config = ntnx_lifecycle_py_client.Configuration()

config.host = pc_ip # IPv4/IPv6 address or FQDN of the cluster
config.port = 9440 # Port to which to connect to
config.max_retry_attempts = 3 # Max retry attempts while reconnecting on a loss of connection
config.backoff_factor = 3 # Backoff factor to use during retry attempts
config.username = pc_user # UserName to connect to the cluster
config.password = pc_pwd # Password to connect to the cluster
config.verify_ssl = False

# Please add authorization information here if needed.
client = ntnx_lifecycle_py_client.ApiClient(configuration=config)
inventory_api = ntnx_lifecycle_py_client.InventoryApi(api_client=client)

try:
    api_response = inventory_api.perform_inventory()
except ntnx_lifecycle_py_client.rest.ApiException as e:
    print(e)

EOF