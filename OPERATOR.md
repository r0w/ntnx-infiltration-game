# Operator guide - host the game in 2 clicks

You want to run the **Nutanix Infiltration Game** at an event, demo, or
training session. This is the start-to-finish recipe: pre-reqs, upload,
launch, and how to run a live session.

If you only want to develop the game itself, see
[`README.md`](./README.md). If you only want to understand the
blueprint internals, see [`tooling/blueprint/README.md`](./tooling/blueprint/README.md).

## TL;DR

1. Book an HPoC matching the [Cluster prerequisites](#cluster-prerequisites).
2. Download the two release assets from
   [`releases/latest`](https://github.com/r0w/ntnx-infiltration-game/releases/latest):
   - `nig-00-runbook-prerequisites.json`
   - `nig-01-blueprint.json`
3. Upload + run the **runbook** in Prism Self-Service (creates the AD endpoint).
4. Upload + activate + launch the **blueprint** (deploys the game VM
   + 7 prod VMs + 12 prereq blueprints + game container).
5. Share the game URL (printed in the app description) with players.

Total operator time: **~5 minutes of clicks**, then 30-40 min of
unattended install runbook (the cluster shrink is the long pole; see
[Step 4](#step-4---upload--activate--launch-the-blueprint) for the
per-branch breakdown).

## Cluster prerequisites

Tested versions (do not deviate, the BP assumes these structurally):

| Component         | Version                              |
|-------------------|--------------------------------------|
| AOS               | 7.5                                  |
| PC                | 7.5                                  |
| Self-Service      | 4.3.1                                |
| Flow Networking   | enabled                              |
| Flow Security     | enabled                              |
| Leap (DR)         | enabled                              |

Cluster shape:

- **4 nodes** (no more, no less). The install runbook removes one
  node so stage 28 can have a node available to add back. Going below
  4 leaves stage 28 unplayable; going above leaves the cluster shrunk
  but stage 28 still works.
- **HPoC dedicated to this game** (`CLUSTER_PROFILE=hpoc`). Don't run
  on a shared cluster - the install creates 7 prod VMs, modifies
  subnets (`aux-1` → `secondary`, flips advanced-networking, creates
  `TestNetwork`), removes a node, and activates the policy engine.
  These are real changes you'll need to revert by hand otherwise.

  If you must use a shared cluster: launch with `CLUSTER_PROFILE=other`.
  The runbook then skips the destructive ops (host removal + policy
  engine activation), and the engine filters stages 21 and 28
  server-side. The other ops (subnet rename, project + users + VMs
  creation) still happen - they're additive but persistent. You'll
  need to clean them up manually after the event.

## Step 1 - Book the HPoC

Reserve via the standard Nutanix booking flow with the versions above.
Confirm the cluster shape (4 nodes, services enabled) before
proceeding.

## Step 2 - Download the release assets

```bash
gh release download --repo r0w/ntnx-infiltration-game --pattern 'nig-*'
```

Or grab them from the
[releases page](https://github.com/r0w/ntnx-infiltration-game/releases/latest)
in your browser. Two files:

- `nig-00-runbook-prerequisites.json`
- `nig-01-blueprint.json`

## Step 3 - Run the prerequisites runbook

In Prism Central:

1. Open **Self-Service > Runbooks**.
   Make sure you're in **Runbooks**, not **Blueprints** - uploading
   a runbook in the wrong section silently fails.
2. **Upload** `nig-00-runbook-prerequisites.json` into the **`default`**
   project.
3. **Run** the runbook. Takes ~30 seconds. Creates the `AD` endpoint
   the install BP needs at step 7.

## Step 4 - Upload + activate + launch the blueprint

In Prism Central:

1. Open **Self-Service > Blueprints**.
2. **Upload** `nig-01-blueprint.json`. Prism asks for a project - pick
   **`default`** (or any project that has at least one cluster + one
   subnet whitelisted; the install runbook creates its own
   `production` project for the game's prod VMs).
3. **Activate** the blueprint:
   - Click the **Credentials** button.
   - Update the `NUTANIX` credential with the Prism Central admin
     password (the cluster admin password set when you booked the HPoC).
   - Save.
4. **Launch** the blueprint. Fill the runtime form in this order:

| Field                                 | Value                                        |
|---------------------------------------|----------------------------------------------|
| Cluster profile                       | `hpoc` (or `other` if shared cluster)        |
| Run mode                              | `live` for an event / `test` for dry-runs    |
| Time zone                             | the event's local zone                       |
| Prism Central IP                      | your PC IP (no scheme, no port - e.g. `192.0.2.10`) |
| Prism Central username                | `admin`                                      |
| Prism Central password                | the PC admin password                        |
| Planner PC password                   | leave default (`REDACTED`)                |
| ghcr.io token                         | leave empty (only needed if the container image is in a private repo) |
| Image tag                             | `latest` (or a specific `vX.Y.Z`)            |
| Container image repository            | leave default                                |

The substrate section asks for the cluster + first NIC subnet (any
real ones on your HPoC). Submit.

5. Wait for the install runbook (~30-40 min worst case, gated on the
   `Ensure host 4 removed` task in the cluster branch — the destructive
   shrink is the long pole; the script polls up to 40 min for the host
   to drain + leave the metadata cluster). One sequential prereq, then
   5 branches in parallel. The deploy is "done" only when the cluster
   has its final 3-node shape AND the game container is up — the game
   URL never exposes prematurely.

   1. `Get Cluster` (sequential, ~5 s — captures CLUSTERNAME +
      CLUSTERUUID; the cluster branch needs CLUSTERUUID to look up
      hosts).

   - **Cluster + container branch** (~30-40 min, **longest** — gates
     the deploy). Three logical phases, all sequential within the
     branch: (a) **setup cluster** (`Ensure host 4 removed` →
     `Wait for cluster health` → `Setup subnets` →
     `Setup production project` → `Create Prod VMs` →
     `Setup jumphost endpoint`); (b) **setup game prereqs**
     (`Install Docker` → `Push prereq BPs` → `Clone fake BPs`);
     (c) **verify + launch** (`Verify final state` →
     `Run game container`). Verify sits right before `Run game
     container` so the game never exposes on a broken cluster — a
     verify failure hard-stops the deploy.
   - **Policy branch** (~30 s up to ~10 min worst case): `Activate
     policy engine`. Best-effort — runs in parallel with the cluster
     branch so the policy MSP has the full ~30-40 min cluster-shrink
     window to come up; by the time `Run game container` fires, stage
     21 (in-game create-approval-policy) is playable.
   - **Local IAM branch** (~30 s): `Create Local users`.
   - **AD branch** (~30 s): `Add AD users`.
   - **LCM branch** (~5 s API call): `Trigger LCM inventory`.

   The 4 short branches finish within the first ~30 s; the cluster
   branch dominates wall-clock end-to-end. App state flips to
   `running` (and the game URL appears in the description field) the
   moment `Run game container` returns SUCCESS at the tail of the
   cluster branch.

When the app reaches **`running`** state, the description field shows
the game URL: `http://<deployed-vm-ip>:3000/`.

## Step 5 - Run the session

Share with players:

- **Game URL**: `http://<vm>:3000/` - each player picks a 3-letter
  trigram, sets a PIN, and starts.
- **Scoreboard URL**: `http://<vm>:3000/scoreboard` - display this on
  a screen, refreshes live.
- **Admin URL**: `http://<vm>:3000/admin` - operator dashboard
  (default password `nutanix/4u`).

Players need:

- Internet access (they'll fetch from `dl.ntnxlab.com` for one stage).
- A modern browser.
- The Prism Central URL + credentials you set up above. Hand them out
  on a card / slide / chat.

## Recovery scenarios

**Player gets stuck on a check that should pass** - the check may have
captured an ID that no longer exists (e.g. they deleted + recreated a
VM). Tell them to refresh the page; the engine puts them in recovery
mode and replays from the last passed stage.

**A stage check is broken** - operator can mark the stage `inactive`
in `/admin > Pack`. Disabled stages are skipped; the player advances
straight to the next one.

**The install task `Activate policy engine` warned out best-effort** -
the cluster's Policy VM image is broken (cloud-init drop on this AHV
build). Stage 21 (`create-approval-policy`) won't be playable until
you activate the policy engine manually via Prism Central → Settings
→ Calm. Mark stage 21 `inactive` in `/admin` if you don't want to wait.

**A player wants to restart from scratch** - `/admin > Sessions`,
delete their session. Cluster resources they created (VM, project
membership, etc.) stay but they can re-run the stages with the same
trigram (idempotent acts re-create or skip).

**The HPoC expires mid-session** - sorry, no migration story today.
Players' captured variables live in the game container's SQLite DB on
the deployed VM; if the VM survives, sessions resume. If the cluster
dies, you redeploy fresh and players restart from stage 1.

## Day-2 actions

The blueprint exposes 2 day-2 actions in **Self-Service > Apps**:

- **UpdateGame**: pull a newer game container image (set
  `IMAGE_TAG=v0.x.y` to pin, or `latest`) and restart it. Sessions in
  the SQLite DB persist; players resume where they left off.
- **VerifyState**: re-runs the `Verify final state` install task to
  confirm the cluster is still in the expected shape (4 → 3 nodes, 7
  prod VMs, project + users present, etc.).

## What you don't need to do

- **No SSH into the VM**. cloud-init creates a `nutanix` user with
  sudo + a Calm `python_remote` venv at `/home/nutanix/.calm/venv/`
  - both ready before the install runbook fires. SSH is there if you
  want to debug, but the install is fully zero-touch.
- **No manual upload of `CloneProd.tgz` or `NewblankVM.tgz`**. The
  install runbook's `Push prereq BPs` task runs on the deployed VM
  (post-`Install Docker`), pulls a `ntnx/calm-dsl` Docker container,
  decodes the base64-inlined `.tgz` blobs from the install script, and
  uses calm-dsl to compile + upload them via Calm's API. Idempotent
  via `--force`.
- **No subnet pre-creation**. The runbook renames `aux-1` →
  `secondary`, flips it to advanced-networking, and creates
  `TestNetwork` (`192.168.1.0/25`). Pre-creating these is fine
  (idempotent skip), but not required.

## Troubleshooting

When in doubt, **upgrade to the latest release** before deploying - most known issues are already fixed in newer tags. If a problem persists, file a bug at [the project's issues page](https://github.com/r0w/ntnx-infiltration-game/issues) with the failing install task name, the task output, and the release tag you deployed.

## When the event ends

If you used a dedicated HPoC, just release it back into the booking pool - nothing to clean up.

If you used a shared cluster (`CLUSTER_PROFILE=other`), cluster-side artifacts will need manual removal: the deployed game app (Self-Service → Apps → delete), the `production` project + its users + the 7 prod VMs, the prereq BPs (`CloneProd`, `BlankVM-source`), and the `secondary` subnet rename + `TestNetwork` creation. There is no automated teardown today.

## Reference

- Cluster pre-reqs from the original [`Golgautier/ntnx-escape-game`](https://github.com/Golgautier/ntnx-escape-game)
  apply 1:1; the BP mirrors that runbook.
- Blueprint internals: [`tooling/blueprint/README.md`](./tooling/blueprint/README.md).
- Stage list: [`docs/STAGES.md`](./docs/STAGES.md).
