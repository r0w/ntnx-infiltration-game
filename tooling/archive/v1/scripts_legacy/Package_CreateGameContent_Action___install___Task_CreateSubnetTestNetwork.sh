#!/bin/bash 

cd ~/.calm

source venv/bin/activate

python <<EOF
import ntnx_networking_py_client
import requests

pc_ip="@@{PC_IP}@@"
pc_user="@@{PC_USERNAME}@@"
pc_pwd="@@{PC_PASSWORD}@@"
subnetName="TestNetwork"

url="https://%s:9440/api/clustermgmt/v4.0/config/clusters" % pc_ip
headers = {
    "Accept": "application/json",
    "Content-Type": "application/json"
}
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
subnet = ntnx_networking_py_client.Subnet(
    name=subnetName,
    subnet_type = ntnx_networking_py_client.SubnetType.VLAN,
    network_id = 1,
    is_advanced_networking=True,
    cluster_reference=clusterUUID,
    is_external=True,
    is_nat_enabled=False,
    ip_prefix="192.168.1.0/25",
    ip_config=
        [
            ntnx_networking_py_client.IPConfig(
            ipv4=ntnx_networking_py_client.IPv4Config(
                ip_subnet=ntnx_networking_py_client.IPv4Subnet(
                    ip=ntnx_networking_py_client.IPv4Address("192.168.1.0"),
                    prefix_length=24
                ),
                default_gateway_ip=ntnx_networking_py_client.IPv4Address("192.168.1.1"),
                pool_list= [
                    ntnx_networking_py_client.IPv4Pool(
                        start_ip=ntnx_networking_py_client.IPv4Address("192.168.1.2"),
                        end_ip=ntnx_networking_py_client.IPv4Address("192.168.1.250")
                    )
                ],
            )
        )
    ],
)

try:
    api_response = subnets_api.create_subnet(body=subnet)
except ntnx_networking_py_client.rest.ApiException as e:
    print(e)

print("Done")
EOF