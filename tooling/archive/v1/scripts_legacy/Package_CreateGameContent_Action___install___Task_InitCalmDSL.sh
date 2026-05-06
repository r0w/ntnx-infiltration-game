#!/bin/bash

mkdir dockervolume

sudo docker run  -v /home/nutanix/dockervolume:/root/.calm -it @@{DockerRegistry}@@/ntnx/calm-dsl mkdir -p /root/.calm/

sudo docker run  -v /home/nutanix/dockervolume:/root/.calm @@{DockerRegistry}@@/ntnx/calm-dsl calm init dsl --ip @@{PC_IP}@@ --username @@{PC_USERNAME}@@ --password '@@{PC_PASSWORD}@@' --port 9440 -pj "production"