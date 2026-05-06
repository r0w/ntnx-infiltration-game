"""
Active blueprint — calm-dsl source, post-compile patcher.

Validated end-to-end on a live PC: 15 install tasks SUCCESS + 2 day-2
actions + game container UP at port 3000 with /api/health returning
status:ok + 39 stages.

Differences vs v2's manual JSON assembler (build_blueprint.py):

  - Authored natively in calm-dsl 4.3.1 — `calm compile bp` produces
    the JSON. The v2 patcher (`patch_escript.py`) runs post-compile to:
      1. Apply v2's `_patch_for_calm_escript` to every escript task
         (banned-import rewrites + UUID request-id helper + sleep-via-
         TCP-timeout). Calm 7.5 escript sandbox bans `sys`/`urllib3`/
         `time`/`json`; the patcher works around it without touching
         the source `scripts/*.py`.
      2. Retype the Game Content package CUSTOM → DEB. PC 7.5 auto-
         synthesizes lifecycle actions on CUSTOM packages with services
         attached, closing back-edges as 9 `Found cycles in tasks`
         errors that BLOCK launch. v2 hand-authored DEB; calm-dsl
         emits CUSTOM by default, so we patch.
      3. Grow the boot disk from 0 (image native ~10 GB on jammy
         cloudimg) to 40960 mib (40 GB). Required for Docker install +
         image pull; calm-dsl's `cloneFromVMDiskPackage()` doesn't
         expose a size param.

Install runbook = 15 tasks — full feature parity with v2's manifest.
`Activate policy engine` is **best-effort**: 5 min × 2 retries
(.10 → .11) and on failure it logs a loud warning + exits 0 so the
install runbook continues. On clusters with a healthy Policy VM
image, returns SUCCESS in ~30s (Calm deploys `auto_DND_calm_policy
_engine_*` at `<pc>.10`, services bind `:4202`). On clusters where
the Calm Policy VM image (`4.3.1-CalmPolicyVM.qcow2`) hits a
cloud-init bug (live-confirmed 2026-05-01: VM deploys ON but never
gets network configured, `:4202` never binds, Calm rolls back
`is_enabled`), ~10 min lost then warn-and-continue. Operator
activates manually via Prism UI Settings → Calm
(https://<pc>:9440/dm/settings/policy_enablement) when the upstream
image fix lands. Stage 21 (create-approval-policy) stays unplayable
on `hpoc` until then; gated when `CLUSTER_PROFILE=other`.

Push prereq BPs + Clone fake BPs are wired natively: the sh task pulls
`ntnx/calm-dsl:latest` docker on the deployed VM and runs `calm create
bp` from there, bypassing both Calm's `/import_file` API rejection of
.tgz and the escript sandbox. Same pattern as v2's `Push prereq BPs`
— generated at compile time from
`scripts/push_prereq_bps.sh.template` with the base64
.tgz blobs inlined.

Compile + patch:
    PATCH=1 ./compile.sh blueprint.py

Launch (headless):
    GHCR_TOKEN=<github_pat> ./.venv/bin/python launch.py
"""

import os

from calm.dsl.builtins import *  # noqa


# ── External endpoints ─────────────────────────────────────────────────

# AD endpoint — created by runbook_prerequisites.json. Verified to
# exist on PC at step 7.
AD = CalmEndpoint.use_existing("AD")


# ── Secrets ────────────────────────────────────────────────────────────

BP_CRED_NUTANIX_PASSWORD = read_local_file("BP_CRED_NUTANIX_PASSWORD")
Profile_PC_PASSWORD = read_local_file("Profile_Default_variable_PC_PASSWORD")
Profile_ADMIN_PASSWORD = read_local_file("Profile_Default_variable_ADMIN_PASSWORD")
Profile_GAME_PROD_PASSWORD = read_local_file("Profile_Default_variable_GAME_PROD_PASSWORD")
Profile_GAME_OLD_PC_PASSWORD = read_local_file("Profile_Default_variable_GAME_OLD_PC_PASSWORD")
Profile_GHCR_TOKEN = read_local_file("Profile_Default_variable_GIT_TOKEN")


