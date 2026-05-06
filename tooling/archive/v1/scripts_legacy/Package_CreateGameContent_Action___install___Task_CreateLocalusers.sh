#!/bin/bash 

cd ~/.calm

source venv/bin/activate

python <<EOF
from jsonpath_ng.ext import parse
import json
import ntnx_iam_py_client

pc_ip = "@@{PC_IP}@@"
pc_user = "@@{PC_USERNAME}@@"
pc_pwd = '@@{PC_PASSWORD}@@'


# Configure the client
config = ntnx_iam_py_client.Configuration()
# IPv4/IPv6 address or FQDN of the cluster
config.host = pc_ip
# Port to which to connect to
config.port = 9440
# Max retry attempts while reconnecting on a loss of connection
config.max_retry_attempts = 3
# Backoff factor to use during retry attempts
config.backoff_factor = 3
# UserName to connect to the cluster
config.username = pc_user
# Password to connect to the cluster
config.password = pc_pwd
config.verify_ssl = False

# Please add authorization information here if needed.
client = ntnx_iam_py_client.ApiClient(configuration=config)
users_api = ntnx_iam_py_client.UsersApi(api_client=client)


users = [
    {
        "username": "charlie",
        "email": "charlie.ugly@others.com",
        "password": "Nutanix/4u",
        "displayName": "Charlie",
        "firstName": "Charlie",
        "lastName": "Ugly"
    },
    {
        "username": "thom",
        "email": "thom.cat@others.com",
        "password": "Nutanix/4u",
        "displayName":"Thom",
        "firstName":"Thom",
        "lastName":"Cat"
    },
    {
        "username": "william",
        "email": "william.shake@others.com",
        "password": "Nutanix/4u",
        "displayName":"Willy",
        "firstName":"William",
        "lastName":"Shake"
    }
]

for guy in users:
    user = ntnx_iam_py_client.User()
    user.username = guy['username']
    user.email_id = guy['email']
    user.password = guy['password']
    user.display_name = guy['displayName']
    user.first_name = guy['firstName']
    user.last_name = guy['lastName']
    user.user_type="LOCAL"

    try:
        api_response = users_api.create_user(body=user)
    except ntnx_iam_py_client.rest.ApiException as e:
        print(e)


exit(0)

EOF