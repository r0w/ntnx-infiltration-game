# Project-owned categories: validation on 17 November 2026

Baseline: `develop` at `7efae91`. Tested as Prism administrator on PC
7.6.0.6, AOS 7.6, AHV 11.2, with the game in `other/test` mode.
These results describe this stack, not every 7.6 patch or every user role.

## Results

| Stage | Category owned by the player project | Control category in the internal project |
| --- | --- | --- |
| 9: project creation and membership | Act + check pass | Not applicable |
| 12: VM project and owner assignment | Act + check pass | Not applicable |
| 15: category creation | Prism UI succeeds with Owner Project selected | Original act succeeds without selecting Owner Project |
| 16: VM/category association | Succeeds | Existing fallback can share the category with the VM project |
| 17: storage policy | Fails, including in Prism UI; `DPO-10100` | Act + check pass |
| 18: microseg policy | Original act fails asynchronously; v4.3 with matching `projectExtId` succeeds | Act + check pass |
| 20: protection policy | Fails asynchronously; `DPO-10100` | Act + check pass |

The original category check only checked the two values. The original category
act did not set Owner Project. This allowed a successful auto-play to exercise
a different path from the player instructions. Microseg and protection acts
also returned success after task acceptance even when the task later failed;
their checks correctly reported the missing policies.

## Reproduce the storage failure through Prism

1. Create a dedicated project and give TheProjectManager membership as Project
   Admin, with the required infrastructure and networks.
2. Create the test VM and assign it to that project and owner.
3. In Admin Center > Categories, create `<trigram>-cat:Critical` with
   **Owner Project** set to `<trigram>-proj`. Create `Test` in the same project.
4. Associate `Critical` with the VM. This succeeds.
5. In Infrastructure > Storage > Storage Policies, create a policy with
   encryption Enabled. In Association, select `<trigram>-cat:Critical`.
6. Save. The UI offers the category and displays its associated VM, but then
   reports: `Request failed as the input is invalid - Category with uuid ...
   does not exist.` The asynchronous task fails with `DPO-10100`.

The UI submits `/api/datapolicies/v4.3/config/storage-policies`. The same
failure occurs through the game's v4.2 endpoint and a direct v4.3 request.
No additional policy project selector was present in this storage wizard.

Protection policy creation through both v4.2 and v4.3 fails with `DPO-10100`:
the category is not accessible by project `00000000-0000-0000-0000-000000000000`.
The protection wizard itself was not tested. The v4.3 create schema inspected
does not expose a policy `projectExtId` field. No claim is made that every
possible platform workaround has been exhausted.

## Microsegmentation resolution

The old create request defaults to the internal project and fails with
`MIC-10007`: the category does not belong to that project. Using
`/api/microseg/v4.3/config/policies` with the category's `projectExtId`
succeeds. The patched act creates `<trigram>-mseg-policy` this way, waits for
the task, and passes the real security-policy check. This was API-tested;
the corresponding Prism wizard path still needs a player-facing walkthrough.

## Branch changes and release limits

- Create both category values with their Owner Project through Prism v4.4;
  v4.2 creation rejects the `projectExtId` field on the tested cluster.
- Read category ownership through raw REST, avoiding older SDK models that
  omit it. Verify both values and refuse an existing wrong owner without
  deleting, recreating or silently sharing the category.
- Scope project-owned microseg policies through v4.3 and propagate failed
  microseg/protection tasks. Fix the English `Catagories` typo.
- Add regression tests for ownership, persisted results and task failures;
  update the mock categories to carry explicit project ownership.

This is **not a full 7.6 compatibility fix**: storage and protection remain
blocked on the tested path. No global category sharing was applied as a
workaround. The stricter category act requires Prism v4.4 and must not be
released as a transparent 7.5-compatible change without testing or a separate
version-specific path and matching player instructions. The category check
also rejects old categories without the requested owner.

Project-check coverage of the exact admin role and selected network remains
separate work; the VM assignment passed here, which does not establish all
project permissions. No Jira fix version is inferred from these results.

## Retained test resources

The dedicated `p76` project, VM, subnet (VLAN 217), image, two category values,
and successful microseg policies were retained for inspection. `p7g` holds the
internal-project category control and its three policies. Failed create tasks
are diagnostic evidence, not successful policies. The extra microseg API
probe is named `p76-mseg-project`. No existing player resources were deleted.
The deployed game remains the unmodified `develop-7efae91` image; local acts
were run separately to validate the branch.