# ── Cred (nutanix user, created by cloud_init_data.yaml) ──────────────
# Matches legacy ntnx-escape-game shape — Calm's `python_remote` venv
# path is `/home/<cred_user>/.calm/venv/`, dynamic on cred user, so
# `nutanix` works fine. The `bash: /home/ubuntu/...not found` we saw
# earlier was stale state from a deploy that briefly had cred=ubuntu.

BP_CRED_NUTANIX = basic_cred(
    "nutanix",
    BP_CRED_NUTANIX_PASSWORD,
    name="NUTANIX",
    type="PASSWORD",
    default=True,
)


# ── Image package ──────────────────────────────────────────────────────

Ubuntu2204 = vm_disk_package(
    name="Ubuntu2204",
    config={
        "name": "Ubuntu2204",
        "image": {
            "name": "Ubuntu2204",
            "type": "DISK_IMAGE",
            "source": "https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img",
            "architecture": "X86_64",
        },
        "product": {"name": "Ubuntu", "version": "22.04"},
        "checksum": {},
    },
)


# ── Service ────────────────────────────────────────────────────────────

class Game(Service):
    pass


# ── Substrate ──────────────────────────────────────────────────────────

class GameVMResources(AhvVmResources):
    memory = 8  # GiB — match v2 (4 was a hangover from the phase 2.5 spike)
    vCPUs = 4
    cores_per_vCPU = 1
    disks = [AhvVmDisk.Disk.Scsi.cloneFromVMDiskPackage(Ubuntu2204, bootable=True)]
    # Compile-time defaults — overridden at launch via runtime_editables
    # (substrate cluster_reference + first NIC subnet_reference, both
    # marked editable in specs/VM_create_spec_editables.yaml). The
    # operator picks the real cluster + subnet from the project's
    # whitelist on the Launch screen.
    nics = [AhvVmNic.NormalNic.ingress("primary", cluster="default")]
    guest_customization = AhvVmGC.CloudInit(
        filename=os.path.join("specs", "cloud_init_data.yaml")
    )
    power_state = "ON"
    boot_type = "UEFI"


class GameVM(AhvVm):
    name = "ntnx-infiltration-@@{calm_time}@@"
    resources = GameVMResources


class VM(Substrate):
    os_type = "Linux"
    provider_type = "AHV_VM"
    provider_spec = GameVM
    provider_spec_editables = read_spec(
        os.path.join("specs", "VM_create_spec_editables.yaml")
    )
    readiness_probe = readiness_probe(
        connection_type="SSH",
        disabled=False,
        retries="5",
        connection_port=22,
        address="@@{platform.status.resources.nic_list[0].ip_endpoint_list[0].ip}@@",
        delay_secs="60",
        credential=ref(BP_CRED_NUTANIX),
    )


# ── Package — single placeholder install task ──────────────────────────

