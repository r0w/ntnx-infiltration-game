# Tooling - Calm artifacts

The `tooling/` directory holds the two Calm artifacts an operator uploads to Prism Self-Service to deploy the game, plus archived earlier blueprint generations kept for reference.

```
tooling/
├── runbook_prerequisites.json   ← Calm Runbook (one-off per PC)
├── blueprint/                   ← Calm Blueprint source + tooling
│   ├── blueprint.py             (calm-dsl)
│   ├── patch_escript.py         (post-compile passes)
│   ├── compile.sh / monitor.py
│   ├── scripts/ prereqs/ specs/
│   ├── tests/                   (pytest)
│   └── docs/                    (phase notes + history)
└── archive/                     (v1, v2, v3-tmp — superseded, kept for history)
```

## The two release assets

The operator uploads both, in this order, on every fresh PC:

| Asset | Source | Upload to | Role |
|---|---|---|---|
| `nig-00-runbook-prerequisites.json` | [`runbook_prerequisites.json`](./runbook_prerequisites.json) | Self-Service > **Runbooks** | Creates the `AD` Calm endpoint the blueprint's `Add AD users` task uses. One-off per PC. |
| `nig-01-blueprint.json` | [`blueprint/blueprint.py`](./blueprint/blueprint.py) → patched | Self-Service > **Blueprints** | The game itself: the VM, the Docker container, and the production world (project, prod VMs, prereq BPs). Once per game. |

## Why a runbook and a blueprint

Calm has two artifact types with different scopes. A **runbook** is a one-shot sequence with no app instance, ideal for cluster-level setup like creating an endpoint. A **blueprint** defines an application with services, a lifecycle, and day-2 actions - what the game is. The endpoint has to come from the runbook because Calm rejects endpoint creation inside a blueprint install task.

## More

- Operator walkthrough: [`../docs/OPERATOR.md`](../docs/OPERATOR.md).
- Blueprint internals: [`blueprint/README.md`](./blueprint/README.md).
- How the current blueprint came to be (and the earlier generations): [`blueprint/docs/`](./blueprint/docs/) and the `archive/` sources.
