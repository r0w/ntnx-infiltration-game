#!/bin/bash

BPNAMES=("ApacheServer" "PrimaryAD" "Wordpress" "KubernetesCluster" "BlankVM_AnyCloud" "HadoopCluster" "RansomwareProbe" "EmailServer" "FW" "IPAM" )

# We gonna copy CloneProd BP to create these fake BP
cd dockervolume
cp -R CloneProd FakeBP

for NAME in ${BPNAMES[@]}
do
    echo "Creation of BP $NAME"
    # Push it into Calm
    sudo docker run -v /home/nutanix/dockervolume:/root/.calm @@{DockerRegistry}@@/ntnx/calm-dsl calm create bp -f /root/.calm/FakeBP/blueprint.py -n $NAME
done

exit 0