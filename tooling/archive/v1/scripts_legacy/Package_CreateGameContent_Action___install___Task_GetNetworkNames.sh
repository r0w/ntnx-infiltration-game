#!/bin/bash 

cd ~/.calm

source venv/bin/activate

python <<EOF
import ntnx_networking_py_client
from jsonpath_ng.ext import parse
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

pc_ip = "@@{PC_IP}@@"
pc_user = "@@{PC_USERNAME}@@"
pc_pwd = "@@{PC_PASSWORD}@@"

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

try:
    api_response = subnets_api.list_subnets()
    
    # Get Primary Network
    jsonpathExprPrimary = parse('$.data[?(@.name =~ "primary")].name')
    primaryNetwork=jsonpathExprPrimary.find(api_response.to_dict())
    print("PRIMARY_SUBNET=",primaryNetwork[0].value)
    
    # GEt Secondary Network
    jsonpathExprSecondary = parse('$.data[?(@.name =~ "secondary")].name')
    secondaryNetwork=jsonpathExprSecondary.find(api_response.to_dict())
    print("SECONDARY_SUBNET=",secondaryNetwork[0].value)
    
except ntnx_networking_py_client.rest.ApiException as e:
    print(e)

EOF
