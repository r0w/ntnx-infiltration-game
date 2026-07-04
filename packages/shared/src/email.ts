// Shared between the /admin Emails composer (preview) and the server's
// send loop, so what the operator previews is provably what recipients get.

/** Loose-but-symmetric email shape check used by both UI gating and routes. */
export const EMAIL_RE = /^\S+@\S+\.\S+$/;

/**
 * Replace `{KEY}` tokens with the operator-filled values. Empty values
 * leave the token visible on purpose (the UI warns about them).
 */
export function substituteVars(text: string, vars: Record<string, string>): string {
  let out = text;
  for (const [k, v] of Object.entries(vars)) {
    if (v.trim()) out = out.split(`{${k}}`).join(v.trim());
  }
  return out;
}

/** Per-recipient `{ID}` = the roster seat, zero-padded ("01"). */
export function substituteSeat(text: string, seat: number): string {
  return text.split('{ID}').join(String(seat).padStart(2, '0'));
}
