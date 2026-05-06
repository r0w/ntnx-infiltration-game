#!/bin/bash -x

# This script will update some patterns in email and conf file regarding the configuration.
# - {LISTEN_IP} in htlm files, and email templates
# - {PASSWORD} in the email templates
# - {CLUSTER} in the email template
# - {PARALLEL_URL} in the email templates
# - {SENDER_EMAIL} in the mail.py file
#
# and create sendgrid.env with good token

cd ntnx-escape-game 

source .venv/bin/activate

# Prepare ssh fronted
sed -i "s/{LISTEN_IP}/@@{VM.address}@@/" frontend/templates/*.html

# Create services
sed -i "s/{LISTEN_IP}/@@{VM.address}@@/" daemons/eg-sshserver.service
sudo cp daemons/eg* /etc/systemd/system/

# Update email templates
sed -i "s/{LISTEN_IP}/@@{VM.address}@@/" email_templates/*

# Update email templates
sed -i "s/{PASSWORD}/@@{PC_PASSWORD}@@/" email_templates/*

# Define VDI parrallel url
SITE=`echo "@@{CLUSTERNAME}@@" | cut -c1-3 | tr A-Z a-z`

PARALLEL_URL="https://${SITE}-ras.hpoc.nutanix.com"

# Update email templates

sed -i "s#{PARALLEL_URL}#$PARALLEL_URL#" email_templates/*
sed -i "s#{CLUSTER}#@@{CLUSTERNAME}@@#" email_templates/*

# Update mail.py file
sed -i "s#{MAIL_TOKEN}#@@{EMAILTOKEN}@@#" mail.py

sudo systemctl daemon-reload

# 'Clean' the game
python3 main.py -clean

# Cache Node Serial Number
python3 main.py -cacheNodeSerial