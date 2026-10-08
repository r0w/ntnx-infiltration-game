# Blueprint changes to a cluster

Reviewed against the NKP integration branch, October 2026. This describes
installation and day-2 actions; gameplay/auto-play has its own resource writes.

The full NCP `other` profile skips dedicated-cluster operations, but still
prepares a training world. On a shared cluster with existing games, use the
deployment-only artifact described in [OPERATOR.md](OPERATOR.md#shared-clusters-and-existing-installations).

| Task | Full NCP `hpoc` | Full NCP `other` | NKP / deployment-only NCP |
| --- | --- | --- | --- |
| Provision image and game VM | Creates image/VM | Creates image/VM | Creates image/VM |
| Validate VM SSH user | Validates input only | Same | Same |
| Get Cluster | Reads cluster identity | Same | Absent |
| Add AD users | Creates two game users if absent | Same | Absent |
| Disable erasure coding | Disables EC on the target cluster's enabled containers | Skipped | Absent |
| Remove 4th host | Removes the matching fourth node | Skipped | Absent |
| Wait for cluster health | Reads health | Same | Absent |
| Trigger LCM inventory | Starts inventory on discovered LCM targets | Same; not profile-gated | Absent |
| Setup subnets | May rename `aux1`, migrate secondary to Advanced, create `TestNetwork` | Same; not profile-gated | Absent |
| Setup production project | Creates/reuses `production`, imports LDAP user, writes membership/ACP and project resources | Same | Absent |
| Create Prod VMs | Creates/reuses seven named VMs, assigns project, sets power ON | Creates/reuses them, assigns project, sets power OFF | Absent |
| Setup jumphost endpoint | Deletes/recreates the existing named endpoint | Same | Absent |
| Install Docker | Installs on the new game VM | Same | Same |
| Push prerequisite blueprints | Force-imports `CloneProd` and `BlankVM-source`, updates CloneProd credentials | Same | Absent |
| Clone fake blueprints | Creates missing demonstration blueprints | Skipped | Absent |
| Verify final state | Reads cluster state | Same | Absent during install |
| Run game container | Writes game VM configuration, pulls image, starts container | Same | Same |
| Wait for node draining | Reads node state | Skipped | Absent |
| Activate policy engine | Enables/waits for the engine if needed | Skipped | Absent |
| Create local users | Creates three missing approval users | Same | Absent |
| Fetch NKP kubeconfig | Absent | Absent | NKP only: reads bootstrap VM config, writes new game VM |

## Existing-resource hazards in the full installer

- Reusing a production VM does not preserve its power state: the following task
  explicitly sets it ON/OFF according to the profile. `other` can turn off a VM.
- A reused `production` project is still written with membership, ACP and
  resource references. An ERROR-state project can be deleted and recreated.
- `jumphost` is replaced by name, and prerequisite blueprints are imported with
  `--force`. Those objects can still be used by an older game application.
- The private deployment orchestrator also replaces the AD endpoint and deletes
  a same-named application/blueprint. For independent validation deployments,
  use unique names and import/launch the shared artifact directly; skip the
  prerequisites runbook and automatic replacement routines.

## NKP networking and day-2 actions

NKP does not run the NCP network setup. The VM hosting the game needs IP
connectivity to the Kubernetes fleet; its subnet need not use Advanced
networking. Fleet prerequisites (workload clusters, storage classes, ingress
and MetalLB) must already exist and are not created by the game installer.

`Update Game` pulls/recreates only the selected application's container and
keeps its persistent data. `Switch Mode` changes that game's configuration.
`Refresh Kubeconfig` reads the bootstrap config again and restarts the NKP
game container. NCP `Verify State` reads cluster state; it does not prepare it.
Deleting a newly created validation application is distinct from deleting
learner resources: do not run cleanup/auto-play against shared learners.