class GameContent(Package):
    name = "Game Content"
    services = [ref(Game)]

    @action
    def __install__(type="system"):
        # **Best-effort:** PUTs is_enabled=true + polls the Policy VM
        # for ~10 min total (5 min × 2 retries on .10 then .11). The
        # script (`scripts/activate_policy_engine.py`) has BEST_EFFORT
        # =True, so when both retries fail it exits 0 with a loud
        # `[best-effort WARN]` line instead of FAILURE — the install
        # runbook continues. On clusters with a healthy Policy VM
        # image: SUCCESS in ~30s. On clusters where the cloud-init
        # bug hits the Policy VM (live-confirmed 2026-05-01: VM ON
        # but services never bind :4202, Calm rolls back is_enabled),
        # ~10 min wasted then warn-and-continue. Operator activates
        # manually via Prism UI Settings → Calm
        # (https://<pc>:9440/dm/settings/policy_enablement) when the
        # upstream image fix lands. Stage 21 (create-approval-policy)
        # stays unplayable on hpoc until then; gated when other.
        CalmTask.Exec.escript.py3(
            name="Activate policy engine",
            filename=os.path.join("scripts", "activate_policy_engine.py"),
            target=ref(Game),
        )
        # SET_VAR escript: captures CLUSTERNAME + CLUSTERUUID onto the
        # Profile vars. Cycle-fix shape: vars live on Profile (not
        # Service); SET_VAR target stays Service so Calm executes the
        # task — the eval-var-not-on-Service warning at validate time
        # is benign (the cycle is avoided because scripts read bare
        # `@@{X}@@`, not `@@{Game.X}@@`). See `cycle_check.py` spike.
        CalmTask.SetVariable.escript.py3(
            name="Get Cluster",
            filename=os.path.join("scripts", "get_cluster.py"),
            target=ref(Game),
            variables=["CLUSTERNAME", "CLUSTERUUID"],
        )
        # Idempotent: ensures `secondary` subnet is advanced-networking
        # + creates `TestNetwork` (used by stage 35 of the game).
        CalmTask.Exec.escript.py3(
            name="Setup subnets",
            filename=os.path.join("scripts", "setup_subnets.py"),
            target=ref(Game),
        )
        # SET_VAR: creates the `production` Calm project + ACP that
        # grants `thebadguy` Project Admin, captures ProjectUUID.
        CalmTask.SetVariable.escript.py3(
            name="Setup production project",
            filename=os.path.join("scripts", "setup_production_project.py"),
            target=ref(Game),
            variables=["ProjectUUID"],
        )
        # 3 stock approver users (charlie/thom/william) for stage 21.
        CalmTask.Exec.escript.py3(
            name="Create Local users",
            filename=os.path.join("scripts", "create_local_users.py"),
            target=ref(Game),
        )
        # Async LCM inventory scan — populates stage 29's update count.
        CalmTask.Exec.escript.py3(
            name="Trigger LCM inventory",
            filename=os.path.join("scripts", "trigger_lcm_inventory.py"),
            target=ref(Game),
        )
        # Calm endpoint named `jumphost` — used by CloneProd day-2.
        CalmTask.Exec.escript.py3(
            name="Setup jumphost endpoint",
            filename=os.path.join("scripts", "setup_jumphost_endpoint.py"),
            target=ref(Game),
        )
        # Read-only cluster probes (PC reachable, hosts NORMAL, free
        # chassis slot). Best-effort convergence check; the operator-
        # facing `Verify State` day-2 action below is the on-demand one.
        CalmTask.Exec.escript.py3(
            name="Verify final state",
            filename=os.path.join("scripts", "verify_state.py"),
            target=ref(Game),
        )
        # 7 hardcoded prod VMs in `production` project tagged
        # Environment=Production. Heavy v4 VMM POST — schema sensitive
        # to PC version (cf. memory project_calm_75_bp_rework, blind-
        # port to v4 schema validated 2026-05-01 on PC 7.5).
        CalmTask.Exec.escript.py3(
            name="Create Prod VMs",
            filename=os.path.join("scripts", "create_prod_vms.py"),
            target=ref(Game),
        )
        # PowerShell against the AD endpoint (creates `thebadguy` +
        # `theprojectmanager` AD users for stage 13). inherit_target=
        # False is critical — without it Calm inherits the substrate
        # os_type=Linux and rejects npsscript with "Linux os cannot
        # have script type as powershell". target=Game is the anchor;
        # target_endpoint=AD is where the script actually runs.
        CalmTask.Exec.powershell(
            name="Add AD users",
            filename=os.path.join("scripts", "add_ad_users.ps1"),
            target=ref(Game),
            target_endpoint=ref(AD),
            inherit_target=False,
        )
        # ssh on the deployed VM. install_docker.sh idempotent (skip-
        # if-installed). run_container.sh does docker login →
        # pull → run -d with PC + GAME_* env injected.
        CalmTask.Exec.ssh(
            name="Install Docker",
            filename=os.path.join("scripts", "install_docker.sh"),
            cred=ref(BP_CRED_NUTANIX),
            target=ref(Game),
        )
        CalmTask.Exec.ssh(
            name="Run game container",
            filename=os.path.join("scripts", "run_container.sh"),
            cred=ref(BP_CRED_NUTANIX),
            target=ref(Game),
        )
        # Push CloneProd + BlankVM-source prereq blueprints. v2's
        # working pattern (legacy ntnx-escape-game style): sh runs ON
        # THE VM (post Install Docker, no escript sandbox), decodes
        # base64-inlined .tgz blobs, sed-substitutes placeholders, and
        # uploads via `calm create bp` from a `ntnx/calm-dsl:latest`
        # docker container. Bypasses both Calm's /import_file API
        # (rejects raw .tgz) and the escript sandbox (can't run
        # calm-dsl). Idempotent: --force on each `calm create bp`.
        # The push_prereq_bps.sh file is generated at compile time
        # from `scripts/push_prereq_bps.sh.template`
        # by compile.sh (base64 blobs inlined into placeholders).
        CalmTask.Exec.ssh(
            name="Push prereq BPs",
            filename=os.path.join("scripts", "push_prereq_bps.sh"),
            cred=ref(BP_CRED_NUTANIX),
            target=ref(Game),
        )
        # 10 fake-named BPs (ApacheServer / Wordpress / PrimaryAD / …)
        # cloned from CloneProd via /api/nutanix/v3/blueprints/{uuid}/clone.
        # Pure immersion — surfaces a realistic Self-Service catalog on
        # PC for stage 35 narrative. Idempotent. Requires CloneProd to
        # exist on PC (so this task runs after Push prereq BPs).
        CalmTask.Exec.escript.py3(
            name="Clone fake BPs",
            filename=os.path.join("scripts", "clone_fake_bps.py"),
            target=ref(Game),
        )
        # DESTRUCTIVE — shrinks cluster from 4 → 3 nodes by removing
        # host-4. Idempotent (skip if no -4 host); gated by
        # CLUSTER_PROFILE in the script itself (early-exits if != hpoc).
        # ~16 min wall-clock real on NX-3060 per memory
        # project_bp_v2_zero_touch; 40 min cap in the script's polling
        # loop. Last task in the install runbook because it's the only
        # destructive one — keeps everything else idempotent and
        # re-runnable up to here.
        CalmTask.Exec.escript.py3(
            name="Ensure host 4 removed",
            filename=os.path.join("scripts", "remove_node.py"),
            target=ref(Game),
        )


