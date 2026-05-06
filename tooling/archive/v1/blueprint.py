"""
Calm DSL blueprint v2 — deploys ntnx-infiltration-game on a Calm-managed VM.

What this does, in order, on a fresh Ubuntu 24.04 VM:
  1. Activate the Calm policy engine on the cluster (one-shot, idempotent).
  2. Resolve the AOS cluster UUID + name (CLUSTERUUID / CLUSTERNAME vars).
  3. git clone the infiltration-game repo on the requested branch.
  4. curl-install Bun into ~/.bun.
  5. `bun install` deps (~/ntnx-infiltration-game/node_modules).
  6. Write .env from blueprint variables (PC creds, GAME_* defaults, MODE).
  7. Remove the `*-4` host from the chassis (chassis prereq for stage 28
     `expand-cluster`). Idempotent: skips if no -4 found.
  8. Poll `/clustermgmt/v4.0/.../hosts` until the cluster is stable
     (replaces the legacy 15-min flat sleep). Cap 20 min.
  9. Wait 30 s for the new node-removed state to settle on the OS side.
 10. Install + start the systemd service `ntnx-infiltration-game`.

Day-2 actions:
  - UpdateGame: git pull + bun install + systemctl restart.

What this does NOT do (vs the legacy ntnx-escape-game blueprint):
  - No CreateProdVMs / CreateProject / CreateLocalusers / Add AD users /
    Migrate-secondary-subnet / CreateJumphost / CreatefakeBPs /
    Initializegame / Get-emails / Init-Calm-DSL / Push-BP / etc.
    Those operations are now driven by the running app (auto-play +
    /admin) against the live PC, on demand by the operator.
  - No Docker registry pull. Bun runs the app directly from source.

Compile to JSON for distribution:
    .venv/bin/calm compile bp -f blueprint.py --out json > blueprint.json
"""

import os

from calm.dsl.builtins import *  # noqa
from calm.dsl.builtins import CalmTask as CalmVarTask  # noqa
from calm.dsl.builtins.models.action import parallel  # noqa
from calm.dsl.builtins.models.runbook import branch  # noqa
from calm.dsl.runbooks import CalmEndpoint as Endpoint  # noqa


# ── External endpoints (created by runbook_prerequisites.json) ─────────
# `AD` = the Active Directory endpoint the game's stage 13 ("verify
# isolation") relies on. The blueprint's `Add AD users` task creates
# `thebadguy` + `theprojectmanager` AD users via PowerShell against this
# endpoint. Operator must upload + run runbook_prerequisites.json once
# per fresh PC before launching this blueprint.
AD = Endpoint.use_existing("AD")


# ── Secret placeholders (gitignored .local/ files) ─────────────────────

BP_CRED_NUTANIX_PASSWORD = read_local_file("BP_CRED_NUTANIX_PASSWORD")
Profile_Default_variable_PC_PASSWORD = read_local_file(
    "Profile_Default_variable_PC_PASSWORD"
)
Profile_Default_variable_ADMIN_PASSWORD = read_local_file(
    "Profile_Default_variable_ADMIN_PASSWORD"
)
Profile_Default_variable_GAME_PROD_PASSWORD = read_local_file(
    "Profile_Default_variable_GAME_PROD_PASSWORD"
)
Profile_Default_variable_GAME_OLD_PC_PASSWORD = read_local_file(
    "Profile_Default_variable_GAME_OLD_PC_PASSWORD"
)
Profile_Default_variable_GIT_TOKEN = read_local_file(
    "Profile_Default_variable_GIT_TOKEN"
)  # legacy file name kept; the var below maps it to GHCR_TOKEN


# ── Credentials ────────────────────────────────────────────────────────

BP_CRED_NUTANIX = basic_cred(
    "nutanix",
    BP_CRED_NUTANIX_PASSWORD,
    name="NUTANIX",
    type="PASSWORD",
    default=True,
)


# ── VM image package ───────────────────────────────────────────────────

Ubuntu2404 = vm_disk_package(
    name="Ubuntu2404",
    config={
        "name": "Ubuntu2404",
        "image": {
            "name": "Ubuntu2404",
            "type": "DISK_IMAGE",
            "source": "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img",
            "architecture": "X86_64",
        },
        "product": {"name": "Ubuntu", "version": "24.04"},
        "checksum": {},
    },
)


