import type { CheckContext, CheckResult } from '@ntnx-game/engine';
import {
  cacheEntity,
  discoverableNodeSerials,
  getTrigram,
  listAll,
  listAllV3,
  localizedHint,
  lookupAppUuid,
  lookupCategoryUuid,
  lookupImageUuid,
  lookupOrSkip,
  lookupProjectUuid,
  lookupProtectionPolicyUuid,
  lookupSubnetUuid,
  lookupUserUuid,
  justFinishedInventory,
  nutanixErrorDetail,
  readLcmUpdates,
} from './helpers';

/**
 * Check functions referenced by the 39 stages of the ntnx-infiltration pack.
 * Each check validates that the player has completed the stage's action on
 * the cluster by querying Nutanix v4 endpoints and asserting the expected
 * entity exists. In mock mode the queries resolve against `fixtures.json`
 * (with `{Trigram}` substitution wired in by the session-service) so the
 * game loops end-to-end without a live Prism Central.
 *
 * Several v4 paths are provisional and marked as such inline — a real
 * cluster will confirm the exact namespace (storage policies, NCM X-Play,
 * Calm apps, approvals are the fuzziest). Live validation is Phase 9c's
 * follow-up when a PC becomes available.
 */

// ─── IAM ─────────────────────────────────────────────────────────────────

/**
 * Stage 1 `login`. Validates the Trigram the player entered via `<input/>`.
 * Three-part check:
 *   1. Shape — 2–8 chars, `[A-Za-z0-9_-]`. No network call.
 *   2. Returning-agent re-auth — when another unfinished session in the
 *      same pack already captured this Trigram, compare the just-submitted
 *      PIN to the one stored on that session. Match → return `switchTo`
 *      and session-service hands the client over to the old session
 *      (localStorage swap, hydrate at its progression). Mismatch → return
 *      `retryFromVariable: 'PIN'` with a dim hint; player re-tries the PIN
 *      (or presses ↓ to switch agent entirely).
 *   3. New-agent pass — no collision → capture stands, stage advances.
 * Directory lookups are skipped when `ctx.sessionDirectory` is absent
 * (unit tests that don't stand up a full session-service).
 */
async function CheckTrigram(ctx: CheckContext): Promise<CheckResult> {
  const raw = ctx.vars.get('Trigram');
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { pass: false, detail: 'Trigram is empty.', retryFromVariable: 'Trigram' };
  }
  if (!/^[A-Za-z0-9]{3}$/.test(raw)) {
    return {
      pass: false,
      detail: 'Trigram must be exactly 3 letters or digits.',
      retryFromVariable: 'Trigram',
    };
  }
  // Trigrams are case-insensitive: normalize to lowercase so `rbo`, `RBO`,
  // and `rbO` are the same agent (single session, no collisions, no
  // duplicate Nutanix resources named `RBO-vm` vs `rbo-vm`).
  const trigram = raw.toLowerCase();
  // PIN format check happens in the same stage (login captures both
  // Trigram and PIN before the check runs). 4 digits, no exceptions.
  // Rewinding to the PIN input keeps the trigram already typed.
  const pin = ctx.vars.get('PIN');
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
    return {
      pass: false,
      detail: 'PIN must be exactly 4 digits.',
      retryFromVariable: 'PIN',
    };
  }
  const siblings = ctx.sessionDirectory
    ?.findOtherSessionsWithVariable(ctx.session.id, 'Trigram', trigram) ?? [];
  // A finished session keeps its trigram because the cluster resources named
  // after it (`rbo-vm`, `rbo-proj`…) outlive the session. Mock has no cluster,
  // and every mock session pre-seeds the same `dev` identity, so a finished
  // mock run must not swallow the next one.
  const others = ctx.nutanix.mode === 'mock'
    ? siblings.filter((s) => s.finishedAt === null)
    : siblings;
  if (others.length > 0) {
    const submittedPin = ctx.vars.get('PIN');
    // Match on the PIN, not on recency: a trigram can carry several sessions
    // and the player owns whichever one their PIN opens. Prefer one still in
    // play so a live game wins over a finished namesake.
    const opened = typeof submittedPin === 'string'
      ? others.filter((s) => ctx.sessionDirectory?.getVariable(s.sessionId, 'PIN') === submittedPin)
      : [];
    const target = opened.find((s) => s.finishedAt === null) ?? opened[0];
    if (target) {
      ctx.logger.info('trigram+pin match → swap to existing session', {
        trigram,
        target: target.sessionId,
      });
      return { pass: false, switchTo: target.sessionId };
    }
    ctx.logger.warn('trigram collision with PIN mismatch', { trigram });
    return {
      pass: false,
      detail: `Agent code "${trigram}" is already claimed. Wrong PIN — try again, or press ↓ to switch agent.`,
      retryFromVariable: 'PIN',
    };
  }
  ctx.logger.info('trigram validated (new agent)', { trigram });
  return {
    pass: true,
    detail: `Welcome, agent ${trigram}.`,
    captured: { Trigram: trigram },
  };
}

/**
 * Stage 6 `create-admin-user`. Verifies that `{Trigram}-adm` exists in
 * Nutanix IAM. Captures the user's extId so downstream stages that reference
 * the same user (e.g. the authorization policy) can find it via
 * `ctx.cache.get('user', …)`.
 */
async function CheckUser(ctx: CheckContext): Promise<CheckResult> {
  const trigram = getTrigram(ctx);
  const expected = `${trigram}-adm`;
  const expectedLc = expected.toLowerCase();
  try {
    const users = await listAll<{ extId?: string; name?: string; username?: string }>(
      ctx,
      '/api/iam/v4.0/authn/users',
    );
    // v4 IAM normalizes `username` to lowercase on store — `qaE-adm` POSTed
    // becomes `qae-adm` in the list. `name` may carry the original casing
    // on some shapes, so check both with case-insensitive compare to stay
    // tolerant.
    const found = users.find(
      (u) =>
        (u.username ?? '').toLowerCase() === expectedLc ||
        (u.name ?? '').toLowerCase() === expectedLc,
    );
    if (!found) {
      return { pass: false, detail: `User '${expected}' not found.` };
    }
    if (found.extId) {
      ctx.cache.set({ kind: 'user', logicalName: expected, uuid: found.extId });
    }
    return { pass: true, detail: `User '${expected}' found.` };
  } catch (err) {
    return { pass: false, detail: `IAM query failed: ${nutanixErrorDetail(err)}` };
  }
}

/**
 * Stage 7 `create-auth-policy`. Mirrors Python `CheckAuthPolicy` →
 * `checkAuthorizationPolicyAssignement` : verifies `{Trigram}-auth` exists
 * and asserts (a) `role` matches the `Super Admin` system role's extId,
 * (b) at least one identity entry has `identityFilter.user.uuid.anyof`
 * containing the `{Trigram}-adm` user's uuid (resolved by name at check
 * time). Without these, a player could pass with a policy that grants the
 * wrong role or targets a different user.
 */
async function CheckAuthPolicy(ctx: CheckContext): Promise<CheckResult> {
  const trigram = getTrigram(ctx);
  const expected = `${trigram}-auth`;
  const expectedLc = expected.toLowerCase();
  try {
    // The user binding is the point of this stage — no user, no pass.
    const userUuid = await lookupUserUuid(ctx, `${trigram}-adm`);
    if (!userUuid) {
      return { pass: false, detail: `User '${trigram}-adm' not found on the cluster.` };
    }
    // v4 authz policies carry the identifier on `displayName`. Top-level
    // `name` is null in list responses — the cached `cacheEntity` helper
    // only matches on `name`, so open-code the find+cache here. Match
    // case-insensitive because v4 IAM lowercases identifiers (a
    // policy POSTed as `qaE-auth` reads back as `qae-auth`).
    const policies = await listAll<{
      extId?: string;
      name?: string;
      displayName?: string;
      role?: string;
      identities?: Array<{
        identityFilter?: { user?: { uuid?: { anyof?: string[] } } };
        $reserved?: { user?: { uuid?: { anyof?: string[] } } };
      }>;
    }>(ctx, '/api/iam/v4.0/authz/authorization-policies');
    const found = policies.find(
      (p) => (p.displayName ?? '').toLowerCase() === expectedLc,
    );
    if (!found) {
      return { pass: false, detail: `Authorization policy '${expected}' not found.` };
    }
    // Look up the Super Admin role's extId so we can compare. v4 IAM
    // exposes role names on `displayName` (top-level `name` is empty
    // on system roles).
    const roles = await listAll<{ extId?: string; displayName?: string }>(
      ctx,
      '/api/iam/v4.0/authz/roles',
    );
    const superAdmin = roles.find((r) => /super admin/i.test(r.displayName ?? ''));
    if (superAdmin?.extId && found.role !== superAdmin.extId) {
      return {
        pass: false,
        detail: `Authorization policy '${expected}' is not bound to the Super Admin role.`,
      };
    }
    const userBound = (found.identities ?? []).some((id) => {
      const anyof =
        id.identityFilter?.user?.uuid?.anyof ?? id.$reserved?.user?.uuid?.anyof ?? [];
      return anyof.includes(userUuid);
    });
    if (!userBound) {
      return {
        pass: false,
        detail: `Authorization policy '${expected}' does not target '${trigram}-adm'.`,
      };
    }
    if (found.extId) {
      ctx.cache.set({ kind: 'authPolicy', logicalName: expected, uuid: found.extId });
    }
    return {
      pass: true,
      detail: `Authorization policy '${expected}' grants Super Admin to '${trigram}-adm'.`,
    };
  } catch (err) {
    return { pass: false, detail: `IAM query failed: ${nutanixErrorDetail(err)}` };
  }
}

