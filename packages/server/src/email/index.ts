// Participant emails, sent by the operator from /admin (issue #30).
// Templates ship inside the bundle via Bun text imports — no runtime file
// reads, so the minified Docker build needs no extra COPY. bun-types
// declares *.html as HTMLBundle, but `with { type: "text" }` makes the
// runtime (and bundler) hand us the raw string — hence the casts.
import invitationEnRaw from './templates/invitation.en.html' with { type: 'text' };
import invitationFrRaw from './templates/invitation.fr.html' with { type: 'text' };
import invitationVdiEnRaw from './templates/invitation-vdi.en.html' with { type: 'text' };
import invitationVdiFrRaw from './templates/invitation-vdi.fr.html' with { type: 'text' };
import invitationVpnEnRaw from './templates/invitation-vpn.en.html' with { type: 'text' };
import invitationVpnFrRaw from './templates/invitation-vpn.fr.html' with { type: 'text' };
import summaryEnRaw from './templates/summary.en.html' with { type: 'text' };
import summaryFrRaw from './templates/summary.fr.html' with { type: 'text' };

const invitationEn = invitationEnRaw as unknown as string;
const invitationFr = invitationFrRaw as unknown as string;
const invitationVdiEn = invitationVdiEnRaw as unknown as string;
const invitationVdiFr = invitationVdiFrRaw as unknown as string;
const invitationVpnEn = invitationVpnEnRaw as unknown as string;
const invitationVpnFr = invitationVpnFrRaw as unknown as string;
const summaryEn = summaryEnRaw as unknown as string;
const summaryFr = summaryFrRaw as unknown as string;

export interface EmailTemplate {
  id: 'invitation' | 'invitation-vdi' | 'invitation-vpn' | 'summary';
  locale: 'en' | 'fr';
  /** Default subject line — editable in the composer before sending. */
  subject: string;
  html: string;
  /**
   * `{VAR}` placeholders the operator fills in from the composer, with
   * their default values ('' = must be provided). `{ID}` is not listed:
   * the server substitutes it per recipient (1-based position in the
   * recipient list, zero-padded) at send time.
   */
  variables: Record<string, string>;
}

const LEGACY_SURVEY_URL = 'https://forms.cloud.microsoft/r/UFWgLW352a?origin=lprLink';

export const EMAIL_TEMPLATES: EmailTemplate[] = [
  {
    id: 'invitation',
    locale: 'en',
    subject: 'Nutanix Cloud Operations Command Center - Mission Briefing',
    html: invitationEn,
    variables: { GAME_URL: '' },
  },
  {
    id: 'invitation',
    locale: 'fr',
    subject: 'Nutanix Cloud Operations Command Center - Briefing de Mission',
    html: invitationFr,
    variables: { GAME_URL: '' },
  },
  // Legacy access variants, ported from the escape game: the event hands
  // out per-seat VDI accounts ({CLUSTER}-User{ID} on a Parallels jump
  // host) or a VPN profile, and the game URL is reached from inside.
  {
    id: 'invitation-vdi',
    locale: 'en',
    subject: 'Nutanix Cloud Operations Command Center - Mission Briefing',
    html: invitationVdiEn,
    variables: { GAME_URL: '', PARALLEL_URL: '', CLUSTER: '', PASSWORD: '' },
  },
  {
    id: 'invitation-vdi',
    locale: 'fr',
    subject: 'Nutanix Cloud Operations Command Center - Briefing de Mission',
    html: invitationVdiFr,
    variables: { GAME_URL: '', PARALLEL_URL: '', CLUSTER: '', PASSWORD: '' },
  },
  {
    id: 'invitation-vpn',
    locale: 'en',
    subject: 'Nutanix Cloud Operations Command Center - Mission Briefing',
    html: invitationVpnEn,
    variables: { GAME_URL: '' },
  },
  {
    id: 'invitation-vpn',
    locale: 'fr',
    subject: 'Nutanix Cloud Operations Command Center - Briefing de Mission',
    html: invitationVpnFr,
    variables: { GAME_URL: '' },
  },
  {
    id: 'summary',
    locale: 'en',
    subject: 'Nutanix Cloud Operations Command Center - Lab Summary',
    html: summaryEn,
    variables: { SURVEY_URL: LEGACY_SURVEY_URL },
  },
  {
    id: 'summary',
    locale: 'fr',
    subject: 'Nutanix Cloud Operations Command Center - Résumé du Lab',
    html: summaryFr,
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