# ── Service ────────────────────────────────────────────────────────────


class Game(Service):
    # Hidden vars set by install tasks. Declared on the service so that
    # downstream tasks can reference them as @@{Game.<NAME>}@@ — Calm
    # 7.5.1 rejects macro refs to vars that aren't on the targeted
    # service ("Eval variable X not defined on the Service").
    CLUSTERNAME = CalmVariable.Simple(
        "", is_mandatory=False, is_hidden=True, runtime=False
    )
    CLUSTERUUID = CalmVariable.Simple(
        "", is_mandatory=False, is_hidden=True, runtime=False
    )
    ProjectUUID = CalmVariable.Simple(
        "", is_mandatory=False, is_hidden=True, runtime=False
    )

    # PC 7.5 server-side auto-wires package.install into empty service
    # lifecycle actions and emits a synthesized task "Game - Package
    # Install" (with literal " - " hyphen) — its own validator then
    # rejects the hyphen ("Only unicode characters, underscores(_) and
    # spaces are allowed") AND mistargets powershell tasks (Add AD users)
    # to the Linux service ("Linux os cannot have script type as
    # powershell"). Confirmed empirically 2026-04-28: dropping these
    # markers reintroduced both errors. Populating __create__/__start__
    # with at least one explicit task suppresses the broken auto-wiring.
    # NOTE: this does NOT fix the separate "Found cycles in tasks"
    # error on Package/Profile/Deployment × Create/Delete/SoftDelete —
    # that's a distinct issue tracked separately.
    @action
    def __create__():
        CalmTask.Exec.ssh(
            name="Game create marker",
            script=":",
            cred=ref(BP_CRED_NUTANIX),
        )

    @action
    def __start__():
        CalmTask.Exec.ssh(
            name="Game start marker",
            script="sudo docker start ntnx-infiltration-game >/dev/null 2>&1 || :",
            cred=ref(BP_CRED_NUTANIX),
        )

    # Symmetric to __create__/__start__: when __stop__/__delete__/
    # __soft_delete__ are empty, PC 7.5 auto-wires package.uninstall
    # into them and synthesizes a "Game - Package Uninstall" task
    # (literal " - " hyphen) which fails the same name validator.
    # Confirmed empirically 2026-04-28 on Application Profile Create.
    @action
    def __stop__():
        CalmTask.Exec.ssh(
            name="Game stop marker",
            script="sudo docker stop ntnx-infiltration-game >/dev/null 2>&1 || :",
            cred=ref(BP_CRED_NUTANIX),
        )

    @action
    def __delete__():
        CalmTask.Exec.ssh(
            name="Game delete marker",
            script="sudo docker rm -f ntnx-infiltration-game >/dev/null 2>&1 || :",
            cred=ref(BP_CRED_NUTANIX),
        )

    @action
    def __soft_delete__():
        CalmTask.Exec.ssh(
            name="Game soft delete marker",
            script=":",
            cred=ref(BP_CRED_NUTANIX),
        )


# ── Substrate (the VM Calm provisions) ─────────────────────────────────


class GameVMResources(AhvVmResources):
    memory = 8
    vCPUs = 4
    cores_per_vCPU = 1
    disks = [AhvVmDisk.Disk.Scsi.cloneFromVMDiskPackage(Ubuntu2404, bootable=True)]
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


# ── Package: install chain (10 tasks instead of 28) ────────────────────


