#!/bin/bash

cd ntnx-escape-game
source .venv/bin/activate

export I=0

for EMAIL in `echo @@{RECIPIENTS}@@ | sed 's/,/ /g'`
do
    I=$(($I+1))
    echo "Emailing to $EMAIL, id $I"
    python mail.py $EMAIL "Mission Briefing - Escape Game" @@{Template}@@ $I
done

echo "Done"