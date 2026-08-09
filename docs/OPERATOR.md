# Operator guide

Everything you need to host a game at an event, a demo, or a training session.

The blueprint installs **one of two games**, picked on its launch screen. One
deployment runs one game: the install and the cluster it needs differ too much
to switch afterwards.

- **NCP** - the **Nutanix Infiltration Game**, 39 stages against Prism Central.
  That is the game this guide describes unless it says otherwise.
- **NKPFundamentals** - the **NKP Fundamentals bootcamp**, 26 stages against a
  Kubernetes fleet. See [the other game](#the-other-game-nkp-fundamentals).

To develop the game itself, see [`../README.md`](../README.md). For the blueprint internals, see [`../tooling/blueprint/README.md`](../tooling/blueprint/README.md).

## Quickstart

You need an HPoC and two files. About five minutes of clicks, then the install runs on its own.

1. **Book an HPoC** with the **AOS + PC Demo - Latest (7.5.x)** runbook (4 nodes, Flow and Leap enabled). On a fresh HPoC, enable **Intelligent Operations** once in Prism (Settings > Intelligent Operations); one stage needs it.
2. **Download the two assets** from the [latest release](https://github.com/r0w/ntnx-infiltration-game/releases/latest): `nig-00-runbook-prerequisites.json` and `nig-01-blueprint.json`.
3. **Run the runbook** (Self-Service > Runbooks): upload `nig-00...` and run it. It creates the AD endpoint the install needs. **Target project** must be the same project you import the blueprint into at step 4 - Calm endpoints are project-scoped, so the install can only find the endpoint from its own project. Leave it on `lab` unless your HPoC has no project by that name.
4. **Launch the blueprint** (Self-Service > Blueprints): upload `nig-01...`, set the `NUTANIX` credential to your PC admin password, then launch and fill the [short form](#the-launch-form). The install then runs on its own (30-40 min).
5. When the app reaches **`running`**, its description shows the URLs.

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

Booking with the **AOS + PC Demo - Latest (7.5.x)** runbook gives the tested versions (AOS 7.5, PC 7.5, Self-Service 4.3.1, Flow Networking + Security, Leap). Two things to know:

- **4 nodes**, no more, no less. The install removes one so stage 28 (expand-cluster) has a node to add back.
- **Intelligent Operations enabled.** The create-report stage checks against it. Fresh HPoCs ship it off; enable it in Prism. `/admin` shows a banner while it's off.
- **A cluster dedicated to the game.** The install reshapes it: removes a node, creates the production VMs, project and subnets.

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

## The other game: NKP Fundamentals

The same blueprint installs a second game, the **NKP Fundamentals bootcamp**. It
replays the [public bootcamp](https://bootcamps.nutanix.com/nkp-fundamentals/)
as a validated run: the learner carves out their own Project, gives WordPress
persistent storage on Nutanix Volumes and Files, and hands deployment over to
GitOps, and each step is checked against the real fleet before it advances.

Pick the **NKPFundamentals** profile on the launch screen. The form is shorter
than the NCP one, because there is no world to build:

| Field | Value |
|---|---|
| Prism Central IP / username / password | as for the other game |
| NKP bootstrap VM username / password | the `nkp-boot` VM; on an HPoC the password is the Prism Central one |
| NKP bootstrap VM IP | **optional** - leave blank and the install finds the VM named `nkp-boot` on Prism Central |
| NKP console URL | **optional** - leave blank and the game builds it from the management ingress address it reads off the fleet at boot |
| Run mode, Image tag, Container image repository, Time zone | as for the other game |

Prerequisites differ too:

- **A staged NKP fleet.** A management cluster plus `workload01` and
  `workload02`, both labelled `infraId: pc`, with the `nutanix-files`
  StorageClass and a MetalLB pool. That is what the bootcamp's own staging
  automation builds; the game does not build it.
- **Run the prerequisites runbook anyway.** Calm validates the whole blueprint
  and it carries both games, so without the AD endpoint the NCP profile's
  `Add AD users` task is invalid and *neither* profile can launch. The blueprint
  stays in DRAFT and the launch fails with an empty error list.
- **One kubeconfig opens the fleet.** The install fetches the management
  kubeconfig from `nkp-boot`; the workload clusters are read from the CAPI
  secrets on it.

What changes in `/admin`: learners are identified by their **user number**
rather than a trigram, the Pack tab shows 26 stages, and there is no `/ssh`
console (it belongs to the infiltration game). Wiping one learner's work is a
single call, `POST /api/act/cleanup-all/user01` - deleting their Project takes
the federated namespace and everything the labs put in it.

Known environment gap: on a shared bootcamp HPoC the learners' admin VMs ship
`kubectl` without a kubeconfig, so the optional terminal labs cannot be typed by
hand until someone generates one from the NKP console's workspace token page.
The bootcamp itself has no fetch step either - it assumes a staged terminal.

## Day-2 actions

The blueprint exposes two actions in Self-Service > Apps:

- **UpdateGame** pulls a newer game container image (set `IMAGE_TAG=vX.Y.Z` to pin, or `latest`) and restarts it. Sessions persist.
- **VerifyState** re-runs the install's final check to confirm the cluster is still in the expected shape.

## Reference

- Cluster pre-reqs from the original [`Golgautier/ntnx-escape-game`](https://github.com/Golgautier/ntnx-escape-game) apply as-is; the blueprint mirrors that runbook.
- Blueprint internals: [`../tooling/blueprint/README.md`](../tooling/blueprint/README.md).
- Stage list: [`STAGES.md`](./STAGES.md).
