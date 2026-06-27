"""
Active blueprint — calm-dsl source, post-compile patcher.

Validated end-to-end on a live PC: 15 install tasks SUCCESS + 2 day-2
actions + game container UP at port 3000 with /api/health returning
status:ok + 39 stages.

Differences vs v2's manual JSON assembler (build_blueprint.py):

  - Authored natively in calm-dsl 4.2.1 — `calm compile bp` produces
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
    ./.venv/bin/python launch.py
"""

import os

from calm.dsl.builtins import *  # noqa
from calm.dsl.builtins.models.action import parallel  # noqa
from calm.dsl.builtins.models.runbook import branch  # noqa


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
        # ─── Sequential prereq ─────────────────────────────────────────
        # Get Cluster captures CLUSTERUUID, which `Remove 4th host on
        # HPoC` needs to look up the host list. Everything else
        # (including Activate policy engine) lives in the parallel
        # block below. Get Cluster is fast (~5s API call), so paying
        # this single sequential tax doesn't meaningfully extend the
        # critical path.
        #
        # Cycle-fix shape: vars live on Profile (not Service); SET_VAR
        # target stays Service so Calm executes the task — the eval-
        # var-not-on-Service warning at validate time is benign (the
        # cycle is avoided because scripts read bare `@@{X}@@`, not
        # `@@{Game.X}@@`). See `cycle_check.py` spike.
        CalmTask.SetVariable.escript.py3(
            name="Get Cluster",
            filename=os.path.join("scripts", "get_cluster.py"),
            target=ref(Game),
            variables=["CLUSTERNAME", "CLUSTERUUID"],
        )

        # AD users (stage 13) — sequential, before the parallel block on
        # purpose: a bad AD credential fails this in ~30 s, before the
        # destructive node shrink, so it can't leave a half-shrunk cluster
        # (the old parallel placement did). Username must be UPN
        # (administrator@ntnxlab.local), not DOMAIN\user — WinRM Basic auth
        # rejects the NetBIOS form. inherit_target=False or Calm inherits
        # os_type=Linux and rejects the powershell script.
        CalmTask.Exec.powershell(
            name="Add AD users",
            filename=os.path.join("scripts", "add_ad_users.ps1"),
            target=ref(Game),
            target_endpoint=ref(AD),
            inherit_target=False,
        )

        # ─── Parallel branches ─────────────────────────────────────────
        # The long pole is Branch 1's node-remove (~16-40 min). Branch 2
        # (policy engine) starts in parallel but its first task gates on
        # host-4 leaving the scheduling pool (see Branch 2 below) so the
        # Policy VM is never placed on the node being removed; activation
        # then runs concurrently with the rest of the shrink. The shorter
        # branches (IAM/LCM) finish well before either. Branch 1 is the
        # critical path; the container chain sits at its tail so the deploy
        # is "done" only when the cluster has its final 3-node shape AND the
        # game URL is up. Branch 2's activation almost always finishes before
        # Branch 1 reaches its container tail, so by then the policy MSP is
        # up — stage 21 (create-approval-policy) plays without manual UI.
        with parallel() as p0:

            # Branch 1 — cluster prep + production world + container.
            # The destructive node-remove is the long pole (~16-40 min);
            # the container chain at the end runs only AFTER the
            # cluster is fully ready, so the deploy is "done" only when
            # the game URL is up AND the cluster shape is final.
            #
            # That's deliberate: stage 28 (`expand-cluster`) prompts
            # the player for a node serial that only exists once the
            # node has been freed by the shrink. If we exposed the game
            # URL before the shrink finished, players could reach stage
            # 28 prematurely and the in-game lookup would 404. Putting
            # the container at the end of Branch 1 guarantees that by
            # the time anyone can hit `http://<vm>:3000/`, the cluster
            # is in its final 3-node shape with a free chassis slot.
            #
            # Container chain (Install Docker → Push prereq BPs → Clone
            # fake BPs → Run game container) sits after Verify final
            # state so a verify failure never ships a game on a broken
            # cluster.
            with branch(p0):
                # DESTRUCTIVE — shrinks 4→3 nodes. Early in the branch
                # so the rest of it runs against the final cluster
                # shape. Idempotent (skip if no -4 host); gated by
                # CLUSTER_PROFILE inside the script (skips on `other`).
                CalmTask.Exec.escript.py3(
                    name="Remove 4th host on HPoC",
                    filename=os.path.join("scripts", "remove_node.py"),
                    target=ref(Game),
                )
                # Polls /clustermgmt/.../hosts until all NORMAL +
                # maintenanceState=normal. Necessary because the script
                # above only fires the remove-node API and exits — the
                # actual rebalance + reassign-on-host takes additional
                # minutes during which subsequent v4 VMM calls would
                # 503 / partial-fail.
                CalmTask.Exec.escript.py3(
                    name="Wait for cluster health",
                    filename=os.path.join("scripts", "cluster_health.py"),
                    target=ref(Game),
                )
                # Fire the async LCM inventory scan HERE — after the
                # node-removal has run and the cluster is back to NORMAL.
                # LCM and a cluster-shrink can't hold the cluster at the
                # same time, so firing it concurrently (the old Branch 5)
                # risked the two contending. We only need the scan to
                # populate stage 29's update list (we never apply the
                # updates), so there's no cost to deferring it to a
                # healthy cluster. Async: returns 202 + a task UUID and
                # runs in PC bg — the player won't reach stage 29 for
                # many minutes.
                CalmTask.Exec.escript.py3(
                    name="Trigger LCM inventory",
                    filename=os.path.join("scripts", "trigger_lcm_inventory.py"),
                    target=ref(Game),
                )
                # Idempotent: ensures `secondary` subnet is advanced-
                # networking + creates `TestNetwork` (used by stage 35
                # of the game).
                CalmTask.Exec.escript.py3(
                    name="Setup subnets",
                    filename=os.path.join("scripts", "setup_subnets.py"),
                    target=ref(Game),
                )
                # SET_VAR: creates the `production` Calm project + ACP
                # that grants `thebadguy` Project Admin, captures
                # ProjectUUID.
                CalmTask.SetVariable.escript.py3(
                    name="Setup production project",
                    filename=os.path.join("scripts", "setup_production_project.py"),
                    target=ref(Game),
                    variables=["ProjectUUID"],
                )
                # 7 hardcoded prod VMs in `production` project tagged
                # Environment=Production. Heavy v4 VMM POST — schema
                # sensitive to PC version (cf. memory
                # project_calm_75_bp_rework, blind-port to v4 schema
                # validated 2026-05-01 on PC 7.5).
                CalmTask.Exec.escript.py3(
                    name="Create Prod VMs",
                    filename=os.path.join("scripts", "create_prod_vms.py"),
                    target=ref(Game),
                )
                # Calm endpoint named `jumphost` — used by CloneProd
                # day-2 action.
                CalmTask.Exec.escript.py3(
                    name="Setup jumphost endpoint",
                    filename=os.path.join("scripts", "setup_jumphost_endpoint.py"),
                    target=ref(Game),
                )
                # ─── Game prereqs on the deployed VM ───────────────────
                # SSH on the Calm-provisioned VM. install_docker.sh
                # idempotent (skip-if-installed).
                CalmTask.Exec.ssh(
                    name="Install Docker",
                    filename=os.path.join("scripts", "install_docker.sh"),
                    cred=ref(BP_CRED_NUTANIX),
                    target=ref(Game),
                )
                # Push CloneProd + BlankVM-source via ntnx/calm-dsl
                # container (.tgz → .json → /api/nutanix/v3/blueprints).
                # Why a sh task on the VM (and not a Calm escript): PC
                # v3.x's /import_file endpoint rejects raw .tgz with
                # "Uploaded file is not valid json" (validated 2026-
                # 05-09). The ntnx/calm-dsl container does the .tgz →
                # JSON conversion locally before POSTing.
                #
                # The .sh writes ~/.calm/config.ini directly inside the
                # mounted volume instead of calling `calm init dsl`.
                # `init dsl` probes /api/calm/v3.0/features/approval_policy
                # at startup, which 30s-timeouts while the policy engine
                # MSP is still bootstrapping (cf memory
                # project_calm_policy_vm_unstable). `calm create bp`
                # itself doesn't probe approval_policy.
                CalmTask.Exec.ssh(
                    name="Push prereq BPs",
                    filename=os.path.join("scripts", "push_prereq_bps.sh"),
                    cred=ref(BP_CRED_NUTANIX),
                    target=ref(Game),
                )
                # 10 fake-named BPs (ApacheServer / Wordpress /
                # PrimaryAD / …) cloned from CloneProd via
                # /api/nutanix/v3/blueprints/{uuid}/clone. Pure
                # immersion — surfaces a realistic Self-Service catalog
                # on PC for stage 35 narrative. Idempotent. Requires
                # CloneProd to exist on PC.
                CalmTask.Exec.escript.py3(
                    name="Clone fake BPs",
                    filename=os.path.join("scripts", "clone_fake_bps.py"),
                    target=ref(Game),
                )
                # ─── Final-gate verify + game container ────────────────
                # Verify reads PC/cluster state (PC reachable, hosts
                # NORMAL, rackable-units endpoint responsive). Sits
                # right before Run game container so a verify failure
                # hard-stops the deploy — no game URL on a broken
                # cluster. The day-2 `VerifyState` action (below) runs
                # this same script on demand.
                CalmTask.Exec.escript.py3(
                    name="Verify final state",
                    filename=os.path.join("scripts", "verify_state.py"),
                    target=ref(Game),
                )
                # FINAL — game container deploy. docker login → pull →
                # run -d with PC + GAME_* env injected. The "deploy
                # done" signal: once this returns SUCCESS, the BP app
                # state flips to `running` and the operator hands out
                # http://<vm>:3000/ to players.
                CalmTask.Exec.ssh(
                    name="Run game container",
                    filename=os.path.join("scripts", "run_container.sh"),
                    cred=ref(BP_CRED_NUTANIX),
                    target=ref(Game),
                )

            # Branch 2 — Activate policy engine (~30s if already on,
            # up to ~10 min if MSP boot retries — see memory
            # project_calm_policy_vm_unstable). Best-effort: the
            # script exits 0 with a loud `[best-effort WARN]` if both
            # retries time out, so the install runbook keeps going.
            # Runs parallel-with-Branch-1 so the MSP has the full
            # ~16-40 min cluster-shrink window to come up; by the time
            # Branch 1 reaches `Run game container`, the policy engine
            # is up and stage 21 (create-approval-policy) is playable
            # without operator intervention.
            #
            # BUT: enabling the policy engine deploys a Calm Policy VM
            # whose host is chosen by AHV/ADS, not us. If it lands on
            # host-4 while Branch 1 is removing that node, the two
            # contend. So we gate activation on `Wait for node draining`
            # first: it blocks until host-4 has left the scheduling pool
            # (in_maintenance / TO_BE_REMOVED / gone), after which ADS
            # can only place the Policy VM on the surviving 3 nodes. The
            # gate returns immediately on non-hpoc / no-4th-host, so the
            # activation still kicks off promptly there and keeps
            # overlapping the (much longer) rebalance on hpoc.
            with branch(p0):
                CalmTask.Exec.escript.py3(
                    name="Wait for node draining",
                    filename=os.path.join("scripts", "wait_node_draining.py"),
                    target=ref(Game),
                )
                CalmTask.Exec.escript.py3(
                    name="Activate policy engine",
                    filename=os.path.join("scripts", "activate_policy_engine.py"),
                    target=ref(Game),
                )

            # Branch 3 — local IAM users (~30 s, independent of cluster
            # path). 3 stock approver users (charlie/thom/william) for
            # stage 21.
            with branch(p0):
                CalmTask.Exec.escript.py3(
                    name="Create Local users",
                    filename=os.path.join("scripts", "create_local_users.py"),
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

    # Runtime-visible vars. ⚠ Prism renders this list BOTTOM-TO-TOP on the
    # launch screen: the LAST var defined here shows up FIRST on screen. So
    # these are defined in REVERSE of the desired on-screen order.
    # Desired on-screen order (top→bottom):
    #   Container image repository, Image tag, Cluster profile, Run mode,
    #   Prism Central IP, Prism Central username, Prism Central password,
    #   Planner PC password, Time zone.
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
    GAME_OLD_PC_PASSWORD = CalmVariable.Simple.Secret(
        Profile_GAME_OLD_PC_PASSWORD, label="Planner PC password",
        description="For IOps on external cluster, ask game team",
        is_mandatory=False, runtime=True,
    )
    PC_PASSWORD = CalmVariable.Simple.Secret(
        Profile_PC_PASSWORD, label="Prism Central password",
        is_mandatory=True, runtime=True,
    )
    PC_USERNAME = CalmVariable.Simple(
        "admin", label="Prism Central username", is_mandatory=True, runtime=True,
    )
    PC_IP = CalmVariable.Simple(
        "", label="Prism Central IP", is_mandatory=True, runtime=True,
    )
    # `mock` intentionally omitted from the launch screen (nobody launches
    # the BP in mock); the SwitchMode day-2 can still set it.
    MODE = CalmVariable.WithOptions(
        ["test", "live"], label="Run mode",
        default="live", is_mandatory=True, runtime=True,
    )
    CLUSTER_PROFILE = CalmVariable.WithOptions(
        ["hpoc", "other"], label="Cluster profile",
        description="hpoc = remove 1 node if applicable; enable policy engine",
        default="hpoc", is_mandatory=True, runtime=True,
    )
    IMAGE_TAG = CalmVariable.Simple(
        "latest", label="Image tag",
        is_mandatory=True, runtime=True,
    )
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
    GAME_PROD_USERNAME = CalmVariable.Simple(
        "thebadguy", is_mandatory=False, runtime=False, is_hidden=True,
    )
    GAME_OLD_PC = CalmVariable.Simple(
        "10.55.82.39", is_mandatory=False, runtime=False, is_hidden=True,
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

    @action
    def SwitchMode(name="Switch Mode"):
        """Flip the running game between mock / test / live without a re-launch:
        rewrite MODE in the deployed .env and recreate the container via compose."""
        TARGET_MODE = CalmVariable.WithOptions(  # noqa: F841 — action input var
            ["mock", "test", "live"], label="Target mode",
            default="test", is_mandatory=True, runtime=True,
        )
        CalmTask.Exec.ssh(
            name="rewrite MODE and recreate container",
            filename=os.path.join("scripts", "switch_mode.sh"),
            cred=ref(BP_CRED_NUTANIX),
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
