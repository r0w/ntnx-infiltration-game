# Operator guide

Everything you need to host the **Nutanix Infiltration Game** at an event, a demo, or a training session.

To develop the game itself, see [`../README.md`](../README.md). For the blueprint internals, see [`../tooling/blueprint/README.md`](../tooling/blueprint/README.md).

## Quickstart

You need an HPoC and two files. About five minutes of clicks, then the install runs on its own.

1. **Book an HPoC** with **AOS + PC Demo - Latest** (4 nodes, Flow and Leap enabled). Enable **Intelligent Operations** in Prism if it is off; one game stage needs it.
2. **Download the two assets** from the [latest release](https://github.com/r0w/ntnx-infiltration-game/releases/latest): `nig-00-runbook-prerequisites.json` and `nig-01-blueprint.json`.
3. **Check the Self-Service project.** If there is no suitable project, [create one first](#create-the-self-service-project). Fresh HPOCs provisioned after the runbook's update to 7.6 may have no default `lab` project.
4. **Run the runbook** (Self-Service > Runbooks): upload `nig-00...` into that project and run it. Set **Target project** to the same project name. It creates the AD endpoint needed by installation.
5. **Launch the blueprint** (Self-Service > Blueprints): upload `nig-01...` into the same project, set the `NUTANIX` credential to your PC admin password, then fill the [launch form](#the-launch-form). Choose the cluster's primary subnet for the game VM.
6. When the app reaches **`running`**, its description shows the URLs. For `hpoc`, also check that [Policy Engine activation completed](#policy-engine-is-still-activating) before starting approval-policy stages.

Then share three links:

- **Players:** `http://<vm>:3000/`
- **Scoreboard:** `http://<vm>:3000/scoreboard` (put it on a screen)
- **You:** `http://<vm>:3000/admin` (the console below)

Players also need the Prism Central URL and credentials you deployed with, and a browser with internet access.

## The operator console

Everything runs from `http://<vm>:3000/admin`. Default password **`nutanix/4u`**; change it with **`ADMIN_PASSWORD`**. It's a light guard for a trusted room, not real security.

- **Agents** (Users tab): the live roster. Anyone failing a check floats to the top with a chip saying exactly what's wrong, so you can help. Per player: **skip stage** and **delete**.

  ![The Agents tab, with stuck players sorted to the top](screenshots/admin-users.png)

  ![Clicking a stuck player's chip shows the exact check failure and how to fix it](screenshots/admin-users-help.png)

- **Gates**: hold the whole room at a chosen stage until you press **unlock**. Pick which stages gate on the Pack tab.
- **Lunch lock**: one header button parks everyone on a "back soon" screen. **Resume** when you return.
- **Disable a stage** (Pack tab): flip a stage off and players skip it, live, no redeploy.
- **See the run** (Pack tab): the strip along the top is tonight's mission in play order, one cell per stage, coloured by what that stage will do (playable, gated, skipped by this cluster, off, broken). Click a cell to jump to its row, or click a count below the strip to list just those stages.
- **Share a setup** (Pack tab): **export config** gives you one string holding every on/off and gate choice. Paste it into another instance's **import config** to reproduce the same setup, or **reset to defaults** to undo an afternoon of toggling. Import replaces the setup rather than merging into it, and tells you about any stage the two game versions don't share.
- **Multi-cluster scoreboard** (Scoreboard tab): add other instances' URLs to merge everyone into one leaderboard.
- **Emails** (Emails tab): send invitations and lab summaries via Mailtrap, once per participant.

## Detailed operator

### Cluster prerequisites

The **AOS + PC Demo - Latest** runbook has moved from the 7.5 stack to 7.6. Deployments have been tested with PC/AOS 7.5 and Self-Service 4.3.1, and PC 7.6.0.6, AOS 7.6, AHV 11.2 and Self-Service 4.4.0.1. The game requires Flow Networking/Security, Advanced networking and Leap. Check the provisioned versions rather than relying only on the booking label.

- **4 nodes**, no more, no less. The install removes one so stage 28 (expand-cluster) has a node to add back.
- **Intelligent Operations enabled.** The create-report stage checks against it. Fresh HPoCs ship it off; enable it in Prism. `/admin` shows a banner while it's off.
- **A cluster dedicated to the game.** The install reshapes it: removes a node, creates the production VMs, project and subnets.

### Create the Self-Service project

Both the runbook and blueprint need a project before import. On two fresh HPOCs provisioned after **AOS + PC Demo - Latest** moved to 7.6, there was no default project. This concerns fresh provisioning; it does not mean upgrading deletes existing projects.

Create a project with a Prism Central administrator who can manage Self-Service projects:

1. On PC 7.6, open **Admin Center > Projects > Create Project**. From Infrastructure, **Administration > Projects > Manage Projects in Admin Center** reaches the same page. Enter **Project Name** (`lab` is a convenient default) and click **Create**. Older versions expose project management in Self-Service.
2. Open the project’s **Infrastructure** tab, click **Add Infrastructure**, and select **NTNX_LOCAL_AZ** under **System Provider Accounts**. Click **Configure Resources** and select the target AHV cluster.
3. Click **Select VLANs**, select the existing **primary** subnet, then **Next**. Under **Confirm and Select Default**, select it as the default VLAN and click **Confirm**. Its name may be `primary-<cluster-name>`. It needs working IPAM/DHCP and connectivity for the game VM.
4. Click **Save** on the project. Give the deployment user the appropriate role under **Identities & Access** if another user will launch the game. Wait until the project is active before importing anything.
5. Import the prerequisites runbook into this project and set **Target project** to its exact name. Use the AD username in UPN format, for example `administrator@ntnxlab.local`. Check that the runbook succeeds and the **AD** endpoint appears in that project.
6. Import the game blueprint into the same project. Endpoints are project-scoped; a blueprint in another project cannot use this AD endpoint.

The project does not have to be named `lab` in v1.1.0. With v1.0.4 and earlier, use **`lab`**, which those runbooks require. The **production** project and **TestNetwork** are created later by installation; do not select them for this initial setup.

### Policy Engine is still activating

On `hpoc`, a successful installation task can include a **best-effort warning**: the game can start while Policy Engine is not yet ready. The approval-policy stages require successful activation.

Open Prism Central > Settings > Calm (`/dm/settings/policy_enablement`). If the image is still downloading, let that activation finish. The installer monitors downloads separately from service startup and does not start another download, delete the Policy VM or change its IP when a polling limit is reached. Confirm the UI shows activation complete; API validation must also confirm `is_enabled=true` and, when present, state `COMPLETED`.

If activation reports an error, inspect its task details before retrying in Prism. A slow download does not call for another IP address.

### VM creation says the migrated subnet was not found

A Basic-to-Advanced migration can report `COMPLETED` while VM creation still fails with **subnet not found** (`VMM-30604`). The installer retries confirmed temporary failures a limited number of times. It stops if the network remains unusable and keeps Advanced mode, which the game needs.

During one recovery, editing only the migrated subnet's description and saving it was followed by successful VM creation on the same subnet. The original description was then restored; its UUID, VLAN and IPAM settings were preserved. This is a tested workaround on one deployment, not a confirmed root cause or universal repair.

If retries are exhausted, inspect the failed VM creation task and the subnet in Prism. If using that workaround, record the original description and network settings, change only the description, wait for the update task to succeed, and restore the description. Do not delete the network, recreate it, or downgrade it to Basic. Resume the failed installation task after checking its outcome. Existing matching production VMs will have their project and power configuration completed.

If the installer reports an **unknown outcome**, first check the original task and VM inventory. A lost response does not mean creation failed; blindly creating another VM can produce duplicates.

### The launch form

Click **Credentials** and set the `NUTANIX` credential to your PC admin password, then fill the runtime form:

| Field | Value |
|---|---|
| Cluster profile | `hpoc` (the default - a dedicated HPoC) |
| Run mode | `live` for an event, `test` for dry-runs |
| Time zone | the event's local zone |
| Prism Central IP | your PC IP, no scheme or port (e.g. `192.0.2.10`) |
| Prism Central username | `admin` |
| Prism Central password | the PC admin password |
| Planner PC password | leave the pre-filled default (ask the game team if empty) |
| ghcr.io token | leave empty (only for a private image repo) |
| Image tag | `latest` (or a specific `vX.Y.Z`) |
| Container image repository | leave default |

The substrate section asks for the cluster and first NIC subnet (any real ones on your HPoC). Submit.

### Run modes

- **`live`** - the event mode: real cluster, dev tools hidden from players.
- **`test`** - same, but dev tools shown and auto-play can fire the acts for you. Good for a dry run.
- **`mock`** - no cluster, fixtures back every stage. The local dev mode; you won't deploy in it.

## Day-2 actions

The blueprint exposes two actions in Self-Service > Apps:

- **UpdateGame** pulls a newer game container image (set `IMAGE_TAG=vX.Y.Z` to pin, or `latest`) and restarts it. Sessions persist.
- **VerifyState** re-runs the install's final check to confirm the cluster is still in the expected shape.

## Reference

- Cluster pre-reqs from the original [`Golgautier/ntnx-escape-game`](https://github.com/Golgautier/ntnx-escape-game) apply as-is; the blueprint mirrors that runbook.
- Blueprint internals: [`../tooling/blueprint/README.md`](../tooling/blueprint/README.md).
- Stage list: [`STAGES.md`](./STAGES.md).
