.PHONY: compile compile-legacy install upload upload-legacy clean

VENV := .venv
PY := $(VENV)/bin/python
CALM := $(VENV)/bin/calm

# Refresh the JSON artifact other people will upload via Prism Central UI.
# Runs offline once the calm cache is warm; needs PC reachable for first compile.
# Post-compile scrub for calm-dsl 4.3.1 → Calm 7.5.1 schema drift:
#   - metadata.owner_reference (Calm enforces owner_uuid == auth_user_uuid)
#   - spec.resources.global_variable_reference_list (unknown property on PC)
compile:
	$(PY) inject_prereq_tgz.py
	$(CALM) compile bp -f blueprint.py --out json > blueprint.json
	$(PY) postprocess_bp.py blueprint.json
	@echo "→ blueprint.json refreshed ($(shell wc -c < blueprint.json) bytes)"

compile-legacy:
	$(CALM) compile bp -f blueprint_legacy.py --out json > blueprint_legacy.json
	@echo "→ blueprint_legacy.json refreshed ($(shell wc -c < blueprint_legacy.json) bytes)"

# One-time setup: venv + ntnx-ncm-dsl from GitHub. Re-apply venv patches by hand
# after `pip install --upgrade` (see README — patches in calm/dsl/decompile/*).
install:
	/usr/bin/python3 -m venv $(VENV)
	$(VENV)/bin/pip install --upgrade pip
	$(VENV)/bin/pip install "git+https://github.com/nutanix/calm-dsl.git"
	@echo "→ run '.venv/bin/calm init dsl -i <PC_IP> -u admin -p <pw> -pj production' before compile"

# Upload the v2 blueprint to the configured PC (see ~/.calm/config.ini).
# Cache must be warm: `make sync-cache` if you changed PC.
upload: compile
	$(CALM) create bp --file blueprint.py --name ntnx-infiltration-game

upload-legacy: compile-legacy
	$(CALM) create bp --file blueprint_legacy.py --name EG-Blueprint-Installation

sync-cache:
	$(CALM) update cache

clean:
	rm -f blueprint.json blueprint_legacy.json
	rm -rf __pycache__
