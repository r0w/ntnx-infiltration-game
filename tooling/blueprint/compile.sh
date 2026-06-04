#!/usr/bin/env bash
# Compile a calm-dsl blueprint Python file to JSON, then optionally apply
# the post-compile patcher (PATCH=1).
#
# Self-contained: venv lives at .venv (created by `make install` or
# inline below), seed_ci_cache + push_prereq_bps.sh.template + scripts/
# + prereqs/ all next to this file.
#
# Usage:
#   ./compile.sh blueprint.py            # → blueprint.json
#   PATCH=1 ./compile.sh blueprint.py    # → blueprint.json + blueprint.patched.json
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$SCRIPT_DIR/.venv"
SEED="$SCRIPT_DIR/seed_ci_cache.py"

if [[ ! -d "$VENV" ]]; then
  echo "venv missing — bootstrapping..."
  /usr/bin/python3 -m venv "$VENV"
  "$VENV/bin/pip" install --upgrade pip --quiet
  "$VENV/bin/pip" install ntnx-ncm-dsl==4.2.1 --quiet
fi

if [[ ! -f "$HOME/.calm/dsl.db" ]]; then
  echo "seeding ~/.calm/dsl.db with stub refs..."
  "$VENV/bin/calm" init dsl --ip 127.0.0.1 -P 9440 -u admin -p stub -pj production
  "$VENV/bin/python" "$SEED"
fi

# Generate scripts/push_prereq_bps.sh from the template + the
# CloneProd.tgz / NewblankVM.tgz blobs (base64-inlined). The
# `Push prereq BPs` install task references this file. Output is
# gitignored — regen each compile so blob updates propagate.
SCRIPT_DIR="$SCRIPT_DIR" "$VENV/bin/python" -c "
import base64, pathlib, os
HERE = pathlib.Path(os.environ['SCRIPT_DIR'])
template = (HERE / 'scripts' / 'push_prereq_bps.sh.template').read_text()
cp = base64.b64encode((HERE / 'prereqs' / 'CloneProd.tgz').read_bytes()).decode('ascii')
bv = base64.b64encode((HERE / 'prereqs' / 'NewblankVM.tgz').read_bytes()).decode('ascii')
out = template.replace('__CLONEPROD_TGZ_B64__', cp).replace('__BLANKVM_TGZ_B64__', bv)
(HERE / 'scripts' / 'push_prereq_bps.sh').write_text(out)
print(f'  generated push_prereq_bps.sh ({len(out)} chars)')

# Bundle specs/docker-compose.yml into run_container.sh (single source of
# truth for the compose shape; the install task references run_container.sh).
compose = (HERE / 'specs' / 'docker-compose.yml').read_text()
rc = (HERE / 'scripts' / 'run_container.sh.template').read_text()
rc = rc.replace('__COMPOSE_YML__', compose.rstrip(chr(10)))
(HERE / 'scripts' / 'run_container.sh').write_text(rc)
print(f'  generated run_container.sh ({len(rc)} chars)')
"

src="${1:-blueprint.py}"
out="${2:-${src%.py}.json}"

echo "compile: $src → $out"
"$VENV/bin/calm" compile bp -f "$src" --out json 2>/dev/null > "$out"
python3 -c "import json,sys;json.load(open('$out'))" && echo "valid JSON ($(wc -l < "$out") lines)"

if [[ "${PATCH:-0}" == "1" ]]; then
  python3 "$SCRIPT_DIR/patch_escript.py" "$out" "${out%.json}.patched.json"
fi
