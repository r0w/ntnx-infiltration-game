#script
"""Read-only VLAN choices, with the usual HPoC secondary network first."""
import requests

CLUSTER_PROFILE = '@@{CLUSTER_PROFILE}@@'
PC_IP = '@@{PC_IP}@@'
PC_USERNAME = '@@{PC_USERNAME}@@'
PC_PASSWORD = '@@{PC_PASSWORD}@@'


def network_options(subnets):
    names = set()
    for subnet in subnets:
        if subnet.get('subnetType') != 'VLAN' or subnet.get('isExternal'):
            continue
        name = subnet.get('name')
        if not name:
            continue
        if any(c in name for c in ',\r\n'):
            raise Exception('A VLAN name contains a comma or newline and cannot be shown in this menu.')
        names.add(name)
    def order(name):
        lower = name.lower()
        return (0 if lower == 'secondary' or lower.startswith('secondary-') else 1, lower)
    return sorted(names, key=order)


def main():
    profile = CLUSTER_PROFILE.strip().lower()
    if profile == 'hpoc':
        print('secondary')
        return
    if profile != 'other':
        raise Exception('Choose a cluster profile: hpoc or other.')
    subnets = []
    for page in range(200):
        response = requests.get(
            'https://%s:9440/api/networking/v4.0/config/subnets?$limit=100&$page=%d' % (PC_IP, page),
            headers={'Accept': 'application/json', 'Content-Type': 'application/json'},
            auth=(PC_USERNAME, PC_PASSWORD), verify=False, timeout=20,
        )
        response.raise_for_status()
        data = response.json().get('data') or []
        subnets.extend(data)
        if len(data) < 100:
            break
    else:
        raise Exception('Too many networks to list.')
    options = network_options(subnets)
    if not options:
        raise Exception('No internal VLAN networks found on this cluster.')
    print(','.join(options))


main()
