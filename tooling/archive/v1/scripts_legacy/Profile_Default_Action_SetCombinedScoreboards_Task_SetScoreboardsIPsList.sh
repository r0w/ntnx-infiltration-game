#!/bin/bash

cd ntnx-escape-game

sed -i 's={COMBINEDSCOREBOARDS}=@@{SCOREBOARDSIPS}@@=' config.env