class InfiltrationGame(Package):
    name = "Infiltration Game"
    services = [ref(Game)]

    @action
    def __install__(type="system"):

        # Sequential prereqs — both branches downstream depend on these.
        CalmTask.Exec.escript.py3(
            name="Activate policy engine",
            filename=os.path.join("scripts", "activate_policy_engine.py"),
            target=ref(Game),
        )

        CalmTask.SetVariable.escript.py3(
            name="Get Cluster",
            filename=os.path.join("scripts", "get_cluster.py"),
            target=ref(Game),
            variables=["CLUSTERNAME", "CLUSTERUUID"],
        )

        # Six parallel branches — fan out everything that doesn't depend on
        # the cluster path. cluster_health is the bottleneck (up to 20 min);
        # the smaller branches finish well before it. `Verify final state`
        # sits at the end of the cluster branch (the longest in practice),
        # so by the time it runs the others are usually done too.
        #
        # Why not a real convergence verify task after the parallel block?
        # `calm.dsl 4.3.1` rejects tasks-after-parallel in runbooks. The
        # day-2 `VerifyState` action below is the operator-driven full
        # convergence check; this in-install Verify is best-effort.
        with parallel() as p0:

            # Branch 1 — cluster prep + production world (longest, ~10 min)
            with branch(p0):
                CalmTask.Exec.escript.py3(
                    name="Ensure host 4 removed",
                    filename=os.path.join("scripts", "remove_node.py"),
                    target=ref(Game),
                )
                CalmTask.Exec.escript.py3(
                    name="Wait for cluster health",
                    filename=os.path.join("scripts", "cluster_health.py"),
                    target=ref(Game),
                )
                CalmTask.Exec.escript.py3(
                    name="Setup subnets",
                    filename=os.path.join("scripts", "setup_subnets.py"),
                    target=ref(Game),
                )
                CalmTask.SetVariable.escript.py3(
                    name="Setup production project",
                    filename=os.path.join("scripts", "setup_production_project.py"),
                    target=ref(Game),
                    variables=["ProjectUUID"],
                )
                CalmTask.Exec.escript.py3(
                    name="Create Prod VMs",
                    filename=os.path.join("scripts", "create_prod_vms.py"),
                    target=ref(Game),
                )
                CalmTask.Exec.escript.py3(
                    name="Setup jumphost endpoint",
                    filename=os.path.join("scripts", "setup_jumphost_endpoint.py"),
                    target=ref(Game),
                )
                CalmTask.Exec.escript.py3(
                    name="Verify final state",
                    filename=os.path.join("scripts", "verify_state.py"),
                    target=ref(Game),
                )

            # Branch 2 — local IAM users (~30 s, independent of cluster path)
            with branch(p0):
                CalmTask.Exec.escript.py3(
                    name="Create local users",
                    filename=os.path.join("scripts", "create_local_users.py"),
                    target=ref(Game),
                )

            # Branch 3 — AD users on the AD endpoint (~30 s)
            with branch(p0):
                CalmTask.Exec.powershell(
                    name="Add AD users",
                    filename=os.path.join("scripts", "add_ad_users.ps1"),
                    # Mirror the legacy ntnx-escape-game shape exactly,
                    # since that BP imports cleanly on 7.5. All three
                    # fields matter: target_any_local_reference=Game
                    # (gives the validator a service to anchor the task
                    # to), exec_target_reference=AD (where the script
                    # actually runs at runtime), inherit_target=False
                    # (tells Calm not to inherit the substrate's
                    # os_type=Linux, which would reject npsscript).
                    target=ref(Game),
                    target_endpoint=ref(AD),
                    inherit_target=False,
                )

            # Branch 4 — upload prereq BPs (CloneProd + BlankVM-source) +
            # clone the 10 immersion BPs from CloneProd. Sequential within
            # the branch because Clone fake BPs needs CloneProd to be
            # uploaded first.
            #
            # Branch 4 has an *internal* dependency on Branch 1's
            # ProjectUUID (Setup production project). Calm DSL 4.3.1 can't
            # express cross-branch waits in a single parallel block, so the
            # upload escript polls for the BP existence as part of its
            # idempotent skip path: if CloneProd already exists (or can't
            # be created because the project doesn't exist yet), the next
            # task warn-skips and the operator re-fires this branch as a
            # day-2 action if needed. In practice Branch 1 takes ~10 min
            # (cluster_health) so the project is ready way before this
            # branch starts heavy work.
            with branch(p0):
                CalmTask.Exec.escript.py3(
                    name="Upload prereq BPs",
                    filename=os.path.join("scripts", "upload_prereq_bps.py"),
                    target=ref(Game),
                )
                CalmTask.Exec.escript.py3(
                    name="Clone fake BPs",
                    filename=os.path.join("scripts", "clone_fake_bps.py"),
                    target=ref(Game),
                )

            # Branch 5 — fire async LCM inventory scan (~5 s, runs in PC bg)
            with branch(p0):
                CalmTask.Exec.escript.py3(
                    name="Trigger LCM inventory",
                    filename=os.path.join("scripts", "trigger_lcm_inventory.py"),
                    target=ref(Game),
                )

            # Branch 6 — Docker container deploy on the Calm-provisioned VM
            # (~3 min: get.docker.com curl + image pull + container boot)
            with branch(p0):
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


