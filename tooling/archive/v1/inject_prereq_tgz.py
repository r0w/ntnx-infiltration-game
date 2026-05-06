"""
Inject base64-encoded prereq blueprint .tgz blobs into the upload escript
template, producing the final `scripts/upload_prereq_bps.py` that the BP
install action references.

Called before `calm compile bp` — both in CI (`.github/workflows/release.yml`
compile-blueprint job) and via `make compile` locally.

Reads:
  - tooling/blueprint/scripts/upload_prereq_bps.py.template
  - tooling/blueprint/prereqs/CloneProd.tgz
  - tooling/blueprint/prereqs/NewblankVM.tgz

Writes:
  - tooling/blueprint/scripts/upload_prereq_bps.py  (gitignored generated file)
"""

import base64
import pathlib
import sys

ROOT = pathlib.Path(__file__).parent

template = (ROOT / "scripts" / "upload_prereq_bps.py.template").read_text()
cloneprod = base64.b64encode((ROOT / "prereqs" / "CloneProd.tgz").read_bytes()).decode()
blankvm = base64.b64encode((ROOT / "prereqs" / "NewblankVM.tgz").read_bytes()).decode()

filled = (template
    .replace("__CLONEPROD_TGZ_B64__", cloneprod)
    .replace("__BLANKVM_TGZ_B64__", blankvm))

out = ROOT / "scripts" / "upload_prereq_bps.py"
out.write_text(filled)

print(f"[ok] wrote {out} "
      f"(template {len(template)} chars + cloneprod {len(cloneprod)} b64 + "
      f"blankvm {len(blankvm)} b64 = {len(filled)} chars)")
