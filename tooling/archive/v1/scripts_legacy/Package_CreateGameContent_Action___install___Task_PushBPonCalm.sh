#!/bin/bash

# CloneProd BP

#BPURL="https://github.com/Golgautier/sharing/raw/refs/heads/main/BP_EG/CloneProd.tgz"
BPURL="$HOME/ntnx-escape-game/materials/CloneProd.tgz"
BPNAME=CloneProd

cd dockervolume

# Download bp from Github
cp $BPURL CloneProd.tgz
md5sum CloneProd.tgz

# Upadte values
tar xvzf CloneProd.tgz

sed -i s/{PC_IP}/@@{PC_IP}@@/ CloneProd/blueprint.py
sed -i s/{PC_USER}/@@{PC_USERNAME}@@/ CloneProd/blueprint.py
sed -i s/{PC_PWD}/@@{PC_PASSWORD}@@/ CloneProd/blueprint.py
sed -i s/{PROJECT}/production/ CloneProd/blueprint.py

# Push it into Calm
sudo docker run -v /home/nutanix/dockervolume:/root/.calm @@{DockerRegistry}@@/ntnx/calm-dsl calm create bp -f /root/.calm/CloneProd/blueprint.py -n $BPNAME

# BlankVM
BPURL="$HOME/ntnx-escape-game/materials/NewblankVM.tgz"
BPNAME=BlankVM-source

# Download bp from Github
cp $BPURL NewblankVM.tgz
md5sum NewblankVM.tgz

# Upadte values
tar xvzf NewblankVM.tgz

sed -i s/{CLUSTER_NAME}/@@{CLUSTERNAME}@@/ NewblankVM/blueprint.py
sed -i s/{PROJECT}/production/ NewblankVM/blueprint.py

# Push it into Calm
sudo docker run -v /home/nutanix/dockervolume:/root/.calm @@{DockerRegistry}@@/ntnx/calm-dsl calm create bp -f /root/.calm/NewblankVM/blueprint.py -n $BPNAME
