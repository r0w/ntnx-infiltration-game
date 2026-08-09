# Stage map

The repo ships two games. Each is a directory under `packs/`, and one
deployment runs one of them (`GAME_PACK`, set from the blueprint's launch
screen). This page maps both, in play order.

- [`ntnx-infiltration`](#ntnx-infiltration--39-stages) - the NCP infiltration game, 39 stages against Prism Central.
- [`nkp-bootcamp`](#nkp-bootcamp--26-stages) - the NKP Fundamentals bootcamp, 26 stages against a Kubernetes fleet.

**Conventions:**
- `order` is the position in `pack.json.stages[]` (1-indexed reading order). Reordering a stage means moving its name in that array; existing sessions stay attached to the name, not the position.
- `name` is the canonical identifier (kebab-case). It is the field used everywhere: filename `<name>.json`, SQLite columns (`stage_name`), API payload, `pack.json.stages[]`, logs, DevPanel.
- `check.fn` is the check function registered in the pack's `checks/index.ts`. A dash means the stage is narrative or input-only (no validation against the cluster).
- `dependsOn` names the earlier stages whose *cluster state* this one consumes (not its variables - that is `needs`). Turning one of them off in `/admin` cascades the disable down to here.

## `ntnx-infiltration` - 39 stages

| order | `name` | `check.fn` | `dependsOn` |
|---|---|---|---|
| 1 | `lore` | - | - |
| 2 | `login` | CheckTrigram | - |
| 3 | `recovery-gate` | NeedRecovery | - |
| 4 | `intro-tank-greet` | - | - |
| 5 | `intro-mission` | - | - |
| 6 | `create-admin-user` | CheckUser | - |
| 7 | `create-auth-policy` | CheckAuthPolicy | `create-admin-user` |
| 8 | `switch-to-admin-user` | - | `create-admin-user`, `create-auth-policy` |
| 9 | `create-project` | CheckProject | - |
| 10 | `create-subnet` | CheckNetwork | - |
| 11 | `add-ubuntu-image` | CheckImage | - |
| 12 | `create-vm` | CheckVM | `create-project`, `create-subnet`, `add-ubuntu-image` |
| 13 | `verify-prod-user-isolation` | - | `create-vm` |
| 14 | `live-migrate-vm` | CheckLiveMigration | `create-vm` |
| 15 | `create-category` | CheckCat | - |
| 16 | `apply-category-to-vm` | CheckCatVM | `create-category`, `create-vm` |
| 17 | `create-storage-policy` | CheckStoragePolicy | - |
| 18 | `create-microseg-policy` | CheckSecurityPolicy | `create-category` |
| 19 | `allow-ssh-in-microseg` | CheckSecurityPolicy2 | `create-microseg-policy` |
| 20 | `create-protection-policy` | CheckProtectionPolicy | `create-category` |
| 21 | `create-approval-policy` | CheckApprovalPolicy | `create-protection-policy` |
| 22 | `verify-protection-secure` | - | `create-protection-policy`, `create-approval-policy` |
| 23 | `incident-freeze` | - | `create-vm` |
| 24 | `incident-reconnect` | - | - |
| 25 | `welcome-back` | - | - |
| 26 | `restore-vm-from-recovery` | CheckRestoreVM | `create-vm`, `verify-prod-user-isolation`, `incident-freeze` |
| 27 | `create-report` | CheckReport | - |
| 28 | `expand-cluster` | CheckNewNode | - |
| 29 | `lcm-check-updates` | CheckUpdates | - |
| 30 | `security-dashboard` | - | - |
| 31 | `capacity-runway` | CheckRunway | - |
| 32 | `resource-optimization` | - | - |
| 33 | `create-ncm-playbook` | CheckPlaybook | - |
| 34 | `test-ncm-playbook` | - | `create-ncm-playbook`, `create-vm` |
| 35 | `clone-app-blueprint` | CheckCloneApp | - |
| 36 | `schedule-day2-action` | CheckSchedDay2 | `clone-app-blueprint` |
| 37 | `modify-blueprint` | CheckUpdateBP | - |
| 38 | `mission-complete` | - | - |
| 39 | `outro-cleanup` | - | - |

25 check functions cover IAM, projects, networking, VM lifecycle, categories, policies (storage / microseg / protection / approval), reports, NCM X-Play, and Self-Service blueprints. The other 14 stages are narrative beats (intro, incident interlude, mission outro) or input-only prompts.


## `nkp-bootcamp` - 26 stages

A port of the public [NKP Fundamentals bootcamp](https://bootcamps.nutanix.com/nkp-fundamentals/), so the play order is the source material's chapter order rather than a story: Fundamentals (1-12), Observability (13-16), Automation (17-20), Conclusion (20), then Optional Labs (21-26), which the run reaches but nobody has to finish. The reading menu down the side of the terminal is `pack.json.nav`, and it must stay in this order.

Checks read Kubernetes (`ctx.kube`), not Prism: the pack declares `transports: ["kube"]` and the server hands it a fleet-wide client built from the management kubeconfig.

| order | `name` | `check.fn` | `dependsOn` |
|---|---|---|---|
| 1 | `welcome` | CheckUserNum | - |
| 2 | `quick-tour` | - | - |
| 3 | `access` | - | - |
| 4 | `multitenancy` | - | - |
| 5 | `workspaces` | - | - |
| 6 | `create-project` | CheckProject | - |
| 7 | `storage-intro` | - | - |
| 8 | `storage-classes` | - | - |
| 9 | `block-storage` | CheckBlockStorage | `create-project` |
| 10 | `file-storage` | CheckFileStorage | `block-storage` |
| 11 | `wordpress-ingress` | CheckWordpressIngress | `file-storage` |
| 12 | `fundamentals-recap` | - | - |
| 13 | `metrics` | - | - |
| 14 | `insights` | - | - |
| 15 | `cost` | - | - |
| 16 | `observability-recap` | - | - |
| 17 | `gitops-source` | CheckGitOpsSource | `create-project` |
| 18 | `gitops-app` | CheckBoutiqueRunning | `gitops-source` |
| 19 | `dynamic-gitops` | CheckDynamicProject | `gitops-app` |
| 20 | `conclusion` | - | - |
| 21 | `ndk` | - | - |
| 22 | `web-ide` | - | - |
| 23 | `deploy-app` | CheckSimpleApp | - |
| 24 | `expose-service` | CheckNodePort | `deploy-app` |
| 25 | `loadbalancer` | CheckLoadBalancer | `expose-service` |
| 26 | `ingress` | CheckSimpleAppIngress | `expose-service` |

12 check functions cover the project, both storage classes, WordPress behind an Ingress, the GitOps source and its app across two clusters, and the four optional terminal labs. The other 14 stages are the bootcamp's own explanatory pages, its two chapter recaps and its conclusion.

## Design notes

A few stages are deliberately kept separate rather than merged, to preserve the story's rhythm:

- **13 + 14** - `verify-prod-user-isolation` (the prod user is project-scoped) then `live-migrate-vm` after Tank spots a host scan.
- **22 → 25** - `verify-protection-secure`, `incident-freeze`, `incident-reconnect`, `welcome-back`: the incident interlude.
- **38 + 39** - `mission-complete` (mission accomplished) then `outro-cleanup` (wipe traces and disconnect).
