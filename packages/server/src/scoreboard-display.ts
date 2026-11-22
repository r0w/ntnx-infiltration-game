import { DEFAULT_SCOREBOARD_DISPLAY, isScoreboardDisplaySettings } from '@ntnx-game/shared';
import type { ClusterConfigQueries } from './db/queries';

export const SCOREBOARD_DISPLAY_KEY = 'scoreboard_display';

export function readScoreboardDisplay(config: ClusterConfigQueries) {
  const saved = config.get(SCOREBOARD_DISPLAY_KEY);
  return isScoreboardDisplaySettings(saved) ? saved : { ...DEFAULT_SCOREBOARD_DISPLAY };
}
