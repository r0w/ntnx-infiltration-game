import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_SCOREBOARD_DISPLAY, isScoreboardDisplaySettings, type ScoreboardDisplaySettings } from '@ntnx-game/shared';
import { api } from './api';

/** Public readers retain the last good settings if the server is unavailable. */
export function useScoreboardDisplaySettings(password?: string) {
  const [settings, setSettings] = useState(DEFAULT_SCOREBOARD_DISPLAY);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saving = useRef(false);
  const version = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const requestVersion = version.current;
      try {
        if (!saving.current) {
          const next = await api.scoreboardDisplay(controller.signal);
          if (!isScoreboardDisplaySettings(next)) throw new Error('Invalid display settings received');
          if (!cancelled && requestVersion === version.current) {
            setSettings(next);
            setLoaded(true);
            setError(null);
          }
        }
      } catch (err) {
        if (!cancelled && requestVersion === version.current) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) timer = setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      mounted.current = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  const update = useCallback(async (next: ScoreboardDisplaySettings) => {
    if (!password || saving.current) return;
    saving.current = true;
    version.current++;
    const previous = settings;
    setSettings(next);
    setBusy(true);
    setSaveError(null);
    try {
      const saved = await api.adminScoreboardDisplaySave(password, next);
      if (mounted.current) setSettings(saved);
    } catch (err) {
      if (mounted.current) {
        setSettings(previous);
        setSaveError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [password, settings]);
  return { settings, update, loaded, busy, error: saveError ?? error };
}
