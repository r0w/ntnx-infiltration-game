#!/bin/bash

echo "Cloning repository..."
echo "Branch : @@{GIT_BRANCH}@@"
echo "URL : @@{GIT_URL}@@"

#git clone https://@@{TOKEN}@@@github.com/Golgautier/ntnx-escape-game.git
git clone --depth 1 --branch "@@{GIT_BRANCH}@@" "@@{GIT_URL}@@"