// ─── Projects & networking ───────────────────────────────────────────────

/**
 * Stage 9 `create-project`. Mirrors Python `CheckProject` (CheckLabs.py):
 * verifies `{Trigram}-proj` exists with `account_reference_list` non-empty
 * — that's what the "Infrastructure tab → Add infrastructure" step
 * populates (an *account* binding to the Nutanix cluster, not the bare
 * cluster reference). Without this, the project can't actually be used
 * as a Calm/NCM scope by downstream stages.
 *
 * v3 API (`POST /api/nutanix/v3/projects/list`); reads `spec.resources` —
 * Python reads the same path on this endpoint, the `status.resources`
 * mirror is server-rendered.
 */
async function CheckProject(ctx: CheckContext): Promise<CheckResult> {
  const trigram = getTrigram(ctx);
  const expected = `${trigram}-proj`;
  try {
    const projects = await listAllV3<{
      metadata?: { uuid?: string; name?: string };
      spec?: {
        name?: string;
        resources?: {
          account_reference_list?: unknown[];
          cluster_reference_list?: unknown[];
          subnet_reference_list?: unknown[];
          user_reference_list?: Array<{ name?: string; uuid?: string }>;
        };
      };
      status?: { name?: string };
    }>(ctx, '/api/nutanix/v3/projects/list');
    const found = projects.find(
      (p) => p.spec?.name === expected || p.status?.name === expected || p.metadata?.name === expected,
    );
    if (!found) return { pass: false, detail: `Project '${expected}' not found.` };
    const accounts = found.spec?.resources?.account_reference_list ?? [];
    if (accounts.length === 0) {
      return {
        pass: false,
        detail: `Project '${expected}' has no infrastructure — add the Nutanix cluster account in the Infrastructure tab.`,
      };
    }
    // The prompt asks for "user TheProjectManager as Project Admin" — required
    // so create-vm's Manage Ownership can set owner=theprojectmanager.
    const users = found.spec?.resources?.user_reference_list ?? [];
    if (!users.some((u) => (u.name ?? '').toLowerCase() === 'theprojectmanager')) {
      return {
        pass: false,
        detail: `Project '${expected}' is missing user TheProjectManager.`,
        hint: localizedHint(ctx, {
          en: `Add user TheProjectManager to the project (as Project Admin).`,
          fr: `Ajoutez l'utilisateur TheProjectManager au projet (comme Project Admin).`,
        }),
      };
    }
    if (found.metadata?.uuid) {
      ctx.cache.set({
        kind: 'project',
        logicalName: expected,
        uuid: found.metadata.uuid,
      });
    }
    return {
      pass: true,
      detail: `Project '${expected}' has ${accounts.length} infrastructure account(s) attached.`,
    };
  } catch (err) {
    return { pass: false, detail: `Project query failed: ${nutanixErrorDetail(err)}` };
  }
}

/**
 * Stage 10 `create-subnet`. Mirrors Python `CheckNetwork` →
 * `checkSubnetAdvanced`: verifies `{Trigram}-subnet` exists on the given
 * VLAN id and is created with `isAdvancedNetworking: true` (a.k.a. the
 * "Nutanix IPAM with advanced networking" mode the stage prompt asks for).
 * Without the advanced flag, AHV refuses to attach a 2-NIC VM combining
 * this subnet with the cluster's `secondary` subnet — CheckVM (stage 12)
 * would silently fail to create the VM.
 */
async function CheckNetwork(ctx: CheckContext): Promise<CheckResult> {
  const trigram = getTrigram(ctx);
  const expected = `${trigram}-subnet`;
  const vlanRaw = ctx.vars.get('Vlanid');
  const expectedVlan =
    typeof vlanRaw === 'number'
      ? vlanRaw
      : typeof vlanRaw === 'string' && vlanRaw.length > 0
      ? Number.parseInt(vlanRaw, 10)
      : Number.NaN;
  try {
    const subnets = await listAll<{
      extId?: string;
      name?: string;
      networkId?: number | string;
      isAdvancedNetworking?: boolean;
    }>(ctx, '/api/networking/v4.0/config/subnets');
    const found = subnets.find((s) => s.name === expected);
    if (!found) return { pass: false, detail: `Subnet '${expected}' not found.` };
    const actualVlan =
      typeof found.networkId === 'number'
        ? found.networkId
        : Number.parseInt(String(found.networkId), 10);
    if (Number.isFinite(expectedVlan) && actualVlan !== expectedVlan) {
      return {
        pass: false,
        detail: `Subnet '${expected}' on VLAN ${actualVlan} (expected ${expectedVlan}).`,
      };
    }
    if (found.isAdvancedNetworking !== true) {
      return {
        pass: false,
        detail: `Subnet '${expected}' is not in advanced-networking mode — re-create it with Nutanix IPAM enabled.`,
      };
    }
    if (found.extId) {
      ctx.cache.set({ kind: 'network', logicalName: expected, uuid: found.extId });
    }
    return {
      pass: true,
      detail: `Subnet '${expected}' found (VLAN ${actualVlan}, advanced networking).`,
    };
  } catch (err) {
    return { pass: false, detail: `Subnet query failed: ${nutanixErrorDetail(err)}` };
  }
}

// ─── VM lifecycle ────────────────────────────────────────────────────────

/**
 * Stage 11 `add-ubuntu-image`. Verifies `{Trigram}-ubuntu` exists in the
 * image library as a disk image (not an ISO — the stage prose is explicit).
 * CheckVM re-resolves the image by name when it verifies the boot disk.
 */
async function CheckImage(ctx: CheckContext): Promise<CheckResult> {
  const trigram = getTrigram(ctx);
  const expected = `${trigram}-ubuntu`;
  try {
    const images = await listAll<{
      extId?: string;
      name?: string;
      type?: string;
    }>(ctx, '/api/vmm/v4.0/content/images');
    const found = images.find((i) => i.name === expected);
    if (!found) return { pass: false, detail: `Image '${expected}' not found in library.` };
    if (found.type && !/^DISK/i.test(found.type)) {
      return {
        pass: false,
        detail: `Image '${expected}' has type '${found.type}' (expected DISK, not ISO).`,
      };
    }
    if (found.extId) {
      ctx.cache.set({ kind: 'image', logicalName: expected, uuid: found.extId });
    }
    return { pass: true, detail: `Image '${expected}' found (disk).` };
  } catch (err) {
    return { pass: false, detail: `Image query failed: ${nutanixErrorDetail(err)}` };
  }
}

/**
 * Stage 12 `create-vm`. Mirrors original Python `CheckVM` (CheckLabs.py)
 * plus our existing vCPU/memory/UEFI assertions. Verifies `{Trigram}-vm`:
 * exists, has 2 vCPU + memory + UEFI + power=ON (our additions), 2 NICs
 * with at least one on the player's `{Trigram}-subnet`, boot disk based on
 * the player's Ubuntu image, cloud-init present, and assigned to the
 * player's project. The last two read v3 endpoints (no v4 equivalent yet)
 * — defensive on errors per Python's `hasVMCloudinit` precedent (PC 7.3+
 * may not expose the field, so unreachable v3 → assume pass rather than
 * false-fail). Captures VMUUID + HostUUID for downstream stages.
 */
