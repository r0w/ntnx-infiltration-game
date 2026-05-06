#!/bin/bash 

cd ~/.calm

source venv/bin/activate

python <<EOF

import ntnx_clustermgmt_py_client

# Configure the client
config = ntnx_clustermgmt_py_client.Configuration()
# IPv4/IPv6 address or FQDN of the cluster
config.host = "@@{PC_IP}@@"
# Port to which to connect to
config.port = 9440
# Max retry attempts while reconnecting on a loss of connection
config.max_retry_attempts = 3
# Backoff factor to use during retry attempts
config.backoff_factor = 3
# UserName to connect to the cluster
config.username = "@@{PC_USERNAME}@@"
# Password to connect to the cluster
config.password = "@@{PC_PASSWORD}@@"
# Verify SSL certificates
config.verify_ssl = False

client = ntnx_clustermgmt_py_client.ApiClient(configuration=config)
clusters_api = ntnx_clustermgmt_py_client.ClustersApi(api_client=client)
page = 0
limit = 50

# Get Cluster ID
try:
   api_response = clusters_api.list_clusters(_page=page, _limit=limit)
except ntnx_clustermgmt_py_client.rest.ApiException as e:
   print(e)

d = api_response.to_dict() if api_response else {}
items = d.get("data") or []
if not items:
    print("No cluster found")
    exit(0)

clusterUUID = None
for cluster in items:
    if "AOS" in cluster.get("config", {}).get("cluster_function", []):
        clusterUUID = cluster["ext_id"]
        break

if not clusterUUID:
    print("No AOS cluster found")
    exit(2)

# Get Node ID finishing by -4
try:
   api_response = clusters_api.list_hosts_by_cluster_id(clusterExtId=clusterUUID,_filter="endswith(hostName,'-4')",  _page=page, _limit=limit)
   hosts = getattr(api_response, "_ListHostsByClusterIdApiResponse__data", None)
   if not hosts:
       print("No '-4' host found, skipping removal")
       exit(0)
   NodeUUID = hosts[0].ext_id
except ntnx_clustermgmt_py_client.rest.ApiException as e:
   print(e)
   exit(0)

# Please add authorization information here if needed.
nodeRemovalParams = ntnx_clustermgmt_py_client.NodeRemovalParams()

# NodeRemovalParams object initializations here...
nodeRemovalParams.node_uuids = [ NodeUUID ] 

print("Launching the node removal. ClusterID : "+clusterUUID+" / NodeID : "+NodeUUID)

try:
   api_response = clusters_api.remove_node(clusterExtId=clusterUUID, body=nodeRemovalParams)
   exit(0)
except ntnx_clustermgmt_py_client.rest.ApiException as e:
   print(e)
   
EOF