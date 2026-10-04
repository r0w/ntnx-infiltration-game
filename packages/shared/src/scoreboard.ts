export type ScoreboardDisplayMode = 'fit' | 'scroll';
export type ScrollSpeed = 12 | 24 | 48;
export interface ScoreboardDisplaySettings {
  mode: ScoreboardDisplayMode;
  speed: ScrollSpeed;
  paused: boolean;
  view: 'detailed' | 'simple';
  highlightProgress: boolean;
}

export const DEFAULT_SCOREBOARD_DISPLAY: ScoreboardDisplaySettings = {
  mode: 'fit', speed: 24, paused: false, view: 'detailed', highlightProgress: true,
};

export function isScoreboardDisplaySettings(value: unknown): value is ScoreboardDisplaySettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (v.mode === 'fit' || v.mode === 'scroll')
    && (v.speed === 12 || v.speed === 24 || v.speed === 48)
    && typeof v.paused === 'boolean'
    && (v.view === 'detailed' || v.view === 'simple')
    && typeof v.highlightProgress === 'boolean'
    && Object.keys(v).every((key) => Object.hasOwn(DEFAULT_SCOREBOARD_DISPLAY, key));
}