async function CheckVM(ctx: CheckContext): Promise<CheckResult> {
  const trigram = getTrigram(ctx);
  const expected = `${trigram}-vm`;
  try {
    // Filter server-side instead of paginating the full VM list — on a HPoC
    // with 100+ VMs that drops a multi-second pagination scan to a single
    // 1-page query. Name is unique per trigram so the filter returns 0/1.
    const vms = await listAll<{
      extId?: string;
      name?: string;
      numSockets?: number;
      numCoresPerSocket?: number;
      memorySizeBytes?: number;
      bootConfig?: { bootType?: string; '$objectType'?: string };
      host?: { extId?: string };
      powerState?: string;
      nics?: Array<{
        nicNetworkInfo?: { subnet?: { extId?: string } };
        networkInfo?: { subnet?: { extId?: string } };
      }>;
      disks?: Array<{
        backingInfo?: {
          dataSource?: { reference?: { imageExtId?: string } };
        };
      }>;
      guestCustomization?: unknown;
      // PC 7.x exposes the VM's project + owner directly on the v4 payload —
      // the reliable signal for the Manage Ownership step (v3 was flaky here).
      project?: { extId?: string };
      ownershipInfo?: { owner?: { extId?: string } };
    }>(ctx, `/api/vmm/v4.0/ahv/config/vms?%24filter=name%20eq%20'${expected}'`);
    const found = vms.find((v) => v.name === expected);
    if (!found) {
      return {
        pass: false,
        detail: `VM '${expected}' not found.`,
        hint: localizedHint(ctx, {
          en: `VM '${expected}' is missing — create it.`,
          fr: `La VM '${expected}' n'existe pas — créez-la.`,
        }),
      };
    }
    const vcpu = (found.numSockets ?? 1) * (found.numCoresPerSocket ?? 1);
    if (vcpu < 2) {
      return {
        pass: false,
        detail: `VM '${expected}' has ${vcpu} vCPU (expected ≥ 2).`,
        hint: localizedHint(ctx, {
          en: `Check the VM's vCPU configuration.`,
          fr: `Vérifiez la configuration vCPU de la VM.`,
        }),
      };
    }
    if (!found.memorySizeBytes || found.memorySizeBytes < 1) {
      return {
        pass: false,
        detail: `VM '${expected}' has no memory configured.`,
        hint: localizedHint(ctx, {
          en: `Check the VM's memory configuration.`,
          fr: `Vérifiez la configuration mémoire de la VM.`,
        }),
      };
    }
    const bootTypeOk =
      /UEFI/i.test(found.bootConfig?.bootType ?? '') ||
      /UefiBoot/i.test(found.bootConfig?.['$objectType'] ?? '');
    if (found.bootConfig && !bootTypeOk) {
      return {
        pass: false,
        detail: `VM '${expected}' boot mode not UEFI.`,
        hint: localizedHint(ctx, {
          en: `Check the VM's boot mode.`,
          fr: `Vérifiez le mode de démarrage de la VM.`,
        }),
      };
    }
    if (found.powerState !== 'ON') {
      return {
        pass: false,
        detail: `VM '${expected}' is not powered ON (state=${found.powerState ?? 'unknown'}).`,
        hint: localizedHint(ctx, {
          en: `VM is powered off — start it.`,
          fr: `La VM est éteinte — démarrez-la.`,
        }),
      };
    }
    // NIC count + subnet binding, subnet resolved by name (issue #31).
    // Transport blip → skip the assertion; real miss → fail.
    const nics = found.nics ?? [];
    if (nics.length !== 2) {
      return {
        pass: false,
        detail: `VM '${expected}' has ${nics.length} NIC(s) (expected 2).`,
        hint: localizedHint(
          ctx,
          nics.length < 2
            ? {
                en: `VM is missing a NIC — you need 2 (one per subnet).`,
                fr: `Il manque une NIC à la VM — il en faut 2 (une par sous-réseau).`,
              }
            : {
                en: `VM has too many NICs.`,
                fr: `La VM a trop de NICs.`,
              },
        ),
      };
    }
    const net = await lookupOrSkip(ctx, 'CheckVM: subnet', () =>
      lookupSubnetUuid(ctx, `${trigram}-subnet`),
    );
    if (!net.failed && !net.uuid) {
      return {
        pass: false,
        detail: `Subnet '${trigram}-subnet' not found on the cluster.`,
        hint: localizedHint(ctx, {
          en: `Your '${trigram}-subnet' is missing — re-create it.`,
          fr: `Votre '${trigram}-subnet' n'existe plus — re-créez-le.`,
        }),
      };
    }
    if (net.uuid) {
      const onSubnet = nics.some(
        (n) =>
          n?.nicNetworkInfo?.subnet?.extId === net.uuid ||
          n?.networkInfo?.subnet?.extId === net.uuid,
      );
      if (!onSubnet) {
        return {
          pass: false,
          detail: `VM '${expected}' has no NIC on '${trigram}-subnet'.`,
          hint: localizedHint(ctx, {
            en: `One of the VM's NICs should be on your '${trigram}-subnet'.`,
            fr: `Une des NICs de la VM doit être sur votre '${trigram}-subnet'.`,
          }),
        };
      }
    }
    // Boot disk image binding — same treatment.
    const img = await lookupOrSkip(ctx, 'CheckVM: image', () =>
      lookupImageUuid(ctx, `${trigram}-ubuntu`),
    );
    if (!img.failed && !img.uuid) {
      return { pass: false, detail: `Image '${trigram}-ubuntu' not found in library.` };
    }
    if (img.uuid) {
      const disks = found.disks ?? [];
      const bootImg = disks[0]?.backingInfo?.dataSource?.reference?.imageExtId;
      if (bootImg !== img.uuid) {
        return {
          pass: false,
          detail: `VM '${expected}' boot disk is not based on '${trigram}-ubuntu'.`,
          hint: localizedHint(ctx, {
            en: `Check the VM's boot disk image source.`,
            fr: `Vérifiez l'image source du disque de boot de la VM.`,
          }),
        };
      }
    }
    // Player's project, by name (v3 — projects have no v4 home).
    const proj = await lookupOrSkip(ctx, 'CheckVM: project', () =>
      lookupProjectUuid(ctx, `${trigram}-proj`),
    );
    if (!proj.failed && !proj.uuid) {
      return { pass: false, detail: `Project '${trigram}-proj' not found.` };
    }
    // Cloud-init: v4 GET stops returning `guestCustomization` on PC 7.3+
    // (always null even when set); the v3 mirror also drops the key. Mirror
    // Python `hasVMCloudinit`: only fail when v3 explicitly returns the key
    // with a null value; absent key OR HTTP error → assume pass.
    let cloudInitOk = !!found.guestCustomization;
    if (!cloudInitOk && found.extId) {
      try {
        const v3vm = await ctx.nutanix.rest.request<{
          spec?: { resources?: Record<string, unknown> };
        }>('GET', `/api/nutanix/v3/vms/${found.extId}`);
        const resources = v3vm?.spec?.resources;
        cloudInitOk = resources && 'guest_customization' in resources
          ? resources.guest_customization != null
          : true; // key absent → defensive pass
      } catch {
        cloudInitOk = true; // v3 unreachable → defensive pass
      }
    }
    if (!cloudInitOk) {
      return {
        pass: false,
        detail: `VM '${expected}' missing cloud-init.`,
        hint: localizedHint(ctx, {
          en: `VM has no cloud-init configured.`,
          fr: `La VM n'a pas de cloud-init configuré.`,
        }),
      };
    }
    // Manage Ownership sets BOTH the project and the owner on the VM (the
    // Prism dialog requires both). Read them straight from the v4 payload —
    // reliable on PC 7.x where v3 was flaky.
    if (proj.uuid) {
      const vmProj = found.project?.extId;
      if (!vmProj || vmProj !== proj.uuid) {
        return {
          pass: false,
          detail: `VM '${expected}' project is '${vmProj ?? 'none'}', expected '${proj.uuid}'.`,
          hint: localizedHint(ctx, {
            en: `VM is not in your project — use Manage Ownership.`,
            fr: `La VM n'est pas dans votre projet — utilisez Manage Ownership.`,
          }),
        };
      }
    }
    // Owner must be theprojectmanager (a project member, added at create-project).
    const pm = await lookupOrSkip(ctx, 'CheckVM: owner user', () =>
      lookupUserUuid(ctx, 'theprojectmanager'),
    );
    if (!pm.failed && !pm.uuid) {
      return { pass: false, detail: `User 'theprojectmanager' not found on the cluster.` };
    }
    if (pm.uuid) {
      const owner = found.ownershipInfo?.owner?.extId;
      if (owner !== pm.uuid) {
        return {
          pass: false,
          detail: `VM '${expected}' owner is '${owner ?? 'none'}', expected theprojectmanager.`,
          hint: localizedHint(ctx, {
            en: `Set the VM owner to TheProjectManager via Manage Ownership.`,
            fr: `Définissez TheProjectManager comme propriétaire de la VM via Manage Ownership.`,
          }),
        };
      }
    }
    if (found.extId) {
      ctx.cache.set({ kind: 'vm', logicalName: expected, uuid: found.extId });
    }
    const captured: Record<string, unknown> = {};
    if (found.extId) captured.VMUUID = found.extId;
    if (found.host?.extId) captured.HostUUID = found.host.extId;
    return {
      pass: true,
      detail: `VM '${expected}' found (${vcpu} vCPU, UEFI, 2 NICs, cloud-init, running).`,
      captured: Object.keys(captured).length > 0 ? captured : undefined,
    };
  } catch (err) {
    return { pass: false, detail: `VM query failed: ${nutanixErrorDetail(err)}` };
  }
}

/**
 * Stage 14 `live-migrate-vm`. Verifies the VM is now on a host different
 * from the one CheckVM captured as HostUUID. In mock mode, the fixture
 * returns a different host id on the second query (post-migration), which
 * is enough to exercise the check logic. Deeper validation (was an actual
 * migration task initiated, not just a metadata change) needs a live PC.
 */
async function CheckLiveMigration(ctx: CheckContext): Promise<CheckResult> {
  const trigram = getTrigram(ctx);
  const expected = `${trigram}-vm`;
  const previousHost = ctx.vars.get('HostUUID');
  if (typeof previousHost !== 'string' || previousHost.length === 0) {
    return {
      pass: false,
      detail: 'Previous host unknown — CheckVM must have run and captured HostUUID.',
    };
  }
  try {
    const vms = await listAll<{ name?: string; host?: { extId?: string } }>(
      ctx,
      '/api/vmm/v4.0/ahv/config/vms',
    );
    const found = vms.find((v) => v.name === expected);
    if (!found) return { pass: false, detail: `VM '${expected}' not found.` };
    const currentHost = found.host?.extId;
    if (!currentHost) {
      return { pass: false, detail: `VM '${expected}' has no host assignment.` };
    }
    if (currentHost === previousHost) {
      // Mock fixtures are static — a second query returns the same host id.
      // Treat as pass in mock mode and flag the assumption; a live cluster
      // will actually see the host field change after migration.
      if (ctx.nutanix.mode === 'mock') {
        return {
          pass: true,
          detail: `VM '${expected}' migration assumed (mock replays a single host).`,
        };
      }
      return {
        pass: false,
        detail: `VM '${expected}' still on host ${currentHost} — migrate it to another node.`,
      };
    }
    return {
      pass: true,
      detail: `VM '${expected}' migrated from ${previousHost} to ${currentHost}.`,
      captured: { HostUUID: currentHost },
    };
  } catch (err) {
    return { pass: false, detail: `VM query failed: ${nutanixErrorDetail(err)}` };
  }
}

/**
 * Stage 26 `restore-vm-from-recovery`. Verifies `{Trigram}-vm` exists again
 * after the incident deleted it. Live validation would verify the VM's
 * creation timestamp is post-incident and that a recovery-point reference
 * lingers in its metadata; here we only assert presence because the mock
 * replays a static fixture.
 */
