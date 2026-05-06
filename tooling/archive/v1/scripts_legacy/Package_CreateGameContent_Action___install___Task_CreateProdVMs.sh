#!/bin/bash 

cd ~/.calm

source venv/bin/activate

python <<EOF
from jsonpath_ng.ext import parse
import json
import ntnx_vmm_py_client.configuration
import requests
import http.client
import ntnx_prism_py_client
import ntnx_vmm_py_client
import ntnx_networking_py_client
import uuid
import time

pc_ip="@@{PC_IP}@@"
pc_user="@@{PC_USERNAME}@@"
pc_pwd='@@{PC_PASSWORD}@@'
cat_key="Environment"
cat_value="Production"
project_name="production"
image_name="Ubuntu2404"
projectUUID="@@{ProjectUUID}@@"

# Get categoryID for Environment:Production
config = ntnx_prism_py_client.Configuration()
config.host = pc_ip
config.port = 9440
config.max_retry_attempts = 3
config.backoff_factor = 3
config.username = pc_user
config.password = pc_pwd
config.verify_ssl = False


headers = {
    "Accept": "application/json",
    "Content-Type": "application/json"
}


VMSpecs = [
    {
        "name": "prd-ransom-probe-1",
        "numSockets": 2,
        "memorySizeGB": 4
    },
    {
        "name": "prd-ransom-payment-core",
        "numSockets": 2,
        "memorySizeGB": 4
    },
    {
        "name": "prd-ransom-payment-front",
        "numSockets": 2,
        "memorySizeGB": 4
    },
    {
        "name": "beta-ransom-engine-v2.2",
        "numSockets": 2,
        "memorySizeGB": 4
    },
    {
        "name": "prd-mail",
        "numSockets": 2,
        "memorySizeGB": 4
    },
    {
        "name": "prd-directory",
        "numSockets": 2,
        "memorySizeGB": 4
    },
    {
        "name": "prd-scan",
        "numSockets": 2,
        "memorySizeGB": 4
    },
]



client_prrism = ntnx_prism_py_client.ApiClient(configuration=config)
categories_api = ntnx_prism_py_client.CategoriesApi(api_client=client_prrism)
page = 0
limit = 50

try:
    api_response = categories_api.list_categories(_filter="((key eq '"+cat_key+"') and (value eq '"+cat_value+"'))", _page=page, _limit=limit)
    catUUID=api_response.data[0].ext_id
except ntnx_prism_py_client.rest.ApiException as e:
    print(e)

# Get Secondary network ID
url="https://%s:9440/api/networking/v4.0/config/subnets" % pc_ip

payload = {
    "kind": "subnet"
    }

response = requests.get(url, json=payload, headers=headers, verify=False, auth=(pc_user, pc_pwd))
response_data = response.json()

jsonpath_expr = parse('$.data[?(@.name=="@@{SECONDARY_SUBNET}@@")].extId')

for match in jsonpath_expr.find(response_data):
    subnetUUID = match.value

# Get Image ID
url = "https://%s:9440/api/nutanix/v3/images/list" % pc_ip

payload={
    "kind": "image",
    "length": 100,
    }

response = requests.post(url, json=payload, headers=headers, verify=False, auth=(pc_user, pc_pwd))
response_data = response.json()

for image in response_data['entities']:
    if image['status']['name'] == image_name:
        imageUUID=image['metadata']['uuid']

# Get ClusterUUID
url="https://%s:9440/api/clustermgmt/v4.0/config/clusters" % pc_ip

response = requests.get(url, headers=headers, verify=False, auth=(pc_user, pc_pwd))
response_data = response.json()

clusterUUID = None
for cluster in response_data['data']:
    if "AOS" in cluster.get('config', {}).get('clusterFunction', []):
        clusterUUID = cluster['extId']
        break

if not clusterUUID:
    print("No AOS cluster found")
    exit(2)

# Create the VMs
client_vm = ntnx_vmm_py_client.ApiClient(configuration=config)
vm_api = ntnx_vmm_py_client.VmApi(api_client=client_vm)

# Vm object initializations here...
for elt in VMSpecs:


    vm=ntnx_vmm_py_client.AhvConfigVm(
        name=elt['name'],
        num_sockets=elt['numSockets'],
        memory_size_bytes=elt['memorySizeGB']*1024*1024*1024,
        cluster=ntnx_vmm_py_client.AhvConfigClusterReference(
                        ext_id=clusterUUID
                    ),
        categories=[
            ntnx_vmm_py_client.AhvConfigCategoryReference(
                ext_id=catUUID
            )
        ],
        nics=[
            ntnx_vmm_py_client.AhvConfigNic(
                backing_info=ntnx_vmm_py_client.EmulatedNic(
                    is_connected=True,
                    num_queues=1
                ),
                network_info=ntnx_vmm_py_client.AhvConfigNicNetworkInfo(
                    subnet=ntnx_vmm_py_client.SubnetReference(
                        ext_id=subnetUUID
                    )
                )
            )
        ],
        disks=[
            ntnx_vmm_py_client.AhvConfigDisk(
                disk_address=ntnx_vmm_py_client.AhvConfigDiskAddress(
                    bus_type=ntnx_vmm_py_client.AhvConfigDiskBusType.SCSI,
                    index=0
                ),
                backing_info=ntnx_vmm_py_client.AhvConfigVmDisk(
                    disk_size_bytes=42949672960,
                    data_source=ntnx_vmm_py_client.DataSource(
                        reference=ntnx_vmm_py_client.ImageReference(
                                image_ext_id=imageUUID
                            )
                        )
                    )
                )
            ]
        )

    try:
        api_response = vm_api.create_vm(body=vm)
    except ntnx_vmm_py_client.rest.ApiException as e:
        err=json.loads(e.body)
        print(err['data']['error']['validationErrorMessages'][0]['message'])
        continue

    print("VM %s created" % elt['name'])

    # We change VM Project
    
    # Get VM ID
    response.data=None

    retries = 0
    while not response.data:
        if retries > 30: # 5 minutes timeout
            print("Timeout waiting for VM %s" % elt['name'])
            break
        response = vm_api.list_vms(_filter="name eq '"+elt['name']+"'")
        time.sleep(10)
        retries += 1

    vmId= response.data[0].ext_id
    print(" - VM ID: %s" % vmId)

    # Now we change the project
    # Not found in v4 API, Will be evailable in v4 GA
    url = "https://%s:9440/api/nutanix/v3/vms/%s" % (pc_ip, vmId)
    
    response=requests.get(url, headers=headers, verify=False, auth=(pc_user, pc_pwd))
    VMInfo = json.loads(response.content)

    # We clean VM status
    del VMInfo['status']

    # We change Project
    VMInfo['metadata']['project_reference'] = {
        "kind": "project", 
        "name": project_name, 
        "uuid": projectUUID
        }
    
    #We powerOn th e VM
    VMInfo['spec']['resources']['power_state']='ON'

    # We apply the changes
    url = "https://%s:9440/api/nutanix/v3/vms/%s" % (pc_ip, vmId)
    response=requests.put(url, json=VMInfo, headers=headers, verify=False, auth=(pc_user, pc_pwd))
    
    if( response.status_code == 202):
        print(" - Ownsership changed and VM powered ON")
    else:
        print(" - Error changing VM ownership ans startup")


exit(0)

EOF