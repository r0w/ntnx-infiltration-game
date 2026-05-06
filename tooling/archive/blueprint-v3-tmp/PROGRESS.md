# Blueprint v3-tmp — diagnostic incrémental

Après v2 bloqué sur 9 cycles synthétisés par PC 7.5, repartir d'un
minimal absolu **confirmé launchable** (2026-04-28) et rajouter
une feature à la fois pour identifier exactement laquelle déclenche
chaque erreur.

---

## ⏸ State as of 2026-04-28 (paused — need PC with AD endpoint)

**Root cause of 9 cycles found and fixed.** v3-tmp imports + launches
on fresh PC (without AD endpoint). Pause iteration here until a PC
with AD endpoint becomes available to test the powershell-on-Linux
warning resolution.

### What works (committed)
- Baseline minimal (commit 8b44949) → C3 (commit bf38c3f)
- 15 install tasks (escripts + SET_VARs + 1 PowerShell + 2 SSH)
- 23 Profile vars (3 hidden + 15 LOCAL + 5 SECRET)
- 2 day-2 actions (UpdateGame + VerifyState)
- 0 cycle errors
- All warnings non-blocker (powershell-on-Linux is environmental)

### What's pending
1. **C4 build is prepared but NOT tested** — changes SET_VAR
   `target_any` from `Service Game` to `Profile Default`. Goal :
   clear the "Eval variable not defined on the Service" warnings.
   File ready : `blueprint.json` 131,404 bytes md5
   `e30ffaff1b9806474eb6499798260c72`. Upload + report next session.
2. **Phase D2** : ajouter le 2nd credential `PLAYER`. Test multi-cred.
3. **Phase D3** : prereq tgz inline (CloneProd + BlankVM en base64
   dans `upload_prereq_bps.py`). Test ~27 KB inline script.
4. **Apply fix to v2** : migrer `tooling/blueprint-v2/build_blueprint.py`
   pour utiliser le pattern v3-tmp (vars Profile, scripts patched à
   `@@{X}@@`). Une fois fait, v2 devient le BP final shippable.