async function CheckRestoreVM(ctx: CheckContext): Promise<CheckResult> {
  const trigram = getTrigram(ctx);
  const expected = `${trigram}-vm`;
  try {
    const vms = await listAll<{ extId?: string; name?: string; powerState?: string }>(
      ctx,
      '/api/vmm/v4.0/ahv/config/vms',
    );
    const found = vms.find((v) => v.name === expected);
    if (!found) {
      return {
        pass: false,
        detail: `VM '${expected}' still missing — restore it from a recovery point.`,
      };
    }
    // Match the original Python CheckRestoreVM: restored VM must be running.
    if (found.powerState !== 'ON') {
      return {
        pass: false,
        detail: `VM '${expected}' restored but powered-off — start it.`,
      };
    }
    if (found.extId) {
      ctx.cache.set({ kind: 'vm', logicalName: expected, uuid: found.extId });
    }
    return {
      pass: true,
      detail: `VM '${expected}' restored and running.`,
      captured: found.extId ? { VMUUID: found.extId } : undefined,
    };
  } catch (err) {
    return { pass: false, detail: `VM query failed: ${nutanixErrorDetail(err)}` };
  }
}

// ─── Categories ──────────────────────────────────────────────────────────

/**
 * Stage 15 `create-category`. Verifies the `{Trigram}-cat` category carries
 * both `Critical` and `Test` values (v4 models each key:value as a separate
 * category entity). CheckCatVM and CheckSecurityPolicy re-resolve the
 * `Critical` entity by key:value when they need it.
 */
async function CheckCat(ctx: CheckContext): Promise<CheckResult> {
  const trigram = getTrigram(ctx);
  const expectedKey = `${trigram}-cat`;
  try {
    const categories = await listAll<{ extId?: string; key?: string; value?: string }>(
      ctx,
      '/api/prism/v4.2/config/categories',
    );
    const matching = categories.filter((c) => c.key === expectedKey);
    const values = new Set(matching.map((c) => c.value).filter((v): v is string => !!v));
    const missing = ['Critical', 'Test'].filter((v) => !values.has(v));
    if (missing.length > 0) {
      return {
        pass: false,
        detail: `Category '${expectedKey}' missing values: ${missing.join(', ')}.`,
      };
    }
    for (const c of matching) {
      if (c.extId && c.value) {
        ctx.cache.set({
          kind: 'category',
          logicalName: `${expectedKey}:${c.value}`,
          uuid: c.extId,
        });
      }
    }
    return {
      pass: true,
      detail: `Category '${expectedKey}' created with values Critical + Test.`,
    };
  } catch (err) {
    return { pass: false, detail: `Category query failed: ${nutanixErrorDetail(err)}` };
  }
}

/**
 * Stage 16 `apply-category-to-vm`. Verifies `{Trigram}-vm` has the
 * `{Trigram}-cat:Critical` category applied (entity resolved by key:value
 * at check time). In v4, VMs carry a `categories` list of category-entity
 * references.
 */
async function CheckCatVM(ctx: CheckContext): Promise<CheckResult> {
  const trigram = getTrigram(ctx);
  const vmName = `${trigram}-vm`;
  try {
    const catUuid = await lookupCategoryUuid(ctx, `${trigram}-cat`, 'Critical');
    if (!catUuid) {
      return {
        pass: false,
        detail: `Category '${trigram}-cat:Critical' not found on the cluster — re-create it.`,
      };
    }
    // The list endpoint's default projection omits `categories` entirely —
    // we have to opt in via `$select=extId,name,categories`. Also note the
    // path is v4.2 on live (v4.0 works too, but v4.2 is what actually
    // honors the $select field reliably).
    const vms = await listAll<{
      extId?: string;
      name?: string;
      categories?: Array<{ extId?: string }>;
    }>(ctx, '/api/vmm/v4.2/ahv/config/vms?%24select=extId,name,categories');
    const vm = vms.find((v) => v.name === vmName);
    if (!vm) return { pass: false, detail: `VM '${vmName}' not found.` };
    const applied = (vm.categories ?? []).some((c) => c.extId === catUuid);
    if (!applied) {
      return {
        pass: false,
        detail: `VM '${vmName}' has no '${trigram}-cat:Critical' category — apply it.`,
      };
    }
    return {
      pass: true,
      detail: `Category '${trigram}-cat:Critical' applied to '${vmName}'.`,
    };
  } catch (err) {
    return { pass: false, detail: `VM query failed: ${nutanixErrorDetail(err)}` };
  }
}

// ─── Storage + security + protection + approval ─────────────────────────

/**
 * Stage 17 `create-storage-policy`. Verifies `{Trigram}-sto-policy` exists
 * with encryption enabled. Live path is `/api/datapolicies/v4.2/config/
 * storage-policies` (namespace moved from the provisional `storage` guess);
 * shape is `encryptionSpec.encryptionState` — any value other than
 * `NO_ENCRYPTION` counts as encrypted (`INLINE`, `SYSTEM_DERIVED`, etc.).
 */
async function CheckStoragePolicy(ctx: CheckContext): Promise<CheckResult> {
  const trigram = getTrigram(ctx);
  const expected = `${trigram}-sto-policy`;
  try {
    const policies = await listAll<{
      extId?: string;
      name?: string;
      encryptionSpec?: { encryptionState?: string };
    }>(ctx, '/api/datapolicies/v4.2/config/storage-policies');
    const found = policies.find((p) => p.name === expected);
    if (!found) return { pass: false, detail: `Storage policy '${expected}' not found.` };
    const encState = found.encryptionSpec?.encryptionState ?? 'NO_ENCRYPTION';
    if (encState === 'NO_ENCRYPTION') {
      return { pass: false, detail: `Storage policy '${expected}' does not have encryption enabled.` };
    }
    if (found.extId) {
      ctx.cache.set({ kind: 'storagePolicy', logicalName: expected, uuid: found.extId });
    }
    return {
      pass: true,
      detail: `Storage policy '${expected}' with encryption (${encState}).`,
      captured: found.extId ? { StoragePolicyUUID: found.extId } : undefined,
    };
  } catch (err) {
    return { pass: false, detail: `Storage policy query failed: ${nutanixErrorDetail(err)}` };
  }
}

/**
 * Common rule shape on a v4 microseg policy. The list endpoint omits `rules`,
 * so checks that need rule-level assertions GET the policy by id.
 */
interface MsegRuleSpec {
  $objectType?: string;
  securedGroupCategoryAssociatedEntityType?: string;
  securedGroupCategoryReferences?: string[];
  srcAllowSpec?: string;
  destAllowSpec?: string;
  srcSubnet?: { value?: string; prefixLength?: number };
  isAllProtocolAllowed?: boolean;
  tcpServices?: Array<{ startPort?: number; endPort?: number }>;
  udpServices?: Array<{ startPort?: number; endPort?: number }>;
  icmpServices?: Array<{ type?: number; code?: number; isAllAllowed?: boolean }>;
  serviceGroupReferences?: string[];
}
interface MsegRule {
  description?: string;
  type?: string;
  spec?: MsegRuleSpec;
}

/**
 * Stage 18 `create-microseg-policy`. Mirrors the original Python check from
 * ntnx-escape-game (`CheckSecurityPolicy`) — beyond name + ENFORCE state we
 * verify the player scoped the policy to their `{Trigram}-cat:Critical`
 * category and added at least one outbound allow-all rule.
 */
async function CheckSecurityPolicy(ctx: CheckContext): Promise<CheckResult> {
  const trigram = getTrigram(ctx);
  const expected = `${trigram}-mseg-policy`;
  try {
    // Scoping to the category is the point — no category, no pass.
    const catUuid = await lookupCategoryUuid(ctx, `${trigram}-cat`, 'Critical');
    if (!catUuid) {
      return {
        pass: false,
        detail: `Category '${trigram}-cat:Critical' not found on the cluster — re-create it.`,
      };
    }
    const policies = await listAll<{ extId?: string; name?: string; state?: string }>(
      ctx,
      '/api/microseg/v4.0/config/policies',
    );
    const found = policies.find((p) => p.name === expected);
    if (!found?.extId) {
      return { pass: false, detail: `Security policy '${expected}' not found.` };
    }
    if (found.state && !/ENFORCE/i.test(found.state)) {
      return {
        pass: false,
        detail: `Security policy '${expected}' in state '${found.state}' (expected ENFORCE).`,
      };
    }
    const detail = await ctx.nutanix.request<{ data?: { rules?: MsegRule[] } }>(
      'GET',
      `/api/microseg/v4.0/config/policies/${found.extId}`,
    );
    const rules = detail?.data?.rules ?? [];
    const scoped = rules.some((r) =>
      (r.spec?.securedGroupCategoryReferences ?? []).includes(catUuid),
    );
    if (!scoped) {
      return {
        pass: false,
        detail: `Security policy '${expected}' is not scoped to '${trigram}-cat:Critical'.`,
      };
    }
    // Python `CheckSecurityPolicy` only asserts "≥1 rule has
    // is_all_protocol_allowed" (no destAllowSpec clause). Match the
    // permissive shape so a hand-crafted policy that uses a different
    // direction for the allow-all rule still passes.
    const hasAllProtocol = rules.some((r) => r.spec?.isAllProtocolAllowed === true);
    if (!hasAllProtocol) {
      return {
        pass: false,
        detail: `Security policy '${expected}' missing an allow-all-protocol rule.`,
      };
    }
    ctx.cache.set({ kind: 'securityPolicy', logicalName: expected, uuid: found.extId });
    return { pass: true, detail: `Security policy '${expected}' in enforce mode.` };
  } catch (err) {
    return { pass: false, detail: `Security policy query failed: ${nutanixErrorDetail(err)}` };
  }
}