# ── Deployment ─────────────────────────────────────────────────────────

class GameDeployment(Deployment):
    name = "GameDeployment"
    min_replicas = "1"
    max_replicas = "1"
    default_replicas = "1"
    packages = [ref(GameContent)]
    substrate = ref(VM)


# ── Profile — runtime + day-2 actions ─────────────────────────────────

class DefaultProfile(Profile):
    deployments = [GameDeployment]

    # Cycle fix: install-state vars on Profile (NOT Service). Set by
    # SET_VAR install tasks; read by downstream scripts as bare
    # `@@{CLUSTERNAME}@@` (no `Game.` prefix). PC emits a benign
    # "Eval variable not defined on the Service" warning at validate
    # time — non-blocking, the cycle is avoided.
    CLUSTERNAME = CalmVariable.Simple(
        "", is_mandatory=False, is_hidden=True, runtime=False,
    )
    CLUSTERUUID = CalmVariable.Simple(
        "", is_mandatory=False, is_hidden=True, runtime=False,
    )
    ProjectUUID = CalmVariable.Simple(
        "", is_mandatory=False, is_hidden=True, runtime=False,
    )

    # Runtime-visible vars — order here drives Prism UI launch-screen order.
    # 1. cluster profile
    CLUSTER_PROFILE = CalmVariable.WithOptions(
        ["hpoc", "other"], label="Cluster profile",
        default="hpoc", is_mandatory=True, runtime=True,
    )
    # 2. run mode
    MODE = CalmVariable.WithOptions(
        ["live", "test"], label="Run mode",
        default="live", is_mandatory=True, runtime=True,
    )
    # 3. time zone
    TIMEZONE = CalmVariable.WithOptions(
        [
            "UTC",
            "Europe/London",
            "Europe/Paris",
            "Europe/Zurich",
            "America/New_York",
            "America/Chicago",
            "America/Los_Angeles",
            "Asia/Tokyo",
            "Australia/Sydney",
        ],
        label="Time zone", default="UTC",
        is_mandatory=True, runtime=True,
    )
    # 4. prism central ip
    PC_IP = CalmVariable.Simple(
        "", label="Prism Central IP", is_mandatory=True, runtime=True,
    )
    # 5. prism central username
    PC_USERNAME = CalmVariable.Simple(
        "admin", label="Prism Central username", is_mandatory=True, runtime=True,
    )
    # 6. prism central password
    PC_PASSWORD = CalmVariable.Simple.Secret(
        Profile_PC_PASSWORD, label="Prism Central password",
        is_mandatory=True, runtime=True,
    )
    # 7. planner pc password
    GAME_OLD_PC_PASSWORD = CalmVariable.Simple.Secret(
        Profile_GAME_OLD_PC_PASSWORD, label="Planner PC password",
        is_mandatory=False, runtime=True,
    )
    # 8. ghcr.io token
    GHCR_TOKEN = CalmVariable.Simple.Secret(
        Profile_GHCR_TOKEN, label="ghcr.io token",
        is_mandatory=False, runtime=True,
    )
    # 9. image tag
    IMAGE_TAG = CalmVariable.Simple(
        "latest", label="Image tag",
        is_mandatory=True, runtime=True,
    )
    # 10. container image repo
    IMAGE_REPO = CalmVariable.Simple(
        "ghcr.io/r0w/ntnx-infiltration-game",
        label="Container image repository",
        is_mandatory=True, runtime=True,
    )

    # Hidden / non-runtime vars below — invisible on launch screen.
    # Pinned to add_ad_users.ps1's hardcoded `thebadguy` password —
    # changing this without also editing the .ps1 desyncs what the
    # game prompts the player with vs what AD actually accepts. Hidden
    # + non-runtime so operator can't drift them apart by accident.
    # Not a SECRET (despite the name) — the value is in committed .ps1
    # source code, and SECRET typing triggers PC's import passphrase
    # decrypt flow which fails on plaintext defaults.
    GAME_PROD_PASSWORD = CalmVariable.Simple(
        "MyPassword4Prod!",
        is_mandatory=False, runtime=False, is_hidden=True,
    )
    # Same pattern as GAME_PROD_PASSWORD: Simple (LOCAL) not Secret —
    # SECRET typing makes the patcher pop the value at compile, leaving
    # the container env with `ADMIN_PASSWORD=` and the game falls back
    # to nothing (config.ts uses `??` which doesn't trigger on empty).
    # Hidden so operator can't change it on the launch screen.
    ADMIN_PASSWORD = CalmVariable.Simple(
        "nutanix/4u",
        is_mandatory=False, runtime=False, is_hidden=True,
    )
    LOG_LEVEL = CalmVariable.WithOptions(
        ["debug", "info", "warn", "error"], label="Server log level",
        default="info", is_mandatory=False, runtime=False, is_hidden=True,
    )
    GAME_VLAN_ID = CalmVariable.Simple(
        "", is_mandatory=False, runtime=False, is_hidden=True,
    )
    GAME_PROD_USERNAME = CalmVariable.Simple(
        "thebadguy", is_mandatory=False, runtime=False, is_hidden=True,
    )
    GAME_OLD_PC = CalmVariable.Simple(
        "", is_mandatory=False, runtime=False, is_hidden=True,
    )
    GAME_OLD_PC_USERNAME = CalmVariable.Simple(
        "planner", is_mandatory=False, runtime=False, is_hidden=True,
    )
    GAME_EMAIL_REPORT = CalmVariable.Simple(
        "", is_mandatory=False, runtime=False, is_hidden=True,
    )
    GAME_FRONTEND_HOST = CalmVariable.Simple(
        "", is_mandatory=False, runtime=False, is_hidden=True,
    )
    GHCR_USERNAME = CalmVariable.Simple(
        "x-access-token", is_mandatory=False, runtime=False, is_hidden=True,
    )

    # Day-2 actions (Phase 2.7)
    @action
    def UpdateGame(name="Update Game"):
        """docker pull at IMAGE_TAG and restart the container."""
        CalmTask.Exec.ssh(
            name="docker pull and replace container",
            filename=os.path.join("scripts", "update_game.sh"),
            cred=ref(BP_CRED_NUTANIX),
            target=ref(Game),
        )

    @action
    def VerifyState(name="Verify State"):
        """Full convergence check: PC reachable, hosts NORMAL, free chassis slot."""
        CalmTask.Exec.escript.py3(
            name="Verify final state",
            filename=os.path.join("scripts", "verify_state.py"),
            target=ref(Game),
        )


class NtnxInfiltrationGame(Blueprint):
    """Nutanix Infiltration Game :

 - Game:       http://@@{VM.address}@@:3000/
 - Scoreboard: http://@@{VM.address}@@:3000/scoreboard
 - Admin:      http://@@{VM.address}@@:3000/admin
"""
    services = [Game]
    packages = [Ubuntu2204, GameContent]
    substrates = [VM]
    profiles = [DefaultProfile]
    credentials = [BP_CRED_NUTANIX]
