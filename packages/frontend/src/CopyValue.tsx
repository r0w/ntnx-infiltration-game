import { useEffect, useRef, useState, type ReactNode } from 'react';
import { copyText } from './clipboard';

const labels: Record<string, [string, string, string]> = {
  en: ['Copy', 'Copied', 'Copy failed — select and copy manually'],
  fr: ['Copier', 'Copié', 'Échec — sélectionnez et copiez manuellement'],
  de: ['Kopieren', 'Kopiert', 'Fehlgeschlagen — bitte manuell kopieren'],
  es: ['Copiar', 'Copiado', 'Error — seleccione y copie manualmente'],
  it: ['Copia', 'Copiato', 'Errore — selezioni e copi manualmente'],
};

export function CopyValue({ text, children, className = '', locale = 'en', disabled = false }: {
  text: string; children: ReactNode; className?: string; locale?: string; disabled?: boolean;
}) {
  const [status, setStatus] = useState<0 | 1 | 2>(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const message = (labels[locale] ?? labels.en)[status];
  return <span className="copy-value-wrap">
    <button type="button" className={`copy-value ${className}`} disabled={disabled}
      title={message} aria-label={status === 0 ? `${message}: ${text}` : message}
      onKeyDown={e => e.stopPropagation()}
      onClick={async e => {
        e.stopPropagation();
        clearTimeout(timer.current);
        try { await copyText(text); setStatus(1); } catch { setStatus(2); }
        timer.current = setTimeout(() => setStatus(0), 2000);
      }}>{children}</button>
    <span role="status" className={`copy-value-status${status ? ' is-visible' : ''}`}>{status ? message : ''}</span>
  </span>;
}