/**
 * Stage 19 `allow-ssh-in-microseg`. Diverges intentionally from the Python
 * `CheckSecurityPolicy2` (which rejected ANY rule referencing the built-in
 * `ssh` service group). The prompt tells the player to add a Traffic Filter
 * "ssh from {frontendHost} only" — so we now assert what the prompt actually
 * asks for:
 *   (a) at least one inbound rule opens SSH (references the `ssh` service
 *       group OR covers tcp/22) AND is restricted to the `frontendHost` source
 *       IP (`srcSubnet`), never `srcAllowSpec: ALL`;
 *   (b) at least one rule has `icmpServices` populated.
 * Both ways of expressing the SSH rule (the `ssh` service group with a source
 * filter, or a raw tcp/22 + source filter) pass — what matters is that SSH is
 * locked to the IP, not open to the world.
 */
async function CheckSecurityPolicy2(ctx: CheckContext): Promise<CheckResult> {
  const trigram = getTrigram(ctx);
  const expected = `${trigram}-mseg-policy`;
  const frontendHost = String(ctx.vars.get('frontendHost') ?? '').trim();
  try {
    const policies = await listAll<{ extId?: string; name?: string }>(
      ctx,
      '/api/microseg/v4.0/config/policies',
    );
    const listEntry = policies.find((p) => p.name === expected);
    if (!listEntry?.extId) {
      return { pass: false, detail: `Security policy '${expected}' not found.` };
    }
    // The built-in `ssh` service group is one of the two valid ways to express
    // the SSH rule; look up its extId so we recognise it. Missing on older PCs
    // is fine — a raw tcp/22 rule is the other accepted shape.
    const serviceGroups = await listAll<{ extId?: string; name?: string }>(
      ctx,
      '/api/microseg/v4.0/config/service-groups',
    );
    const sshExtId = serviceGroups.find((g) => g.name === 'ssh')?.extId;
    const detail = await ctx.nutanix.request<{ data?: { rules?: MsegRule[] } }>(
      'GET',
      `/api/microseg/v4.0/config/policies/${listEntry.extId}`,
    );
    const rules = detail?.data?.rules ?? [];

    // A rule "opens SSH" if it references the `ssh` service group or covers tcp/22.
    const opensSsh = (s: MsegRuleSpec): boolean => {
      if (s.destAllowSpec) return false; // outbound rule — not an inbound SSH allowance
      if (sshExtId && (s.serviceGroupReferences ?? []).includes(sshExtId)) return true;
      return (s.tcpServices ?? []).some((t) => (t.startPort ?? 0) <= 22 && (t.endPort ?? 0) >= 22);
    };
    const sshRules = rules.filter((r) => r.spec && opensSsh(r.spec));
    if (sshRules.length === 0) {
      return { pass: false, detail: `Security policy '${expected}' has no SSH rule — add an inbound 'ssh' Traffic Filter.` };
    }
    // SSH must never be open to all sources.
    if (sshRules.some((r) => r.spec?.srcAllowSpec === 'ALL')) {
      return {
        pass: false,
        detail: `Security policy '${expected}' allows SSH from anywhere — restrict the SSH Traffic Filter to source ${frontendHost || 'IP'} only.`,
      };
    }
    // …and at least one SSH rule must be scoped to the expected source IP.
    const restricted = sshRules.some((r) => {
      const sub = r.spec?.srcSubnet;
      if (!sub) return false;
      // No frontendHost to pin against (offline/misconfigured, or mock with no
      // GAME_FRONTEND_HOST so the fixture's `{frontendHost}` resolves to '') —
      // at least demand a single-host /32 so a broad range like 0.0.0.0/0 can't
      // sneak through.
      return frontendHost ? sub.value === frontendHost : sub.prefixLength === 32;
    });
    if (!restricted) {
      const want = frontendHost ? ` to ${frontendHost}` : ' to a specific source IP';
      return { pass: false, detail: `Security policy '${expected}' SSH Traffic Filter is not restricted${want}.` };
    }
    // ICMP must be present.
    const hasIcmp = rules.some((r) => (r.spec?.icmpServices ?? []).length > 0);
    if (!hasIcmp) {
      return {
        pass: false,
        detail: `Security policy '${expected}' missing an ICMP rule — add it as a Traffic Filter.`,
      };
    }
    return { pass: true, detail: `Security policy '${expected}' SSH restricted to ${frontendHost || 'source IP'} + ICMP allowed.` };
  } catch (err) {
    return { pass: false, detail: `Security policy query failed: ${nutanixErrorDetail(err)}` };
  }
}

/**
 * Stage 20 `create-protection-policy`. Mirrors Python `CheckProtectionPolicy`
 * (CheckLabs.py): verifies `{Trigram}-prot-policy` exists with
 * (a) RPO = 3600s,
 * (b) DAILY auto-rollup retention,
 * (c) scoped to category `{Trigram}-cat`,
 * (d) the category's bound value is `Critical` (matches the stage prompt:
 *     "catégorie {Trigram}-cat et la valeur Critical"). This intentionally
 *     diverges from the Python check, which rejected `Critical`.
 * Field paths use v4 datapolicies shape: `replicationConfigurations[].schedule`
 * + `categories[]` (each `{name, value}` per category-binding entry).
 */
async function CheckProtectionPolicy(ctx: CheckContext): Promise<CheckResult> {
  const trigram = getTrigram(ctx);
  const expected = `${trigram}-prot-policy`;
  const expectedCatKey = `${trigram}-cat`;
  try {
    const policies = await listAll<{
      extId?: string;
      name?: string;
      replicationConfigurations?: Array<{
        schedule?: {
          recoveryPointObjectiveTimeSeconds?: number;
          retention?: {
            local?: { snapshotIntervalType?: string };
          };
        };
      }>;
      categoryIds?: string[];
    }>(ctx, '/api/datapolicies/v4.2/config/protection-policies');
    const found = policies.find((p) => p.name === expected);
    if (!found) return { pass: false, detail: `Protection policy '${expected}' not found.` };
    const schedules = (found.replicationConfigurations ?? [])
      .map((r) => r.schedule)
      .filter((s): s is NonNullable<typeof s> => !!s);
    if (schedules.length === 0) {
      return {
        pass: false,
        detail: `Protection policy '${expected}' has no schedule — add a local hourly snapshot.`,
      };
    }
    if (!schedules.some((s) => s.recoveryPointObjectiveTimeSeconds === 3600)) {
      return {
        pass: false,
        detail: `Protection policy '${expected}' RPO is not 1 hour (3600 s).`,
      };
    }
    if (!schedules.some((s) => s.retention?.local?.snapshotIntervalType === 'DAILY')) {
      return {
        pass: false,
        detail: `Protection policy '${expected}' retention is not DAILY — set the auto-rollup interval to DAILY.`,
      };
    }
    // v4 binds via `categoryIds: [extId]` — resolve each id back to its
    // {key, value} pair so we can assert the player attached to their own
    // category AND chose the non-critical tier (Python's intent: snapshot
    // the low-impact entities, not the production-critical ones).
    const allCats = await listAll<{ extId?: string; key?: string; value?: string }>(
      ctx,
      '/api/prism/v4.2/config/categories',
    );
    const boundCats = (found.categoryIds ?? [])
      .map((id) => allCats.find((c) => c.extId === id))
      .filter((c): c is NonNullable<typeof c> => !!c);
    const matchingCat = boundCats.find((c) => c.key === expectedCatKey);
    if (!matchingCat) {
      return {
        pass: false,
        detail: `Protection policy '${expected}' is not scoped to '${expectedCatKey}'.`,
      };
    }
    if (matchingCat.value !== 'Critical') {
      return {
        pass: false,
        detail: `Protection policy '${expected}' targets '${expectedCatKey}:${matchingCat.value ?? 'unknown'}' — re-target to '${expectedCatKey}:Critical'.`,
      };
    }
    if (found.extId) {
      ctx.cache.set({ kind: 'protectionPolicy', logicalName: expected, uuid: found.extId });
    }
    return {
      pass: true,
      detail: `Protection policy '${expected}' (RPO=3600s, DAILY rollup, scoped to '${matchingCat.key}:${matchingCat.value}').`,
    };
  } catch (err) {
    return { pass: false, detail: `Protection policy query failed: ${nutanixErrorDetail(err)}` };
  }
}

/**
 * Stage 21 `create-approval-policy`. Verifies `master-appr-policy` (fixed
 * name — not namespaced by trigram because it's cluster-wide) exists and is
 * linked to the player's protection policy. Cluster-wide approval policies
 * are sensitive on shared profiles; this stage is a candidate for
 * `impact: 'hpoc-only'` in Phase 11. Live path is
 * `/api/security/v4.1/management/approval-policies` (approvals live inside
 * the security namespace on v4, not the guessed `/approvals/`).
 */
