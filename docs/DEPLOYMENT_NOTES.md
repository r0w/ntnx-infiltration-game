# Deployment reference

Optional deployment variants and troubleshooting. For the normal HPoC installation, follow the [operator guide](OPERATOR.md).

## Shared clusters and existing installations

Compile `blueprint.shared.patched.json` from the branch being deployed, using the command below. This blueprint keeps both game profiles and installs only a new game VM. Use a unique application/blueprint name, an existing Self-Service project, and a subnet with available addresses. Pin the image tag to the tested build.

**Do not run the prerequisites runbook for this variant.** It has no AD endpoint dependency. NCP installs Docker and starts the game; NKP also retrieves the management kubeconfig. Neither install changes cluster networking, storage, users, existing VMs, projects, endpoints or prerequisite blueprints. VM/image provisioning and creation of the new Self-Service application still occur. NCP is restricted to the `other` cluster profile; its cluster-oriented `Verify State` action is omitted. `Update Game` and `Switch Mode` remain available.

NCP's game prerequisites must already exist. This installs the server, not a fresh training world. Gameplay and operator auto-play can still mutate cluster resources; deployment-only does not make those actions read-only. See the [complete mutation review](BLUEPRINT_CLUSTER_CHANGES.md).

To compile locally without replacing the full-install artifact:

```bash
cd tooling/blueprint
NIG_DEPLOYMENT_ONLY=1 PATCH=1 ./compile.sh blueprint.py
```

The full blueprint with NCP `other` is **not** equivalent: it still prepares networks, users, production VMs and shared Self-Service resources.

## Create the Self-Service project

Both the runbook and blueprint need a project before import.

Create a project with a Prism Central administrator who can manage Self-Service projects:

1. Create the project in **Admin Center > Projects** (also reachable from Self-Service > Projects). Enter **Project Name** (`lab` is a convenient default) and click **Create**.
2. Open the project’s **Infrastructure** tab, click **Add Infrastructure**, and select **NTNX_LOCAL_AZ** under **System Provider Accounts**. Click **Configure Resources** and select the target AHV cluster.
3. Click **Select VLANs**, select the existing **primary** subnet, then **Next**. Under **Confirm and Select Default**, select it as the default VLAN and click **Confirm**. Its name may be `primary-<cluster-name>`. It needs working IPAM/DHCP and connectivity for the game VM.
4. Click **Save** on the project. Give the deployment user the appropriate role under **Identities & Access** if another user will launch the game. Wait until the project is active before importing anything.
5. Import the prerequisites runbook into this project and set **Target project** to its exact name. Use the AD username in UPN format, for example `administrator@ntnxlab.local`. Check that the runbook succeeds and the **AD** endpoint appears in that project.
6. Import the game blueprint into the same project. Endpoints are project-scoped; a blueprint in another project cannot use this AD endpoint.

The project does not have to be named `lab` in v1.1.0. With v1.0.4 and earlier, use **`lab`**, which those runbooks require. The **production** project and **TestNetwork** are created later by installation; do not select them for this initial setup.

## Policy Engine is still activating

On `hpoc`, a successful installation task can include a **best-effort warning**: the game can start while Policy Engine is not yet ready. The approval-policy stages require successful activation.

Open Prism Central > Settings > Calm (`/dm/settings/policy_enablement`). If the image is still downloading, let that activation finish. The installer monitors downloads separately from service startup and does not start another download, delete the Policy VM or change its IP when a polling limit is reached. Confirm the UI shows activation complete; API validation must also confirm `is_enabled=true` and, when present, state `COMPLETED`.

If activation reports an error, inspect its task details before retrying in Prism. A slow download does not call for another IP address.

## VM creation says the migrated subnet was not found

A Basic-to-Advanced migration can report `COMPLETED` while VM creation still fails with **subnet not found** (`VMM-30604`). The installer retries confirmed temporary failures a limited number of times. It stops if the network remains unusable and keeps Advanced mode, which the game needs.

During one recovery, editing only the migrated subnet's description and saving it was followed by successful VM creation on the same subnet. The original description was then restored; its UUID, VLAN and IPAM settings were preserved. This is a tested workaround on one deployment, not a confirmed root cause or universal repair.

If retries are exhausted, inspect the failed VM creation task and the subnet in Prism. If using that workaround, record the original description and network settings, change only the description, wait for the update task to succeed, and restore the description. Do not delete the network, recreate it, or downgrade it to Basic. Resume the failed installation task after checking its outcome. Existing matching production VMs will have their project and power configuration completed.

If the installer reports an **unknown outcome**, first check the original task and VM inventory. A lost response does not mean creation failed; blindly creating another VM can produce duplicates.

## Choosing the secondary network

At blueprint launch, **Secondary network name** (`GAME_SECONDARY_NETWORK`) selects the existing routable VLAN used by production VMs and by players for projects and their VM's second NIC. Player instructions in every language and auto-play use the same setting. The game VM's own NIC is still selected separately on the launch screen; `TestNetwork` remains the external network for CloneProd.

For `hpoc`, the dropdown selects `secondary` automatically. For `other`, choose one of the cluster’s internal VLANs. Changing the cluster profile refreshes the list; returning to `hpoc` restores `secondary`.

The default `secondary` also accepts `secondary-<cluster>` (case-insensitive). An exact match wins; if multiple suffixed networks match, enter the full name. With the default only, the installer can rename `aux-1` to `secondary` when needed. A custom name must already exist and matches exactly, ignoring case. A missing or ambiguous network stops setup instead of selecting another VLAN.

The selected VLAN must support Advanced networking for microsegmentation. The installer migrates it if necessary, and stops if migration fails. Changing its name does not bypass that cluster requirement.

For Docker deployments, set `GAME_SECONDARY_NETWORK` in `.env` and recreate the container. Choose the network before installation: changing this setting on an existing game does not move previously created VMs or update their projects.
