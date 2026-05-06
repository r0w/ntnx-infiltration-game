#!/bin/bash

cd ntnx-escape-game
source .venv/bin/activate


for EMAIL in `echo @@{Game.RECIPIENTS_LIST}@@ | sed 's/,/ /g'`
do
    echo "Emailing to $EMAIL"
    python mail.py $EMAIL "Thank you for playing!" @@{Template}@@
done

echo "Done"