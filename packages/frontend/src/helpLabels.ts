/**
 * UI strings of the step-by-step help (button, confirmation, block chrome).
 * The help *content* is pack data (locale catalogs); these are the few words
 * the client renders around it, so they live here like VERIFYING_LABELS does.
 * Every locale of the game addresses the player formally; keep that register.
 */
export interface HelpLabels {
  /** Button word: rendered as `[? help · +2 min]`. */
  button: string;
  /** Button text once the stage's help was already displayed. */
  review: string;
  /** Header of the framed block. */
  title: string;
  fold: string;
  unfold: string;
  /** Confirmation sentence; `cost` is already formatted, e.g. `+2 min`. */
  confirm: (cost: string) => string;
  yes: string;
  no: string;
  unavailable: string;
  /** Footer of the block, shown only when the stage costs time. */
  charged: (cost: string) => string;
  zoomHint: string;
  close: string;
}

export const HELP_LABELS: Record<string, HelpLabels> = {
  en: {
    button: 'help',
    review: 'review help',
    title: 'Step-by-step help',
    fold: 'collapse',
    unfold: 'expand',
    confirm: (cost) => `Help adds ${cost} to your time. Show it?`,
    yes: 'yes (Enter)',
    no: 'no (Esc)',
    unavailable: 'no help available here',
    charged: (cost) => `${cost} charged once for this stage`,
    zoomHint: 'enlarge',
    close: 'close',
  },
  fr: {
    button: 'aide',
    review: "revoir l'aide",
    title: 'Aide pas-à-pas',
    fold: 'réduire',
    unfold: 'déplier',
    confirm: (cost) => `L'aide ajoute ${cost} à votre temps. L'afficher ?`,
    yes: 'oui (Entrée)',
    no: 'non (Échap)',
    unavailable: "pas d'aide disponible ici",
    charged: (cost) => `${cost} facturées une seule fois pour ce stage`,
    zoomHint: 'agrandir',
    close: 'fermer',
  },
  de: {
    button: 'Hilfe',
    review: 'Hilfe erneut anzeigen',
    title: 'Schritt-für-Schritt-Hilfe',
    fold: 'einklappen',
    unfold: 'ausklappen',
    confirm: (cost) => `Die Hilfe addiert ${cost} zu Ihrer Zeit. Anzeigen?`,
    yes: 'ja (Enter)',
    no: 'nein (Esc)',
    unavailable: 'hier ist keine Hilfe verfügbar',
    charged: (cost) => `${cost} einmalig für diesen Stage berechnet`,
    zoomHint: 'vergrößern',
    close: 'schließen',
  },
  es: {
    button: 'ayuda',
    review: 'ver la ayuda de nuevo',
    title: 'Ayuda paso a paso',
    fold: 'contraer',
    unfold: 'expandir',
    confirm: (cost) => `La ayuda suma ${cost} a su tiempo. ¿Mostrarla?`,
    yes: 'sí (Enter)',
    no: 'no (Esc)',
    unavailable: 'no hay ayuda disponible aquí',
    charged: (cost) => `${cost} cobrados una sola vez en este stage`,
    zoomHint: 'ampliar',
    close: 'cerrar',
  },
  it: {
    button: 'aiuto',
    review: "rivedi l'aiuto",
    title: 'Aiuto passo passo',
    fold: 'comprimi',
    unfold: 'espandi',
    confirm: (cost) => `L'aiuto aggiunge ${cost} al Suo tempo. Mostrarlo?`,
    yes: 'sì (Invio)',
    no: 'no (Esc)',
    unavailable: 'nessun aiuto disponibile qui',
    charged: (cost) => `${cost} addebitati una sola volta per questo stage`,
    zoomHint: 'ingrandisci',
    close: 'chiudi',
  },
};

/** Labels for a locale, falling back to English like the rest of the UI. */
export function helpLabels(locale: string): HelpLabels {
  return HELP_LABELS[locale] ?? HELP_LABELS.en!;
}
