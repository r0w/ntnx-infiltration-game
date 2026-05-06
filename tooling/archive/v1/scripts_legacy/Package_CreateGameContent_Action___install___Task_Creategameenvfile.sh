#!/bin/bash

cd ntnx-escape-game

cp config.env.template config.env

sed -i 's/{PC}/@@{PC_IP}@@/' config.env
sed -i 's/{PCUSER}/@@{PC_USERNAME}@@/' config.env
sed -i 's={PCPASSWORD}=@@{PC_PASSWORD}@@=' config.env
sed -i 's={IMAGEURL}=https://cloud-images.ubuntu.com/daily/server/jammy/current/jammy-server-cloudimg-amd64.img=' config.env
sed -i 's/{PRODUSERNAME}/thebadguy/' config.env
sed -i 's/{PRODPASSWORD}/MyPassword4Prod!/' config.env
sed -i 's/{OLDPC}/@@{OLDPC}@@/' config.env
sed -i 's/{OLDPCUSERNAME}/@@{OLDPC_USER}@@/' config.env
sed -i 's/{OLDPCPASSWORD}/@@{PLANNER_PASSWORD}@@/' config.env
sed -i 's/{FRONTENDHOST}/@@{VM.address}@@/' config.env
sed -i 's/{FRONTENDPORT}/8080/' config.env
sed -i 's/{EMAILREPORT}/-secret-message@ntnxlab.com/' config.env
sed -i 's/{HOSTSSHUSERNAME}/@@{NUTANIX.username}@@/' config.env
sed -i 's={HOSTSSHPASSWORD}=@@{NUTANIX.secret}@@=' config.env
sed -i 's/{PLAYERSSHUSERNAME}/@@{PLAYER.username}@@/' config.env
sed -i 's={PLAYERSSHPASSWORD}=@@{PLAYER.secret}@@=' config.env
sed -i 's={DOCKERREGISTRY}=@@{DockerRegistry}@@=' config.env
sed -i 's={COMBINEDSCOREBOARDS}=@@{VM.address}@@=' config.env
