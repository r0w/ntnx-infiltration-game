// Participant emails, sent by the operator from /admin (issue #30).
// Templates ship inside the bundle via Bun text imports — no runtime file
// reads, so the minified Docker build needs no extra COPY. bun-types
// declares *.html as HTMLBundle, but `with { type: "text" }` makes the
// runtime (and bundler) hand us the raw string — hence the casts.
import invitationVdiEnRaw from './templates/invitation-vdi.en.html' with { type: 'text' };
import invitationVdiFrRaw from './templates/invitation-vdi.fr.html' with { type: 'text' };
import invitationVdiDeRaw from './templates/invitation-vdi.de.html' with { type: 'text' };
import summaryEnRaw from './templates/summary.en.html' with { type: 'text' };
import summaryFrRaw from './templates/summary.fr.html' with { type: 'text' };
import summaryDeRaw from './templates/summary.de.html' with { type: 'text' };

const invitationVdiEn = invitationVdiEnRaw as unknown as string;
const invitationVdiFr = invitationVdiFrRaw as unknown as string;
const invitationVdiDe = invitationVdiDeRaw as unknown as string;
const summaryEn = summaryEnRaw as unknown as string;
const summaryFr = summaryFrRaw as unknown as string;
const summaryDe = summaryDeRaw as unknown as string;

export interface EmailTemplate {
  id: 'invitation-vdi' | 'summary';
  locale: 'en' | 'fr' | 'de';
  /** Default subject line — editable in the composer before sending. */
  subject: string;
  html: string;
  /**
   * `{VAR}` placeholders the operator fills in from the composer, with
   * their default values ('' = must be provided). `{ID}` is not listed:
   * the server substitutes it per recipient (the roster seat number,
   * zero-padded) at send time.
   */
  variables: Record<string, string>;
}

const LEGACY_SURVEY_URL = 'https://forms.cloud.microsoft/r/UFWgLW352a?origin=lprLink';

// Default Parallels RAS jump host for HPoC events. Base64ed only to keep
// the internal URL out of plain-text search on this public repo — the
// operator sees (and can replace) the decoded value in the composer.
const DEFAULT_PARALLEL_URL = Buffer.from(
  'aHR0cHM6Ly9kbTMtcmFzLmhwb2MubnV0YW5peC5jb20v',
  'base64',
).toString();

const INVITATION_VARS = {
  GAME_URL: '',
  PARALLEL_URL: DEFAULT_PARALLEL_URL,
  CLUSTER: '',
  PASSWORD: '',
};

export const EMAIL_TEMPLATES: EmailTemplate[] = [
  {
    id: 'invitation-vdi',
    locale: 'en',
    subject: '[CLASSIFIED] Operation Infiltration: Mission Briefing',
    html: invitationVdiEn,
    variables: { ...INVITATION_VARS },
  },
  {
    id: 'invitation-vdi',
    locale: 'fr',
    subject: '[CONFIDENTIEL] Opération Infiltration : Briefing de Mission',
    html: invitationVdiFr,
    variables: { ...INVITATION_VARS },
  },
  {
    id: 'invitation-vdi',
    locale: 'de',
    subject: '[STRENG GEHEIM] Operation Infiltration: Missionsbriefing',
    html: invitationVdiDe,
    variables: { ...INVITATION_VARS },
  },
  {
    id: 'summary',
    locale: 'en',
    subject: '[DEBRIEF] Operation Infiltration: Mission Accomplished',
    html: summaryEn,
    variables: { SURVEY_URL: LEGACY_SURVEY_URL },
  },
  {
    id: 'summary',
    locale: 'fr',
    subject: '[DEBRIEF] Opération Infiltration : Mission Accomplie',
    html: summaryFr,
    variables: { SURVEY_URL: LEGACY_SURVEY_URL },
  },
  {
    id: 'summary',
    locale: 'de',
    subject: '[DEBRIEF] Operation Infiltration: Mission erfüllt',
    html: summaryDe,
    variables: { SURVEY_URL: LEGACY_SURVEY_URL },
  },
];