# ── Profile (runtime variables + day-2 actions) ────────────────────────


class GameDeployment(Deployment):
    min_replicas = "1"
    max_replicas = "1"
    default_replicas = "1"
    packages = [ref(InfiltrationGame)]
    substrate = ref(VM)


class Default(Profile):
    deployments = [GameDeployment]

    # ─── Required at launch (operator must fill) ───
    PC_IP = CalmVariable.Simple(
        "",
        label="Prism Central IP",
        is_mandatory=True,
        runtime=True,
    )
    PC_USERNAME = CalmVariable.Simple(
        "admin",
        label="Prism Central admin user",
        is_mandatory=True,
        runtime=True,
    )
    PC_PASSWORD = CalmVariable.Simple.Secret(
        Profile_Default_variable_PC_PASSWORD,
        label="Prism Central admin password",
        is_mandatory=True,
        runtime=True,
    )

    # ─── Game image (released to ghcr.io by .github/workflows/release.yml) ───
    IMAGE_REPO = CalmVariable.Simple(
        "ghcr.io/r0w/ntnx-infiltration-game",
        label="Container image repository",
        is_mandatory=True,
        runtime=True,
        description="Full registry path of the released image. Override only if "
        "you mirror the image somewhere else.",
    )
    IMAGE_TAG = CalmVariable.Simple(
        "latest",
        label="Image tag",
        is_mandatory=True,
        runtime=True,
        description="Docker tag to pull. Pin to a specific 'vX.Y.Z' for "
        "reproducible deploys, or use 'latest' to track main.",
    )
    GHCR_USERNAME = CalmVariable.Simple(
        "x-access-token",
        label="ghcr.io username",
        is_mandatory=False,
        runtime=True,
        description="Username used by `docker login ghcr.io`. The default "
        "'x-access-token' works with both classic PATs and fine-grained "
        "tokens; you can also use your GitHub username if you prefer.",
    )
    GHCR_TOKEN = CalmVariable.Simple.Secret(
        Profile_Default_variable_GIT_TOKEN,
        label="ghcr.io access token (leave empty when the image is public)",
        is_mandatory=False,
        runtime=True,
        description="GitHub PAT or fine-grained token with `read:packages` "
        "scope, used by `docker login ghcr.io`. Required while the repo is "
        "private; can be cleared once the repo / package is public.",
    )

    CLUSTER_PROFILE = CalmVariable.WithOptions(
        ["other", "hpoc"],
        label="Cluster profile (controls destructive actions)",
        default="other",
        is_mandatory=True,
        runtime=True,
        description=(
            "Whether destructive stages run during install + during gameplay. "
            "Choose 'hpoc' only if you've reserved this HPoC for the event; "
            "destructives = blueprint node-remove + game stages 21 (approval-"
            "policy, cluster-wide toggle) and 28 (expand-cluster). Choose "
            "'other' on a community / shared / unknown cluster — those stages "
            "are skipped but the rest of the game plays through normally. "
            "Default 'other' is fail-safe."
        ),
    )

    # ─── App config (runtime, sensible defaults) ───
    ADMIN_PASSWORD = CalmVariable.Simple.Secret(
        Profile_Default_variable_ADMIN_PASSWORD,
        label="Game /admin page password",
        is_mandatory=False,
        runtime=True,
        description="Default 'nutanix/4u' if unchanged.",
    )
    MODE = CalmVariable.WithOptions(
        ["live", "test", "mock"],
        label="Run mode",
        default="live",
        is_mandatory=True,
        runtime=True,
        description="`live` for prod demos (dev tools hidden), "
        "`test` for operator-driven runs (DevPanel + auto-play visible), "
        "`mock` for offline dev.",
    )
    LOG_LEVEL = CalmVariable.WithOptions(
        ["debug", "info", "warn", "error"],
        label="Server log level",
        default="info",
        is_mandatory=False,
        runtime=True,
    )
    TIMEZONE = CalmVariable.WithOptions(
        [
            "UTC",
            "Europe/Paris",
            "Europe/London",
            "America/New_York",
            "America/Los_Angeles",
            "America/Sao_Paulo",
            "Asia/Dubai",
            "Asia/Tokyo",
            "Australia/Sydney",
        ],
        label="Time zone",
        default="UTC",
        is_mandatory=True,
        runtime=True,
    )

    # ─── Hidden defaults (game scenario) ───
    GAME_VLAN_ID = CalmVariable.Simple(
        "",
        label="VLAN id pinned for all sessions ('' = randomized 0-249 per session)",
        is_mandatory=False,
        is_hidden=True,
        runtime=False,
    )
    GAME_PROD_USERNAME = CalmVariable.Simple(
        "thebadguy",
        is_mandatory=False,
        is_hidden=True,
        runtime=False,
    )
    GAME_PROD_PASSWORD = CalmVariable.Simple.Secret(
        Profile_Default_variable_GAME_PROD_PASSWORD,
        is_mandatory=False,
        is_hidden=True,
        runtime=False,
    )
    GAME_OLD_PC = CalmVariable.Simple(
        "",
        is_mandatory=False,
        is_hidden=True,
        runtime=False,
    )
    GAME_OLD_PC_USERNAME = CalmVariable.Simple(
        "planner",
        is_mandatory=False,
        is_hidden=True,
        runtime=False,
    )
    GAME_OLD_PC_PASSWORD = CalmVariable.Simple.Secret(
        Profile_Default_variable_GAME_OLD_PC_PASSWORD,
        is_mandatory=False,
        is_hidden=True,
        runtime=False,
    )
    GAME_EMAIL_REPORT = CalmVariable.Simple(
        "-secret-message@ntnxlab.com",
        label="Email recipient suffix used in stage 27 (gets prefixed with the player's trigram)",
        is_mandatory=False,
        is_hidden=True,
        runtime=False,
    )
    GAME_FRONTEND_HOST = CalmVariable.Simple(
        "",
        label="Stage 19 microseg target host (empty in dev/test = no VPN-exposed laptop)",
        is_mandatory=False,
        is_hidden=True,
        runtime=False,
    )

    @action
    def UpdateGame(name="Update Game"):
        """Pull the image at IMAGE_TAG and replace the running container."""
        CalmTask.Exec.ssh(
            name="docker pull and replace container",
            filename=os.path.join("scripts", "update_game.sh"),
            cred=ref(BP_CRED_NUTANIX),
            target=ref(Game),
        )

    @action
    def VerifyState(name="Verify State"):
        """Full convergence check on demand: PC reachable, all hosts NORMAL,
        chassis has a free slot for stage 28 expand-cluster."""
        CalmTask.Exec.escript.py3(
            name="Verify final state",
            filename=os.path.join("scripts", "verify_state.py"),
            target=ref(Game),
        )


# ── Blueprint root ─────────────────────────────────────────────────────


class NtnxInfiltrationGame(Blueprint):
    """Deploys ntnx-infiltration-game on a Calm-managed VM.

    Once deployed, the app exposes:
     - Game:       http://@@{VM.address}@@:3000
     - Scoreboard: http://@@{VM.address}@@:3000/scoreboard
     - Admin:      http://@@{VM.address}@@:3000/admin

    The Calm Self-Service app summary will substitute @@{VM.address}@@ with
    the provisioned VM's IP, turning these into clickable links.

    Stage 28 expand-cluster expects the chassis to have a free slot — the
    install task `Remove 1 host` ensures one is freed before the player
    reaches that stage (gated by CLUSTER_PROFILE — runs only when 'hpoc').
    """

    services = [Game]
    packages = [Ubuntu2404, InfiltrationGame]
    substrates = [VM]
    profiles = [Default]
    credentials = [BP_CRED_NUTANIX]
