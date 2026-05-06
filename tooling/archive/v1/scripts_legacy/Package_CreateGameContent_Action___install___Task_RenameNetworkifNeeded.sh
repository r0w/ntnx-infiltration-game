#!/bin/bash 

cd ~/.calm

source venv/bin/activate

python <<EOF

import requests
import ntnx_networking_py_client
from jsonpath_ng.ext import parse
import uuid

pc_ip="@@{PC_IP}@@"
pc_user="@@{PC_USERNAME}@@"
pc_pwd="@@{PC_PASSWORD}@@"
sourceSubnetName="aux-1"
targetSubnetName="secondary"

networkFound=False

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

try:
    api_response = subnets_api.list_subnets()
    
    # Get Secondary Network
    jsonpathExprSecondary = parse('$.data[?(@.name =~ "secondary")].name')
    secondaryNetwork=jsonpathExprSecondary.find(api_response.to_dict())
    
    if secondaryNetwork:
        networkFound=True
    
except ntnx_networking_py_client.rest.ApiException as e:
    print(e)

# If no 'secondary' network found, we will try to get the UUID of the source subnet aux-1
if networkFound==True:
    print("Secondary network found, no need to rename it")
else:
    response=subnets_api.list_subnets(_filter="name eq '%s'" % sourceSubnetName)
    myData = response.to_dict()

    # Check if we got an id
    if myData['data']!=None:
        subnetUUID=myData['data'][0]['ext_id']
    else:
        print("No subnet found with name %s or secondary, ERROR" % sourceSubnetName)
        exit(2)
        
    # Get etag
    response=subnets_api.get_subnet_by_id(subnetUUID)
    etag=client.get_etag(response)

    # Change name in payload
    response._GetSubnetApiResponse__data.name=targetSubnetName

    # Apply playload
    response=subnets_api.update_subnet_by_id(subnetUUID, body=response._GetSubnetApiResponse__data, if_match=etag)

EOF