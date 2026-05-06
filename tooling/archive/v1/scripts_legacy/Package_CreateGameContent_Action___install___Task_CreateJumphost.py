#script

import requests
import uuid

pc_ip = "@@{PC_IP}@@"
pc_user = "@@{PC_USERNAME}@@"
pc_password = "@@{PC_PASSWORD}@@"
endpoint_ip = "@@{VM.address}@@"
endpoint_user = '@@{NUTANIX.username}@@'
endpoint_password = "@@{NUTANIX.secret}@@"
project_name = "production"
cred_uuid=uuid.uuid4()
cred_name= "endpoint_cred_game"+str(cred_uuid)[0:3]
endpoint_name = "jumphost"
projectUUID = "@@{ProjectUUID}@@"

# We create endpoint
payload = {
    "api_version": "3.0",
    "spec":
        {
            "resources":
                {
                    "type":"Linux",
                    "value_type":"IP",
                    "attrs":
                        {
                            "credential_definition_list":
                                [
                                    {
                                        "description":"",
                                        "username": endpoint_user,
                                        "type":"PASSWORD",
                                        "name":cred_name,
                                        "cred_class":"static",
                                        "secret":
                                            {
                                                "attrs":
                                                    {
                                                        "is_secret_modified":True
                                                    },
                                                "value": endpoint_password
                                            },
                                        "uuid":str(cred_uuid)
                                    }
                                ],
                        "login_credential_reference":
                            {
                                "name": cred_name,
                                "kind":"app_credential",
                                "uuid": str(cred_uuid)
                            },
                            "values":
                                [
                                    endpoint_ip
                                ],
                            "port":22,
                        }
                },
            "name": endpoint_name
        },
    "metadata":
        {
            "project_reference":
                {
                    "name":project_name,
                    "kind":"project",
                    "uuid": str(projectUUID)
                },
            "kind":"endpoint"
        }
    }

url="https://%s:9440/api/nutanix/v3/endpoints" % pc_ip
headers = {
  "Content-Type": "application/json",
  "Accept": "application/json"
}
response = requests.request("POST", url, json=payload, headers=headers, verify=False, auth=(pc_user, pc_password))
print(response)