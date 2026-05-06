#!/bin/bash 

cd ~/.calm
source venv/bin/activate

PCIP="@@{PC_IP}@@"
PCUSER="@@{PC_USERNAME}@@"
PCPASSWORD="@@{PC_PASSWORD}@@"

PRIMARY_SUBNET_NAME="@@{PRIMARY_SUBNET}@@"
SECONDARY_SUBNET_NAME="@@{SECONDARY_SUBNET}@@"

python ~/ntnx-escape-game/scripts/create-project.py --pcIp "$PCIP" --pcUser "$PCUSER" --pcPassword "$PCPASSWORD" --primarySubnetName "$PRIMARY_SUBNET_NAME" --secondarySubnetName "$SECONDARY_SUBNET_NAME"