async function CheckApprovalPolicy(ctx: CheckContext): Promise<CheckResult> {
  const trigram = getTrigram(ctx);
  const expectedName = 'master-appr-policy';
  try {
    // The protection-policy link is the point — no policy, no pass.
    const protectionUuid = await lookupProtectionPolicyUuid(ctx, `${trigram}-prot-policy`);
    if (!protectionUuid) {
      return {
        pass: false,
        detail: `Protection policy '${trigram}-prot-policy' not found on the cluster.`,
      };
    }
    // Linked protection policies live on `securedPolicies[]` (not
    // `targetPolicyExtIds` — that's the create-time DTO only). Each entry
    // has `policyExtId` + `policyType: 'PROTECTION_POLICY'`. Confirmed
    // against the live PC + the original Python `CheckApprovalPolicy` in
    // `r0w/ntnx-escape-game`. The link is wired via a separate
    // `$actions/associate-policies` POST, not by a write to securedPolicies
    // directly (that field is read-only in the schema).
    const policies = await listAll<{
      extId?: string;
      name?: string;
      securedPolicies?: Array<{ policyExtId?: string; policyType?: string }>;
    }>(ctx, '/api/security/v4.1/management/approval-policies');
    const found = policies.find((p) => p.name === expectedName);
    if (!found) {
      return {
        pass: false,
        detail: `Approval policy '${expectedName}' not found.`,
      };
    }
    const linked = (found.securedPolicies ?? []).some(
      (sp) => sp.policyExtId === protectionUuid,
    );
    if (!linked) {
      return {
        pass: false,
        detail: `Approval policy not linked to your protection policy — associate them.`,
      };
    }
    if (found.extId) {
      ctx.cache.set({ kind: 'approvalPolicy', logicalName: expectedName, uuid: found.extId });
    }
    return { pass: true, detail: `Approval policy '${expectedName}' linked.` };
  } catch (err) {
    return { pass: false, detail: `Approval policy query failed: ${nutanixErrorDetail(err)}` };
  }
}

// ─── Reports, NCM playbook, capacity + updates ──────────────────────────

/**
 * Stage 27 `create-report`. Mirrors Python `CheckReport` (CheckLabs.py):
 * verifies `{Trigram}-report` exists with
 * (a) DAILY schedule (`schedule.scheduleInterval === 'DAILY'`),
 * (b) recipient email = `{Trigram}{EmailReport}`
 *     (`notificationPolicy.recipients[].emailAddress`),
 * (c) at least one widget targeting `entityType === 'VM'`
 *     (`sections[].rows[].widgets[].widgetInfo.entityType`).
 * v4 paths confirmed against an existing live `cur-report`. Field names
 * differ from the v3 ones the original Python read but the assertions
 * are the same.
 */
async function CheckReport(ctx: CheckContext): Promise<CheckResult> {
  const trigram = getTrigram(ctx);
  const expected = `${trigram}-report`;
  const emailSuffix = ctx.vars.get('EmailReport');
  const expectedEmail =
    typeof emailSuffix === 'string' && emailSuffix.length > 0
      ? `${trigram}${emailSuffix}`
      : undefined;
  try {
    const reports = await listAll<{
      extId?: string;
      name?: string;
      schedule?: { scheduleInterval?: string };
      notificationPolicy?: {
        recipients?: Array<{ emailAddress?: string }>;
      };
      sections?: Array<{
        rows?: Array<{
          widgets?: Array<{
            widgetInfo?: { entityType?: string };
          }>;
        }>;
      }>;
    }>(ctx, '/api/opsmgmt/v4.0/config/report-configs');
    const found = reports.find((r) => r.name === expected);
    if (!found) return { pass: false, detail: `Report '${expected}' not found.` };
    if (found.schedule?.scheduleInterval !== 'DAILY') {
      return {
        pass: false,
        detail: `Report '${expected}' is not on a DAILY schedule.`,
      };
    }
    const recipients = found.notificationPolicy?.recipients ?? [];
    if (recipients.length === 0) {
      return {
        pass: false,
        detail: `Report '${expected}' has no recipient — add an email recipient.`,
      };
    }
    if (expectedEmail && !recipients.some((r) => r.emailAddress === expectedEmail)) {
      return {
        pass: false,
        detail: `Report '${expected}' recipient does not match '${expectedEmail}'.`,
      };
    }
    const hasVmWidget = (found.sections ?? []).some((s) =>
      (s.rows ?? []).some((row) =>
        (row.widgets ?? []).some(
          (w) => (w.widgetInfo?.entityType ?? '').toUpperCase() === 'VM',
        ),
      ),
    );
    if (!hasVmWidget) {
      return {
        pass: false,
        detail: `Report '${expected}' template has no VM-list widget — add the "List of VMs" widget.`,
      };
    }
    if (found.extId) {
      ctx.cache.set({ kind: 'report', logicalName: expected, uuid: found.extId });
    }
    return {
      pass: true,
      detail: `Report '${expected}' scheduled DAILY → ${recipients[0]!.emailAddress} with VM-list widget.`,
    };
  } catch (err) {
    return { pass: false, detail: `Report query failed: ${nutanixErrorDetail(err)}` };
  }
}

/**
 * Stage 28 `expand-cluster` (CheckNewNode). Stage prose asks the player to
 * simulate expansion and type the new node's serial number via
 * `<input var='NodeSerial'/>`. The submitted value must match a node
 * currently DISCOVERABLE (rackmounted, not yet part of the cluster) — i.e.
 * a real expand candidate. Old implementation matched against
 * `/rackable-units` (chassis inventory including active nodes), which let
 * the running node's serial pass — wrong. Aligned with the legacy Python
 * `dev` branch (`ntnx-escape-game/functions.py:getNewNodeSerial`, commit
 * e37ef0d) via `discoverableNodeSerials()` helper.
 */
async function CheckNewNode(ctx: CheckContext): Promise<CheckResult> {
  const serial = ctx.vars.get('NodeSerial');
  if (typeof serial !== 'string' || serial.trim().length === 0) {
    return {
      pass: false,
      detail: 'No node serial captured.',
      retryFromVariable: 'NodeSerial',
    };
  }
  if (!/^[A-Za-z0-9-]{3,}$/.test(serial.trim())) {
    return {
      pass: false,
      detail: `Serial '${serial}' doesn't look like a node serial.`,
      retryFromVariable: 'NodeSerial',
    };
  }
  // Always query live — discoverable set can change between server boot and
  // now (operator just freed a node, etc.). The boot-time cache is a hint
  // for the auto-fill prompt only, not the source of truth for the check.
  try {
    const discoverable = await discoverableNodeSerials(ctx.nutanix, ctx.logger);
    if (discoverable.length === 0) {
      return {
        pass: false,
        detail:
          `No discoverable nodes returned by the cluster — there is nothing ` +
          `to expand with. Free a node first (stage 28 simulates adding a ` +
          `previously-removed node back in).`,
        retryFromVariable: 'NodeSerial',
      };
    }
    const submitted = serial.trim();
    if (!discoverable.includes(submitted)) {
      return {
        pass: false,
        detail: `Serial '${submitted}' is not currently discoverable on the cluster (saw: ${discoverable.join(', ')}).`,
        retryFromVariable: 'NodeSerial',
      };
    }
    return { pass: true, detail: `Discoverable node '${submitted}' confirmed.` };
  } catch (err) {
    return { pass: false, detail: `Discover-unconfigured-nodes query failed: ${nutanixErrorDetail(err)}` };
  }
}

/**
 * Stage 29 `lcm-check-updates`. Player types the number of available
 * updates they saw in the LCM inventory via `<input var='NumberUpdates'/>`.
 * No API — we only verify the captured value parses as a non-negative int.
 */
async function CheckUpdates(ctx: CheckContext): Promise<CheckResult> {
  const raw = ctx.vars.get('NumberUpdates');
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return {
      pass: false,
      detail: 'No update count captured.',
      retryFromVariable: 'NumberUpdates',
    };
  }
  const submitted = typeof raw === 'number' ? raw : Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(submitted) || submitted < 0) {
    return {
      pass: false,
      detail: `Update count '${raw}' is not a non-negative integer.`,
      retryFromVariable: 'NumberUpdates',
    };
  }
  // Mock mode: skip the live LCM lookup. The fixture entity count is an
  // arbitrary seed value that doesn't match anything the player has on
  // screen, so cross-checking it just blocks manual play. Auto-fill still
  // returns the fixture count for auto-play; manual entry of any
  // non-negative integer passes here.
  if (ctx.nutanix.mode === 'mock') {
    return {
      pass: true,
      detail: `${submitted} update(s) recorded (mock mode, format-only validation).`,
    };
  }
  // Always query live — operators want this stage to validate against the
  // current LCM inventory (new updates may have landed since boot). Count
  // matches the "Prism Element Clusters" LCM tab, grouped by component.
  //
  // The catch (issue #60): while an inventory runs, LCM wipes its update list
  // and rebuilds it, so for ~3.5 minutes the live count is noise (0, then a
  // ramp past the true value) — and the player's LCM *page* shows that same
  // noise. Anyone can start one from that page, on a cluster everyone shares.
  // So we judge against `lastSettled`, the count read while LCM was last quiet:
  // an inventory re-derives the same list, it doesn't change what's available.
  try {
    const reading = await readLcmUpdates(ctx.nutanix, ctx.logger);
    if (reading === null) {
      // LCM endpoint not reachable on this PC — fall back to format-only
      // validation so the stage doesn't block when LCM isn't reachable.
      return {
        pass: true,
        detail: `${submitted} update(s) recorded (LCM endpoint unreachable, format-only validation).`,
      };
    }
    // What counts as right, in order: the operator's /admin value if they set
    // one (they looked at the LCM page — that beats anything we compute, and
    // it's the escape hatch for the day our count stops matching the screen),
    // then the live count, then the last settled one while an inventory runs.
    const cfg = ctx.clusterConfig;
    const operatorSet =
      cfg?.lcmAvailableUpdatesSource === 'admin' ? cfg.lcmAvailableUpdates : undefined;
    const lastSettled = cfg?.lcmAvailableUpdates;
    const expected = operatorSet ?? (reading.settled ? reading.count : lastSettled);
    if (expected === submitted) {
      return {
        pass: true,
        detail:
          operatorSet !== undefined
            ? `${submitted} update(s) — matches the operator-set count.`
            : reading.settled
              ? `${submitted} update(s) — matches LCM inventory.`
              : `${submitted} update(s) — matches the last settled LCM inventory (one is running now).`,
      };
    }
    // Any other number, while the list is (or just was) being rebuilt, is
    // unjudgeable: the page they counted from was showing LCM's own noise, and
    // that noise moves every few seconds, so we can't even tell a stale read
    // from a wrong answer. Re-prompt and score NOTHING — no free pass either,
    // they still have to come back with the right number once it settles.
    if (!reading.settled || justFinishedInventory(reading.lastInventoryAt)) {
      return {
        pass: false,
        neutral: true,
        detail: `Inventory ${reading.settled ? 'just finished' : 'in flight'} (live=${reading.count}, last settled=${lastSettled ?? 'none'}), player typed ${submitted} — not judged.`,
        hint: reading.settled
          ? localizedHint(ctx, {
              en: 'An LCM inventory just finished, so the list you counted was still being rebuilt. Refresh the LCM page and count again.',
              fr: "Un inventaire LCM vient de se terminer : la liste que tu as comptée était encore en cours de reconstruction. Rafraîchis la page LCM et recompte.",
              de: 'Eine LCM-Inventur ist gerade fertig geworden: Die Liste, die du gezählt hast, wurde noch neu aufgebaut. Aktualisiere die LCM-Seite und zähle erneut.',
            })
          : localizedHint(ctx, {
              en: 'An LCM inventory is running: the update list on screen is still being rebuilt. Wait for it to finish, refresh the page, and count again.',
              fr: "Un inventaire LCM est en cours : la liste des mises à jour à l'écran est encore en cours de reconstruction. Attends la fin, rafraîchis la page et recompte.",
              de: 'Eine LCM-Inventur läuft: Die Update-Liste auf dem Bildschirm wird noch neu aufgebaut. Warte, bis sie fertig ist, aktualisiere die Seite und zähle erneut.',
            }),
        retryFromVariable: 'NumberUpdates',
      };
    }
    return {
      pass: false,
      detail:
        operatorSet !== undefined
          ? `Operator-set count is ${expected}, you typed ${submitted}.`
          : `LCM reports ${expected} updates, you typed ${submitted}.`,
      retryFromVariable: 'NumberUpdates',
    };
  } catch (err) {
    return { pass: false, detail: `LCM query failed: ${nutanixErrorDetail(err)}` };
  }
}