export interface MailtrapSendArgs {
  token: string;
  fromEmail: string;
  fromName: string;
  to: string;
  subject: string;
  html: string;
  timeoutMs?: number;
}

export interface MailtrapSendResult {
  ok: boolean;
  error?: string;
}

/**
 * One recipient per call — the Mailtrap `to` array would leak the full
 * recipient list into everyone's headers, and per-recipient calls give
 * per-recipient verdicts for the /admin results table.
 */
export async function sendMailtrapEmail(args: MailtrapSendArgs): Promise<MailtrapSendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 15000);
  try {
    const res = await fetch('https://send.api.mailtrap.io/api/send', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Api-Token': args.token,
      },
      body: JSON.stringify({
        to: [{ email: args.to }],
        from: { email: args.fromEmail, ...(args.fromName ? { name: args.fromName } : {}) },
        subject: args.subject,
        html: args.html,
      }),
    });
    if (res.ok) return { ok: true };
    // Mailtrap error bodies: { errors: [...] } or { success: false, errors: [...] }
    let detail = '';
    try {
      const body = (await res.json()) as { errors?: unknown };
      if (Array.isArray(body.errors)) detail = body.errors.map(String).join('; ');
    } catch {
      /* non-JSON body — status line is enough */
    }
    return { ok: false, error: `HTTP ${res.status}${detail ? `: ${detail}` : ''}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: controller.signal.aborted ? 'timeout' : msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verified sending domains of the Mailtrap account owning the token —
 * lets /admin suggest a from address instead of the operator guessing
 * which domain their account can send from.
 */
export async function listMailtrapDomains(
  token: string,
  timeoutMs = 10000,
): Promise<{
  domains: Array<{ domain: string; verified: boolean }>;
  /** True when Mailtrap explicitly rejected the token (401/403) — as
   *  opposed to a transient network/API failure (`error` only). */
  unauthorized?: boolean;
  error?: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { Accept: 'application/json', 'Api-Token': token };
  try {
    const accRes = await fetch('https://mailtrap.io/api/accounts', {
      headers,
      signal: controller.signal,
    });
    if (accRes.status === 401 || accRes.status === 403) {
      return { domains: [], unauthorized: true, error: `token rejected (HTTP ${accRes.status})` };
    }
    if (!accRes.ok) return { domains: [], error: `accounts: HTTP ${accRes.status}` };
    const accounts = (await accRes.json()) as Array<{ id: number }>;
    if (!Array.isArray(accounts)) {
      return { domains: [], error: 'accounts: unexpected response shape' };
    }
    // Accounts are independent — fetch in parallel so the shared timeout
    // bounds the slowest lookup, not the sum.
    const perAccount = await Promise.all(
      accounts.map(async (acc) => {
        const dRes = await fetch(`https://mailtrap.io/api/accounts/${acc.id}/sending_domains`, {
          headers,
          signal: controller.signal,
        });
        if (!dRes.ok) return [];
        const body = (await dRes.json()) as {
          data?: Array<{
            domain_name: string;
            demo?: boolean;
            dns_records?: Array<{ status: string }>;
          }>;
        } | null;
        return (body?.data ?? [])
          // demomailtrap.co & co: Mailtrap's sandbox domains only deliver
          // to the account owner — useless for real participant sends.
          .filter((d) => !d.demo)
          .map((d) => ({
            domain: d.domain_name,
            // A domain with no DNS records at all is not verified — don't
            // let .every() on an empty array vouch for it.
            verified:
              (d.dns_records?.length ?? 0) > 0 &&
              (d.dns_records ?? []).every((r) => r.status === 'pass'),
          }));
      }),
    );
    return { domains: perAccount.flat() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { domains: [], error: controller.signal.aborted ? 'timeout' : msg };
  } finally {
    clearTimeout(timer);
  }
}
