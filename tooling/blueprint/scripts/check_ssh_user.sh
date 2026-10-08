#!/bin/bash
set -euo pipefail

expected_user='@@{NUTANIX.username}@@'
actual_user="$(id -un)"
printf '[SSH] configured user: %s; connected user: %s\n' "$expected_user" "$actual_user"
if [[ "$actual_user" != "$expected_user" ]]; then
    echo '[FAIL] SSH user does not match the NUTANIX credential. Check the guest account and cloud-init configuration.' >&2
    exit 1
fi