/**
 * Stage 31 `capacity-runway` (CheckRunway). Player reads the runway
 * dashboard on a different cluster and types the number of days remaining
 * via `<input var='Runway'/>`. Pure input validation — we don't cross-check
 * against the cluster since the stage prose explicitly hands the player
 * into a secondary PC the check function has no connection to.
 */
async function CheckRunway(ctx: CheckContext): Promise<CheckResult> {
  const raw = ctx.vars.get('Runway');
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return {
      pass: false,
      detail: 'No runway value captured.',
      retryFromVariable: 'Runway',
    };
  }
  const submitted =
    typeof raw === 'number' ? raw : Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(submitted) || submitted < 0) {
    return {
      pass: false,
      detail: `Runway '${raw}' is not a positive number of days.`,
      retryFromVariable: 'Runway',
    };
  }
  // Mock mode: skip the OldPC raw fetch (it bypasses the mock-adapter and
  // hits a real secondary cluster, breaking offline play). Format-only
  // validation; auto-fill returns a canned 120 for auto-play, manual
  // typing accepts any non-negative integer.
  if (ctx.nutanix.mode === 'mock') {
    return {
      pass: true,
      detail: `${submitted} days recorded (mock mode, format-only validation).`,
    };
  }
  // Original `CheckRunway` queries a SECOND cluster (`OldPC`) via the v3
  // groups endpoint with a `capacity.runway` group_member_attribute. Stage
  // 31 prose explicitly hands the player to the secondary cluster's
  // capacity dashboard. If the runtime hasn't been wired with `OldPC` /
  // `OldPCUsername` / `OldPCPassword` (no secondary cluster available
  // for this event), fall back to format-only validation — the player's
  // typed value is the only signal we have.
  const oldPc = ctx.vars.get('OldPC');
  const oldUser = ctx.vars.get('OldPCUsername');
  const oldPass = ctx.vars.get('OldPCPassword');
  if (
    typeof oldPc !== 'string' ||
    typeof oldUser !== 'string' ||
    typeof oldPass !== 'string' ||
    !oldPc ||
    !oldUser ||
    !oldPass
  ) {
    return {
      pass: true,
      detail: `${submitted} days recorded (no secondary cluster wired, format-only validation).`,
    };
  }
  try {
    // OldPC env may be just a host/IP (`10.55.82.39`) — add scheme + PC
    // port. Or it may already be a full URL (`https://…:9440`) from a
    // hand-rolled deployment — strip trailing `/`. Detect by leading scheme.
    const stripped = oldPc.replace(/\/+$/, '');
    const base = /^https?:\/\//.test(stripped) ? stripped : `https://${stripped}:9440`;
    const url = `${base}/api/nutanix/v3/groups`;
    const auth = `Basic ${btoa(`${oldUser}:${oldPass}`)}`;
    const now = Date.now();
    const body = {
      entity_type: 'cluster',
      group_member_attributes: [{ attribute: 'capacity.runway' }],
      query_name: 'prism:RunwayInfoQueryModel',
      interval_start_ms: now - 3 * 86400 * 1000,
      interval_end_ms: now,
      downsampling_interval: 86400,
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tls: { rejectUnauthorized: false } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    if (!res.ok) {
      return {
        pass: true,
        detail: `${submitted} days recorded (secondary cluster ${oldPc} returned ${res.status}, format-only validation).`,
      };
    }
    const data = (await res.json()) as {
      group_results?: Array<{
        entity_results?: Array<{
          data?: Array<{ name?: string; values?: Array<{ values?: unknown[] }> }>;
        }>;
      }>;
    };
    const entry = data.group_results?.[0]?.entity_results?.[0]?.data?.find(
      (d) => d.name === 'capacity.runway',
    );
    const actual = entry?.values?.[0]?.values?.[0];
    const actualNum =
      typeof actual === 'number' ? actual : Number.parseInt(String(actual ?? ''), 10);
    if (!Number.isFinite(actualNum)) {
      return {
        pass: true,
        detail: `${submitted} days recorded (secondary cluster runway unparseable, format-only validation).`,
      };
    }
    if (actualNum !== submitted) {
      return {
        pass: false,
        detail: `Cluster runway is ${actualNum} days, you typed ${submitted}.`,
        retryFromVariable: 'Runway',
      };
    }
    return { pass: true, detail: `${submitted} days — matches secondary cluster capacity.` };
  } catch (err) {
    return {
      pass: true,
      detail: `${submitted} days recorded (runway query failed: ${nutanixErrorDetail(err)}, format-only validation).`,
    };
  }
}

/**
 * Stage 33 `create-ncm-playbook`. Verifies `{Trigram}-playbook` exists in
 * NCM X-Play with at least one action (the stage asks for an email-on-VM-
 * power-cycle rule). X-Play playbooks live on v3 as `action_rules` with a
 * POST /list shape — `rule_type: "XPLAY"` distinguishes them from older
 * alert-action rules. `entities[].status.resources.{action_list, is_enabled,
 * name}` is where the real fields sit.
 */
async function CheckPlaybook(ctx: CheckContext): Promise<CheckResult> {
  const trigram = getTrigram(ctx);
  const expected = `${trigram}-playbook`;
  try {
    const playbooks = await listAllV3<{
      metadata?: { uuid?: string };
      status?: {
        name?: string;
        resources?: {
          name?: string;
          is_enabled?: boolean;
          rule_type?: string;
          trigger_list?: Array<{
            input_parameter_values?: { type?: string };
          }>;
          action_list?: Array<{
            action_type_reference?: { name?: string };
          }>;
        };
      };
    }>(ctx, '/api/nutanix/v3/action_rules/list');
    const found = playbooks.find(
      (p) => p.status?.name === expected || p.status?.resources?.name === expected,
    );
    if (!found) return { pass: false, detail: `Playbook '${expected}' not found.` };
    const r = found.status?.resources ?? {};
    // Original Python `CheckPlaybook` (r0w/ntnx-escape-game) requires:
    //   - exactly 1 trigger of type `VmPowerCycleAudit`
    //   - exactly 1 action of type `email_action`
    //   - `is_enabled: true`
    // Stage 33 prose says "email-on-VM-power-cycle rule" so the player
    // sets these explicitly — strict validation.
    const triggers = r.trigger_list ?? [];
    if (triggers.length !== 1) {
      return {
        pass: false,
        detail: `Playbook '${expected}' must have exactly 1 trigger (saw ${triggers.length}).`,
      };
    }
    const triggerType = triggers[0]?.input_parameter_values?.type;
    if (triggerType !== 'VmPowerCycleAudit') {
      return {
        pass: false,
        detail: `Playbook '${expected}' trigger type is '${triggerType ?? '?'}' (expected VmPowerCycleAudit).`,
      };
    }
    const actions = r.action_list ?? [];
    if (actions.length !== 1) {
      return {
        pass: false,
        detail: `Playbook '${expected}' must have exactly 1 action (saw ${actions.length}).`,
      };
    }
    const actionName = actions[0]?.action_type_reference?.name;
    if (actionName !== 'email_action') {
      return {
        pass: false,
        detail: `Playbook '${expected}' action is '${actionName ?? '?'}' (expected email_action).`,
      };
    }
    if (!r.is_enabled) {
      return { pass: false, detail: `Playbook '${expected}' is disabled — enable it.` };
    }
    if (found.metadata?.uuid) {
      ctx.cache.set({ kind: 'playbook', logicalName: expected, uuid: found.metadata.uuid });
    }
    return {
      pass: true,
      detail: `Playbook '${expected}' enabled with VmPowerCycleAudit→email_action.`,
    };
  } catch (err) {
    return { pass: false, detail: `Playbook query failed: ${nutanixErrorDetail(err)}` };
  }
}

