#!/bin/bash

cd ntnx-escape-game/email_templates

FILES=$(ls -1 | paste -sd, -)

echo "TEMPLATES=$FILES"
