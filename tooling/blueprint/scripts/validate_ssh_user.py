#script
import re
import sys

username = '@@{NUTANIX.username}@@'
if not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", username) or username == "root":
    print("[FAIL] NUTANIX username must be a non-root Linux account: 1-32 lowercase letters, digits, underscores or hyphens, starting with a letter or underscore.")
    sys.exit(1)
print("[info] VM SSH user: %s (NUTANIX credential, cloud-init and Check Login)" % username)
print("[info] If Check Login fails, verify this account exists in the guest and inspect cloud-init status from the VM console.")