// ─── Self-Service / Calm ─────────────────────────────────────────────────

/**
 * Stage 35 `clone-app-blueprint` (CheckCloneApp). Verifies the player
 * launched the `CloneProd` blueprint as an application named `{Trigram}-app`.
 * Self-Service / Calm apps live on v3 (`POST /api/nutanix/v3/apps/list`) —
 * v4 hasn't absorbed them. `status.resources.app_blueprint_reference.name`
 * carries the source blueprint.
 */
async function CheckCloneApp(ctx: CheckContext): Promise<CheckResult> {
  const trigram = getTrigram(ctx);
  const expectedApp = `${trigram}-app`;
  const expectedVpc = `${trigram}-vpc`;
  try {
    // App existence (v3 — no v4 SDK for Calm apps)
    const apps = await listAllV3<{
      metadata?: { uuid?: string; name?: string };
      status?: {
        name?: string;
        state?: string;
        resources?: { app_blueprint_reference?: { name?: string } };
      };
    }>(ctx, '/api/nutanix/v3/apps/list');
    const foundApp = apps.find(
      (a) => a.status?.name === expectedApp || a.metadata?.name === expectedApp,
    );
    if (!foundApp) return { pass: false, detail: `Application '${expectedApp}' not found.` };
    const bpName = foundApp.status?.resources?.app_blueprint_reference?.name;
    if (bpName && bpName !== 'CloneProd') {
      return {
        pass: false,
        detail: `Application '${expectedApp}' not launched from CloneProd (saw '${bpName}').`,
      };
    }
    if (foundApp.metadata?.uuid) {
      ctx.cache.set({ kind: 'calmApp', logicalName: expectedApp, uuid: foundApp.metadata.uuid });
    }
    // The original Python CheckCloneApp also asserts the player created the
    // VPC `{Trigram}-vpc` as a runtime input to the blueprint launch. v4
    // networking exposes VPCs at `/api/networking/v4.0/config/vpcs`.
    const vpcs = await listAll<{ extId?: string; name?: string }>(
      ctx,
      '/api/networking/v4.0/config/vpcs',
    );
    const foundVpc = vpcs.find((v) => v.name === expectedVpc);
    if (!foundVpc) {
      return {
        pass: false,
        detail: `VPC '${expectedVpc}' not found — the blueprint launch should have created it via the vpcName runtime input.`,
      };
    }
    return {
      pass: true,
      detail: `Application '${expectedApp}' launched from CloneProd; VPC '${expectedVpc}' present.`,
      captured: foundVpc.extId ? { VpcUUID: foundVpc.extId } : undefined,
    };
  } catch (err) {
    return { pass: false, detail: `App/VPC query failed: ${nutanixErrorDetail(err)}` };
  }
}

/**
 * Stage 36 `schedule-day2-action` (CheckSchedDay2). Verifies `{Trigram}-sched`
 * exists as a scheduler policy in Self-Service, targeting the player's app.
 * Scheduler policies live on v3 with `cron_expression` or a frequency field
 * in `status.resources`.
 */
async function CheckSchedDay2(ctx: CheckContext): Promise<CheckResult> {
  const trigram = getTrigram(ctx);
  const expected = `${trigram}-sched`;
  try {
    // The schedule must target the player's app — no app, no pass.
    const appUuid = await lookupAppUuid(ctx, `${trigram}-app`);
    if (!appUuid) {
      return { pass: false, detail: `Application '${trigram}-app' not found.` };
    }
    // Calm app-scheduler entities live on `/api/nutanix/v3/jobs/list` —
    // the GUI calls them "Self-Service > Policies" but they're modeled as
    // jobs in the v3 API. Original Python `CheckSchedDay2` looks for
    // `entities[?(metadata.name=='{trigram}-sched')].resources` and
    // verifies `executable.entity.uuid` targets the player's app.
    //
    // Note: v3 jobs list returns `entities[].resources` at top level (NOT
    // nested under `status.resources` like apps/blueprints). Different
    // shape per resource type — confirmed against live PC.
    const jobs = await ctx.nutanix.rest.request<{
      entities?: Array<{
        metadata?: { uuid?: string; name?: string };
        resources?: {
          name?: string;
          executable?: { entity?: { uuid?: string } };
        };
      }>;
    }>('POST', '/api/nutanix/v3/jobs/list', { kind: 'job', length: 100 });
    const found = (jobs.entities ?? []).find(
      (j) => j.metadata?.name === expected || j.resources?.name === expected,
    );
    if (!found) return { pass: false, detail: `Scheduled policy '${expected}' not found.` };
    const target = found.resources?.executable?.entity?.uuid;
    if (target !== appUuid) {
      return {
        pass: false,
        detail: `Schedule '${expected}' targets '${target ?? '?'}' (expected app UUID '${appUuid}').`,
      };
    }
    return { pass: true, detail: `Schedule '${expected}' targets the player's app.` };
  } catch (err) {
    return { pass: false, detail: `Scheduler query failed: ${nutanixErrorDetail(err)}` };
  }
}

/**
 * Stage 37 `modify-blueprint` (CheckUpdateBP). Verifies the blueprint
 * `bp-blankvm-prd{Vlanid}` now carries a task named `foo` inside the
 * `Create` action of its `NewVM` service. Blueprints live on v3 — list is
 * shallow (no services), but the GET-by-uuid returns the full spec with
 * `spec.resources.app_profile_list[].deployment_create_list[].substrate_
 * local_reference` and action trees. We take the shallow list, resolve the
 * name, then GET the spec to traverse services→actions→tasks.
 */
async function CheckUpdateBP(ctx: CheckContext): Promise<CheckResult> {
  const vlan = ctx.vars.get('Vlanid');
  const vlanStr = vlan === undefined || vlan === null ? '' : String(vlan);
  const expected = `bp-blankvm-prd${vlanStr}`;
  try {
    const bps = await listAllV3<{
      metadata?: { uuid?: string; name?: string };
      status?: { name?: string };
    }>(ctx, '/api/nutanix/v3/blueprints/list');
    const found = bps.find(
      (b) => b.status?.name === expected || b.metadata?.name === expected,
    );
    if (!found?.metadata?.uuid) {
      return { pass: false, detail: `Blueprint '${expected}' not found.` };
    }
    // GET-by-uuid returns the full blueprint with services/actions/tasks.
    // The Calm SDK exposes the action under its INTERNAL name `action_create`
    // (the GUI label is "Create" but the spec key is `action_create`) —
    // confirmed against the original Python CheckUpdateBP in r0w/ntnx-escape-game.
    const spec = await ctx.nutanix.rest.request<{
      status?: {
        resources?: {
          service_definition_list?: Array<{
            name?: string;
            action_list?: Array<{
              name?: string;
              runbook?: {
                task_definition_list?: Array<{ name?: string }>;
              };
            }>;
          }>;
        };
      };
    }>('GET', `/api/nutanix/v3/blueprints/${found.metadata.uuid}`);
    const services = spec?.status?.resources?.service_definition_list ?? [];
    const newVm = services.find((s) => s.name === 'NewVM');
    if (!newVm) return { pass: false, detail: `Service 'NewVM' missing from '${expected}'.` };
    const createAction = (newVm.action_list ?? []).find((a) => a.name === 'action_create');
    if (!createAction) return { pass: false, detail: `Action 'action_create' missing on NewVM.` };
    const tasks = createAction.runbook?.task_definition_list ?? [];
    const hasFoo = tasks.some((t) => t.name === 'foo');
    if (!hasFoo) {
      return {
        pass: false,
        detail: `Task 'foo' missing from Create action — add it after 'Add DNS Entry'.`,
      };
    }
    return { pass: true, detail: `Blueprint '${expected}' has the 'foo' backdoor task.` };
  } catch (err) {
    return { pass: false, detail: `Blueprint query failed: ${nutanixErrorDetail(err)}` };
  }
}

/**
 * Stage 2 `recovery-gate`. The legacy Python engine used this as a boot
 * gate: re-validate the session's position in case of a restart. Our new
 * engine stores progress in the `sessions` table with `current_stage` and
 * re-renders the awaiting stage on reconnect, so recovery is implicit. The
 * check stays as a no-op pass for scenario compatibility; removing the
 * stage is a Phase 11 or 12 candidate.
 */
async function NeedRecovery(ctx: CheckContext): Promise<CheckResult> {
  ctx.logger.info('recovery gate passthrough (state restore handled by session table)');
  return { pass: true, detail: 'Ready.' };
}

export const checks = {
  // IAM
  CheckTrigram,
  CheckUser,
  CheckAuthPolicy,

  // Projects & networking
  CheckProject,
  CheckNetwork,

  // VM lifecycle
  CheckImage,
  CheckVM,
  CheckLiveMigration,
  CheckRestoreVM,

  // Categories
  CheckCat,
  CheckCatVM,

  // Storage + security + protection + approval policies
  CheckStoragePolicy,
  CheckSecurityPolicy,
  CheckSecurityPolicy2,
  CheckProtectionPolicy,
  CheckApprovalPolicy,

  // Reports, NCM playbook, capacity + updates
  CheckReport,
  CheckNewNode,
  CheckUpdates,
  CheckRunway,
  CheckPlaybook,

  // Self-Service / Calm
  CheckCloneApp,
  CheckSchedDay2,
  CheckUpdateBP,
  NeedRecovery,
};