5. **Live launch test** : sur un PC avec AD endpoint réel (run le
   `runbook_prerequisites.json` d'abord), valider que tout le chain
   d'install run end-to-end. Inclus la résolution du warning
   powershell-on-Linux (devrait disparaître quand AD endpoint existe).

### Where to resume
Read this file + `build_minimal.py`. The C4 commit is **uncommitted in
working tree** — either commit + test it, or revert with
`git checkout tooling/blueprint-v3-tmp/build_minimal.py` to start
clean from C3 state.

## Méthode

- 1 commit = 1 addition ciblée
- Chaque test PC 7.5 documenté ci-dessous (section **Iteration log**) avec md5 + résultat verbatim user
- État courant accumulé en haut (**Current state**)
- Plan de phases + résultats compilés (**Phases**)

---

## Current state (accumulated additions on top of baseline)

À mesure qu'on valide une addition, elle migre du Phases plan vers ici.

### Baseline (commit 8b44949)
- 1 Service `Game` avec **5 actions** (create+start avec `echo`, stop+delete+restart vides)
- 1 Substrate `VM` AHV_VM Linux + cloud-init + SSH readiness probe
- 1 Package SUBSTRATE_IMAGE `Ubuntu2404`
- 1 Package DEB `Game Content` avec **1 task** `echo hello world` sur Game
- 1 Deployment `GameDeployment` (1 replica, GREENFIELD)
- 1 Profile `Default` (zéro var, zéro action day-2)
- 1 Credential `NUTANIX` (PASSWORD, `editables.secret=True`)
- Top-level: `api_version=3.0`, `product_version=4.3.0`, `contains_secrets=False`, `status={}`
- Substrate `editables.create_spec` exposes `cluster_reference` + `nic[0].subnet_reference` au launch
- Substrate `categories={"Environment": "Production"}`

### + D1 (commit be6415a)
- Service: 6ème action `action_soft_delete` empty

### + A1 (commit dafa060)
- Install runbook task: `echo hello world` (sh, 16 chars) → `cluster_health.py` réel (static_py3, 3995 chars)

### + A2 (commit 8dac720)
- Install runbook: 1 task → 2 tasks séquentielles (Activate policy engine → Wait for cluster health), 1 edge

### + A3 (commit f8e727e)
- Service.variable_list : 2 hidden vars CLUSTERNAME + CLUSTERUUID
- Install runbook : 3 tasks (Activate → Get Cluster SET_VAR → Wait for cluster health), 2 edges

---

## Iteration log

Chronological — most recent at top. Each entry: commit / date / change / file metadata / user-reported result / verdict.

### Iteration 16 — C3 day-2 actions (commit pending, 2026-04-28)
- **Change** : ajout de 2 day-2 actions sur Profile.action_list : `Update Game` (SSH avec update_game.sh, target Game) + `Verify State` (escript avec verify_state.py, target Game). Helper `build_profile_action()` (type='user').
- **File** : `blueprint.json` 131,398 bytes, md5 `3694db0fb54178bc74362fbceb6b0d13`
- **Hypothèse testée** : Profile.action_list populé ne crée pas de cycle nouveau
- **User report** : "Linux os cannot have script type as powershell" (×2, AD endpoint absent — connu) + **NEW**: "Eval variable CLUSTERNAME/CLUSTERUUID/ProjectUUID not defined on the Service" (×3) + "Package options are invalid" (×2). User says "on peut continuer".
- **Verdict** : 🟡 partiel. Day-2 actions OK (pas de cycle ajouté). MAIS PC strict-checke maintenant `eval_variables` contre `target_any` (Service Game) — vars étant sur Profile → warning. Probable que ces warnings existaient depuis A5/A6 mais user listait que les fatals.

### Iteration 15 — C1+C2 full Profile vars (commit pending, 2026-04-28)
- **Change** : ajout des 19 vars + 5 secrets sur Profile.variable_list (parité v2). Helpers `make_local_var` + `make_secret_var`. 23 vars total : 3 hidden (CLUSTERNAME/CLUSTERUUID/ProjectUUID — déjà là depuis A5), 15 LOCAL visibles (PC_IP, PC_USERNAME, IMAGE_*, GHCR_USERNAME, CLUSTER_PROFILE, MODE, LOG_LEVEL, TIMEZONE, GAME_*), 5 SECRET (PC_PASSWORD, GHCR_TOKEN, ADMIN_PASSWORD, GAME_PROD_PASSWORD, GAME_OLD_PC_PASSWORD).
- **File** : `blueprint.json` 120,366 bytes, md5 `4aa1defe8c113c906c90de6309c85faf`
- **Hypothèse testée** : ajout massif de vars Profile ne déclenche pas de cycle, et résout les warnings `@@{PC_IP}@@` etc. accumulés depuis A1.
- **User report** : "toujours [warning powershell-on-Linux] mais sinon je peux importer". Le warning d'A4-vintage est dû à l'AD endpoint absent sur le PC fresh (pas de prereq runbook fired) — pas un blocker.
- **Verdict** : ✅ pas de cycle. Profile vars ajoutés OK. Warning powershell n'est pas lié aux vars (cf. itération 14).

### Iteration 14 — B2 PowerShell + AD endpoint ref (commit pending, 2026-04-28)
- **Change** : ajouté `make_powershell_task` helper + 1 PowerShell task `Add AD users` après Create Local users. script_type=npsscript, target_any=Game (Service Linux), exec_target_reference=AD (app_endpoint), inherit_target=False. AD endpoint NON déclaré dans la BP (référencé externe, créé par `runbook_prerequisites.json`).
- **File** : `blueprint.json` 107,193 bytes, md5 `b3187f2c96799d1068afe93b48618246`
- **Hypothèse testée** : PowerShell task avec target_endpoint cross-target n'introduit pas de cycle ni de blocker
- **User report** : "ca marche mais ça gueule sur 'Linux os cannot have script type as powershell' [warning]" — launch quand même OK
- **Verdict** : ✅ pas de cycle, launch OK. Warning powershell-on-Linux = cosmétique car AD endpoint n'existe pas sur le PC (prereq runbook pas fired). Validator PC fall-back sur target_any.os_type (Linux). Legacy n'avait pas le warning car testé sur PC où l'AD endpoint était déjà créé. Solutions : (a) ignorer (b) firer prereq runbook d'abord (c) déclarer AD inline dans `endpoint_definition_list`.

### Iteration 13 — A6 scaling fix to 14 tasks (commit pending, 2026-04-28) — ✅ **FIX SCALES**
- **Change** : retour aux 14 install tasks de A4 (l'ancien cycle-trigger BP) MAIS avec le A5 fix appliqué : Service.variable_list vide, Profile.variable_list = [CLUSTERNAME, CLUSTERUUID, ProjectUUID], et helper `read_script_patched()` qui sed-replace `@@{Game.X}@@` → `@@{X}@@` sur les 7 scripts qui en utilisent (au build time, scripts source intouchés).
- **File** : `blueprint.json` 104,457 bytes, md5 `eeac66cb5496c5fa45e996705cd2abeb`
- **Hypothèse testée** : le A5 fix scale du minimal (4 tasks) au full install chain (14 tasks)
- **User report** : "ok, ca s'importe et je peux launch dès que j'ai mis le crédential"
- **Verdict** : ✅ **FIX SCALES**. 0 cycle. La même 14-task install qui pétait en A4 marche maintenant. Phase A entièrement validée.

### Iteration 12 — A5 fix validation (commit pending, 2026-04-28) — ✅ **FIX CONFIRMED**
- **Change** : strict same shape que A4e (qui pète) MAIS Service.variable_list vidé, hidden vars (CLUSTERNAME, CLUSTERUUID, ProjectUUID) déplacées sur Profile.variable_list. 2ème SET_VAR script lit `@@{CLUSTERUUID}@@` (Profile-scoped, no `Game.` prefix). SET_VAR target_any reste Service Game.
- **File** : `blueprint.json` 33,096 bytes, md5 `b3f3007c05f6d82a97439e081b4817b5`
- **Hypothèse testée** : déplacer les vars vers Profile élimine la bidirectionnalité Service↔Package qui crée le back-edge cyclique
- **User report** : "ca work ce a5"
- **Verdict** : ✅ **FIX CONFIRMÉ**. Les 9 cycles disparaissent. Pas de cycle malgré 4 tasks dont 2 SET_VARs (l'un lisant + écrivant des Profile vars).

### Iteration 11 — A4e bisect (commit pending, 2026-04-28) — ❌ **ROOT CAUSE CONFIRMED**
- **Change** : A4d's 4 tasks, MAIS le 2ème SET_VAR utilise un script inline minuscule qui **lit `@@{Game.CLUSTERUUID}@@`** (Service var set par Get Cluster en upstream) ET **écrit `ProjectUUID`** (Service var via eval_variables).
- **File** : `blueprint.json` 33,077 bytes, md5 `46438f9607c3b4e91242ecd9f3f18e58`
- **Hypothèse testée** : SET_VAR task qui lit Service var + écrit Service var = bidirectional binding Service↔Package → cycle
- **User report** : "ca recommence" — les 9 cycles familiers
- **Verdict** : ❌ **HYPOTHÈSE CONFIRMÉE**. Diff entre A4d (✅) et A4e (❌) = **uniquement le macro read `@@{Game.CLUSTERUUID}@@`** dans une SET_VAR qui écrit `Game.ProjectUUID`. Le 2nd SET_VAR seul (A4d) passe ; ajouter le read de Service var le fait cycler.

### Iteration 10 — A4d bisect (commit pending, 2026-04-28)
- **Change** : A3's 3 escripts + 2nd SET_VAR avec script inline trivial (`print('ProjectUUID=stub-uuid-for-test')`, 39 chars) écrivant `ProjectUUID`. Pas de macro read.
- **File** : `blueprint.json` 33,011 bytes, md5 `cced064414ef17e1c97766a5f72e2f1e`
- **Hypothèse testée** : 2 SET_VARs en général trigger les cycles, peu importe le contenu
- **User report** : "ok ca c'est bon"
- **Verdict** : ✅ pas de cycle. 2 SET_VARs sans macro read OK. Le contenu spécifique de `setup_production_project.py` était le suspect — confirmé en A4e.

### Iteration 9 — A4c bisect (commit pending, 2026-04-28)
- **Change** : install runbook strictement identique A3 (3 tasks, 1 SET_VAR), MAIS 3ème hidden var `ProjectUUID` ajoutée sur Service.variable_list (déclarée mais non utilisée par aucune SET_VAR).
- **File** : `blueprint.json` 31,438 bytes, md5 `e15cf398addeee1f03c2c78322feca0e`
- **Hypothèse testée** : 3ème hidden var sur Service est-elle le trigger ? (peu importe SET_VAR)
- **User report** : "ok ca work ça"
- **Verdict** : ✅ pas de cycle. Hidden var inutilisée OK. **Trigger isolé à la 2ème SET_VARIABLE task** elle-même (Setup production project).

### Iteration 8 — A4b bisect (commit pending, 2026-04-28) — ❌ **CYCLES TRIGGERED**
- **Change** : A3's 3 escripts + ajout `Setup production project` SET_VARIABLE (eval_variables=[ProjectUUID]) à la fin + `ProjectUUID` hidden var sur Service. Total : 4 tasks, 2 SET_VARs distincts, 3 hidden vars.
- **File** : `blueprint.json` 53,295 bytes, md5 `70ce86136958c09bd8c1854fd7c79d0c`
- **Hypothèse testée** : 2 SET_VARs séparés écrivant sur 2 hidden vars différents trigger le cycle
- **User report** : 9 cycles familiers
- **Verdict** : ❌ trigger localisé. Soit (a) la 2ème SET_VAR task, soit (b) la 3ème hidden var sur Service, soit (c) une combo. Bisection plus fine requise.

### Iteration 7 — A4a bisect (commit d527180, 2026-04-28)
- **Change** : revert install runbook à A3 (3 escripts) + ajout d'UNE SH task `Install Docker` avec `login_credential_local_reference=NUTANIX` à la fin. Total 4 tasks, 3 edges.
- **File** : `blueprint.json` 33,689 bytes, md5 `12d0c2705b9cfca44404a45a145eee5e`
- **Hypothèse testée** : SH task avec login_credential binding crée le back-edge cyclique
- **User report** : "ok ca c'est bon"
- **Verdict** : ✅ pas de cycle. SH+cred est éliminé comme trigger. Suspect suivant : 2ème SET_VARIABLE (Setup production project + ProjectUUID).

### Iteration 6 — A4 (commit 2498095, 2026-04-28) — ❌ **CYCLES TRIGGERED**
- **Change** : install runbook 3 tasks → 14 tasks séquentielles. Ajouté 11 tasks (10 escript.py3 + 1 SET_VARIABLE `Setup production project` + 2 SSH bash tasks `Install Docker` / `Run game container` avec `login_credential_local_reference=NUTANIX`). Service.variable_list += `ProjectUUID` (3 hidden vars total).
- **File** : `blueprint.json` 104,522 bytes, md5 `65293f3454122c1044aad152375b5409`
- **Hypothèse testée** : Toute la chaîne v3 d'install (sans Add AD users + sans upload_prereq_bps) passe encore
- **User report** : "et voilàààààà ca remarche plus" — les 9 cycles familiers (Package + Profile + Deployment × Create/Delete/SoftDelete)
- **Verdict** : ❌ trigger des cycles localisé entre A3 et A4. Suspects parmi 11 nouvelles tasks :
  - 2 NEW SH tasks avec `login_credential_local_reference=NUTANIX` (Install Docker, Run game container) — **suspect #1** (binding Credential, jamais testé)
  - 1 NEW SET_VARIABLE (Setup production project setting ProjectUUID) + var ProjectUUID
  - 8 escript.py3 supplémentaires (remove_node, setup_subnets, create_local_users, create_prod_vms, setup_jumphost_endpoint, clone_fake_bps, trigger_lcm_inventory, verify_state)

### Iteration 5 — A3 (commit f8e727e, 2026-04-28)
- **Change** : ajouté SET_VARIABLE task `Get Cluster` (eval_variables=[CLUSTERNAME, CLUSTERUUID]) entre Activate et cluster_health. Service.variable_list reçoit les 2 hidden vars correspondants. DAG = 3 children + 2 edges.
- **File** : `blueprint.json` 30,933 bytes, md5 `4fcae9e1add919917531e495f07a1f80`
- **Hypothèse testée** : SET_VARIABLE écrivant sur Service hidden vars + Service ayant ces vars déclarées ne crée PAS de back-edge dans la synthesis lifecycle
- **User report** : "ok ca marche toujours. Warnings: Macro may be incorrect, no variable with name 'PC_IP' / 'PC_USERNAME' / 'PC_PASSWORD' on entity or action (sur les 3 install tasks)"
- **Verdict** : ✅ pas de cycle. Warnings macro = scripts référencent des Profile vars pas encore déclarées (à fix en Phase C). Pas un blocker.

### Iteration 4 — A2 (commit 8dac720, 2026-04-28)
- **Change** : install runbook 1 task → 2 tasks séquentielles. Ajouté `activate_policy_engine.py` (escript.py3, 899 chars) AVANT `cluster_health.py`. DAG = 2 children + 1 edge `Activate policy engine → Wait for cluster health`.
- **File** : `blueprint.json` 27,753 bytes, md5 `071cb036ad6e1d5c868f20425246d5d8`
- **Hypothèse testée** : DAG avec multiple children + edge sequentiel est accepté
- **User report** : "OK NEXT"
- **Verdict** : ✅ pas d'erreur. Sequential edges + 2 escripts OK.

### Iteration 3 — A1 (commit dafa060, 2026-04-28)
- **Change** : install runbook task `echo hello world` (sh, 16 chars) → `cluster_health.py` réel (static_py3, 3995 chars). Toujours 1 seule task, target Game.
- **File** : `blueprint.json` 25,292 bytes, md5 `1ff545502563963f1cd0b62be66b43d8`
- **Hypothèse testée** : script_type=`static_py3` avec un escript Python substantif est accepté comme `sh` simple
- **User report** : "OK ça m'a l'air bien"
- **Verdict** : ✅ pas d'erreur nouvelle, baseline preservé. script_type static_py3 + escript ~4 KB OK.

### Iteration 2 — D1 (commit be6415a, 2026-04-28)
- **Change** : ajouté `action_soft_delete` empty sur Service.action_list (6 actions au total)
- **File** : `blueprint.json` 21,267 bytes, md5 `3cb4614d1030453d510e89eab2f77b78`
- **Hypothèse testée** : "PC synthétise les SoftDelete cycles seulement quand Service déclare action_soft_delete"
- **User report** : "toujours OK, je peux toujours lancer"
- **Verdict** : ✅ pas de cycle, hypothèse réfutée. action_soft_delete empty n'est PAS le trigger.

### Iteration 1 — Baseline (commit 8b44949, 2026-04-28)
- **Change** : created from scratch — minimal launchable BP
- **File** : `blueprint.json` 19,998 bytes, md5 `d3bf6bc7a72f93e5a3ba53da3c4698c1`
- **Hypothèse testée** : "Une shape minimale Service+Substrate+Package+Deployment+Profile peut launch sur PC 7.5"
- **User report** : "j'ai mis un credential et j'ai le bouton Launch utilisable. Errors: subnet whitelist + cred secret (les 2 normales runtime). Warnings: provider account missing in project."
- **Verdict** : ✅ baseline confirmée launchable. Les 2 erreurs runtime sont normales (résolues à l'écran de launch).

---

## Phases (plan)

### Phase A — install runbook content
- [x] **A1**: `echo hello` → `cluster_health.py` (static_py3). **✅ pas d'erreur**.
- [x] **A2**: 2 tasks séquentielles (Activate + cluster_health). **✅ pas d'erreur**.
- [x] **A3**: SET_VARIABLE Get Cluster + 2 hidden vars Service. **✅ pas d'erreur**, warnings macro PC_IP/USERNAME/PASSWORD attendus (Phase C).
- [x] **A4**: 14 install tasks. **❌ cycles** → bisecté A4a-A4e → ✅ root cause = SET_VAR read+write Service vars.
- [x] **A5**: fix vars on Profile (4 tasks). **✅ no cycle**.
- [x] **A6**: fix scaled to 14 tasks. **✅ no cycle**. Phase A entièrement OK.

### Phase B — endpoint + multi-target
- [ ] **B1**: ajouter AD endpoint dans `endpoint_definition_list`. (skip, AD est externe via prereq runbook).
- [x] **B2**: PowerShell task `Add AD users` avec `target_endpoint=AD` + `inherit_target=False`. **✅ launch OK**, warning cosmétique (AD endpoint pas créé sur PC).

### Phase C — Profile features
- [x] **C1+C2**: 23 Profile vars (3 hidden, 15 LOCAL, 5 SECRET), 5 mandatory. **✅ pas de cycle**, no impact.
- [ ] **C3**: ajouter les 2 day-2 actions (UpdateGame, VerifyState).

### Phase D — fioritures
- [x] **D1**: action_soft_delete (6ème Service action). **✅ pas de cycle, théorie réfutée**.
- [ ] **D2**: 2nd credential `PLAYER`.
- [ ] **D3**: prereq tgz inline (~27 KB script).

### Phase E — apply to v2 + ship
- [ ] **E1**: porter le fix de v3-tmp dans `tooling/blueprint-v2/build_blueprint.py` :
  - Profile.variable_list reçoit CLUSTERNAME / CLUSTERUUID / ProjectUUID hidden
  - Service.variable_list les perd
  - read_script() devient read_script_patched() (sed-replace `@@{Game.X}@@` → `@@{X}@@`)
  - SET_VAR target_any = Profile Default (cf. C4)
- [ ] **E2**: live launch sur un PC réel avec AD endpoint (run prereq runbook d'abord).
- [ ] **E3**: cleanup tooling/blueprint-v3-tmp/ une fois v2 shippable, ou archiver comme référence.

---

## ❌ Confirmed broken (filled as we discover)

### 🎯 ROOT CAUSE — SET_VARIABLE bidirectional binding on Service (2026-04-28)

**Trigger précis** : une `SET_VARIABLE` task qui **lit** une var Service via macro `@@{Game.X}@@` ET **écrit** une autre var Service via `eval_variables` déclenche les 9 cycles synthétisés par PC 7.5's lifecycle planner (Package + Profile + Deployment × Create/Delete/SoftDelete).

**Pourquoi** : PC voit le SET_VAR comme à la fois consumer (input edge `Service.Game → task`) et producer (output edge `task → Service.Game`) sur la même entité. Cette bidirectionnalité Service↔Package est interprétée comme back-edge → cycle dans la synthesis lifecycle.

**Confirmé par bisection** :
- A4d : 2 SET_VARs où le 2nd écrit `ProjectUUID` SANS lire Service var → ✅ clean
- A4e : exactement la même chose MAIS le 2nd SET_VAR lit `@@{Game.CLUSTERUUID}@@` → ❌ 9 cycles

**Fix structural** : déplacer les vars d'install state (`CLUSTERNAME`, `CLUSTERUUID`, `ProjectUUID`) du **Service** vers le **Profile**. Profile vars peuvent être lues + écrites par SET_VAR tasks sans créer de Service self-reference. Macro refs deviennent `@@{CLUSTERUUID}@@` (profile-scoped) au lieu de `@@{Game.CLUSTERUUID}@@`.

**✅ FIX CONFIRMÉ par A5 (2026-04-28)** — A4e (cycles) → A5 (no cycle) avec le seul changement = vars déplacées sur Profile + macro read en `@@{CLUSTERUUID}@@`. SET_VAR target_any reste `Service Game`, eval_variables résolvent vers Profile vars correctement.

### Bisection log (résolu) — chronological
**Plan bisection** :
- ~~A4a = A3 + 1 SH+cred task~~ → ✅ pas de cycle. SH+cred binding éliminé.
- ~~A4b = A3 + 2nd SET_VAR + ProjectUUID var~~ → ❌ cycles, trigger localisé.
- ~~A4c = A3 + ProjectUUID var SEUL~~ → ✅ pas de cycle. Trigger = 2ème SET_VAR.
- ~~A4d = A3 + 2ème SET_VAR avec script inline trivial (write only)~~ → ✅ pas de cycle. Distingue write-only de read+write.
- ~~A4e = A3 + 2ème SET_VAR inline qui lit Game.CLUSTERUUID + écrit Game.ProjectUUID~~ → ❌ **9 cycles. Root cause confirmée.**

---

## Manifeste : v2 features pas encore dans v3-tmp

Source : `tooling/blueprint-v2/build_blueprint.py`. Quand toutes ces lignes
seront cochées, v3-tmp = parité v2.

- [ ] 16 install tasks au lieu de 1
- [ ] PowerShell `Add AD users` avec `target_endpoint=AD`
- [ ] AD endpoint dans `endpoint_definition_list`
- [ ] 2 SET_VARIABLE tasks (Get Cluster + Setup production project)
- [ ] 3 hidden vars Service (CLUSTERNAME, CLUSTERUUID, ProjectUUID)
- [ ] 19 runtime vars Profile (PC_IP, IMAGE_TAG, MODE, GAME_*, etc.)
- [ ] 6 secrets Profile (PC_PASSWORD, ADMIN_PASSWORD, etc.)
- [ ] 2 day-2 actions Profile (UpdateGame, VerifyState)
- [x] 6ème system action `action_soft_delete` ✅
- [ ] 2nd credential `PLAYER`
- [ ] Prereq tgz inline (CloneProd + BlankVM base64)
- [ ] Service.action_create body réel (mkdir + touch au lieu de echo)
- [ ] Service.action_start body réel (docker start au lieu de echo)
