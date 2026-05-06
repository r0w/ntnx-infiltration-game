# Stage map

The 39 stages of the `ntnx-infiltration` pack, in play order.

**Conventions:**
- `order` is the position in `pack.json.stages[]` (1-indexed reading order). Reordering a stage means moving its name in that array; existing sessions stay attached to the name, not the position.
- `name` is the canonical identifier (kebab-case). It is the field used everywhere: filename `<name>.json`, SQLite columns (`stage_name`), API payload, `pack.json.stages[]`, logs, DevPanel.
- `check.fn` is the check function registered in `packs/ntnx-infiltration/checks/index.ts`. A dash means the stage is narrative or input-only (no validation against the cluster).

## Stages

| order | `name` | `check.fn` |
|---|---|---|
| 1 | `lore` | - |
| 2 | `login` | CheckTrigram |
| 3 | `recovery-gate` | NeedRecovery |
| 4 | `intro-ego-greet` | - |
| 5 | `intro-mission` | - |
| 6 | `create-admin-user` | CheckUser |
| 7 | `create-auth-policy` | CheckAuthPolicy |
| 8 | `switch-to-admin-user` | - |
| 9 | `create-project` | CheckProject |
| 10 | `create-subnet` | CheckNetwork |
| 11 | `add-ubuntu-image` | CheckImage |
| 12 | `create-vm` | CheckVM |
| 13 | `verify-prod-user-isolation` | - |
| 14 | `live-migrate-vm` | CheckLiveMigration |
| 15 | `create-category` | CheckCat |
| 16 | `apply-category-to-vm` | CheckCatVM |
| 17 | `create-storage-policy` | CheckStoragePolicy |
| 18 | `create-microseg-policy` | CheckSecurityPolicy |
| 19 | `allow-ssh-in-microseg` | CheckSecurityPolicy2 |
| 20 | `create-protection-policy` | CheckProtectionPolicy |
| 21 | `create-approval-policy` | CheckApprovalPolicy |
| 22 | `verify-protection-secure` | - |
| 23 | `incident-freeze` | - |
| 24 | `incident-reconnect` | - |
| 25 | `welcome-back` | - |
| 26 | `restore-vm-from-recovery` | CheckRestoreVM |
| 27 | `create-report` | CheckReport |
| 28 | `expand-cluster` | CheckNewNode |
| 29 | `lcm-check-updates` | CheckUpdates |
| 30 | `security-dashboard` | - |
| 31 | `capacity-runway` | CheckRunway |
| 32 | `resource-optimization` | - |
| 33 | `create-ncm-playbook` | CheckPlaybook |
| 34 | `test-ncm-playbook` | - |
| 35 | `clone-app-blueprint` | CheckCloneApp |
| 36 | `schedule-day2-action` | CheckSchedDay2 |
| 37 | `modify-blueprint` | CheckUpdateBP |
| 38 | `mission-complete` | - |
| 39 | `outro-cleanup` | - |

25 check functions cover IAM, projects, networking, VM lifecycle, categories, policies (storage / microseg / protection / approval), reports, NCM X-Play, and Self-Service blueprints. The other 14 stages are narrative beats (intro, incident interlude, mission outro) or input-only prompts.

## Design notes

- **Stages 15 + 16 are split.** 15 verifies the prod user's project-scoped isolation; 16 live-migrates the VM after E.G.O. spots a host scan. Two distinct narrative beats.
- **Stages 22 → 25 are kept separate.** `verify-protection-secure`, `incident-freeze`, `incident-reconnect`, `welcome-back` preserve the dramatic rhythm of the incident interlude.
- **Stages 38 + 39 are split.** 38 is mission accomplished; 39 is trace cleanup and disconnect.
- **Stages 3 / 4 / 5 are not collapsed.** Three beats of the E.G.O. intro; merging them would flatten the opening.
