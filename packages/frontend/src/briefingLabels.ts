const LABELS: Record<string, { tank: string; instructor: string; title: string }> = {
  en: { tank: 'Call Tank', instructor: 'Call the instructor', title: 'Review the access details already shared for your mission' },
  fr: { tank: 'Rappeler Tank', instructor: 'Rappeler l’instructeur', title: 'Revoir les accès déjà transmis pour votre mission' },
  de: { tank: 'Tank rufen', instructor: 'Kursleitung rufen', title: 'Die bereits erhaltenen Zugangsdaten für die Mission erneut anzeigen' },
  es: { tank: 'Llamar a Tank', instructor: 'Llamar al instructor', title: 'Consultar los datos de acceso ya recibidos para la misión' },
  it: { tank: 'Chiama Tank', instructor: 'Chiama l’istruttore', title: 'Rivedi i dati di accesso già ricevuti per la missione' },
};

export function briefingLabels(locale: string, nkp: boolean) {
  const labels = LABELS[locale] ?? LABELS.en!;
  return { button: nkp ? labels.instructor : labels.tank, title: labels.title };
}
