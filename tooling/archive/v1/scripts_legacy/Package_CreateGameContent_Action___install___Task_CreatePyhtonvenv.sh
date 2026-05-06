#!/bin/bash

sudo apt update -y
sudo apt install git python3-pip python3-venv -y

mkdir -p /home/nutanix/.calm
cd /home/nutanix/.calm

python3 -m venv venv
