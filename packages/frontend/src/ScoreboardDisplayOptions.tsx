import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ScoreboardDemoControls } from './ScoreboardDemoControls';
import type { ScrollSpeed } from './scoreboardDisplay';
import { useScoreboardDisplaySettings } from './useScoreboardDisplaySettings';

export function ScoreboardDisplayOptions({ password }: { password: string }) {
  const { settings, update: onChange, loaded, busy, error } = useScoreboardDisplaySettings(password);
  const [demoCount, setDemoCount] = useState(50);
  const [combined, setCombined] = useState(true);
  const [simulate, setSimulate] = useState(false);
  return (
    <section className="admin-panel scoreboard-display-options">
      <div className="admin-panel-head">
        <h3 className="admin-panel-title">Scoreboard display</h3>
        <p className="admin-panel-desc">Saved on this game server. All its scoreboards, including combined views and mock previews, update within 5 seconds.</p>
      </div>
      {error && <div className="app-error" role="alert">Display settings: {error}</div>}
      <p className="admin-panel-desc" role="status">{busy ? 'Saving…' : !loaded ? 'Loading display settings…' : error ? 'Previous settings remain active.' : 'Settings saved on this server.'}</p>
      <fieldset disabled={!loaded || busy}>
        <legend>When the board gets crowded</legend>
        <label className="scoreboard-display-choice">
          <input type="radio" name="scoreboard-display" value="fit" checked={settings.mode === 'fit'} onChange={() => onChange({ ...settings, mode: 'fit', paused: false })} />
          <span><strong>Fit everyone</strong><small>Show the entire ranking on one screen. Text gets smaller when needed.</small></span>
        </label>
        <label className="scoreboard-display-choice">
          <input type="radio" name="scoreboard-display" value="scroll" checked={settings.mode === 'scroll'} onChange={() => onChange({ ...settings, mode: 'scroll', paused: false })} />
          <span><strong>Auto-scroll</strong><small>Scroll down and back up at the same speed, with a pause at each end.</small></span>
        </label>
        <label className="scoreboard-display-choice">
          <input type="checkbox" checked={settings.view === 'simple'} onChange={(event) => onChange({ ...settings, view: event.target.checked ? 'simple' : 'detailed' })} />
          <span><strong>Simplified projection</strong><small>Show rank, name, trigram, cluster and progress. Hide stage, timing and help details.</small></span>
        </label>
        <label className="scoreboard-display-choice">
          <input type="checkbox" checked={settings.highlightProgress} onChange={(event) => onChange({ ...settings, highlightProgress: event.target.checked })} />
          <span><strong>Highlight progress</strong><small>Briefly illuminate an agent's card when they complete a stage.</small></span>
        </label>
        <div className="scoreboard-display-actions">
          <label className="scoreboard-speed">
            Scroll speed
            <select value={settings.speed} disabled={settings.mode !== 'scroll'} onChange={(event) => onChange({ ...settings, speed: Number(event.target.value) as ScrollSpeed })}>
              <option value={12}>Slow</option>
              <option value={24}>Normal</option>
              <option value={48}>Fast</option>
            </select>
          </label>
          <button className="modal-btn" type="button" disabled={settings.mode !== 'scroll'} onClick={() => onChange({ ...settings, paused: !settings.paused })}>
            {settings.paused ? 'Resume scroll' : 'Pause scroll'}
          </button>
          <Link to="/scoreboard" target="_blank" rel="noreferrer">open scoreboard ↗</Link>
          <Link to="/scoreboard?combined=1" target="_blank" rel="noreferrer">open combined scoreboard ↗</Link>
        </div>
      </fieldset>
      <div className="scoreboard-preview-controls">
        <h4>Mock preview</h4>
        <p className="admin-panel-desc">Compare the display modes with fictional players. The projected view contains no controls.</p>
        <label className="scoreboard-display-choice">
          <input type="checkbox" checked={simulate} onChange={(event) => setSimulate(event.target.checked)} />
          <span>Advance a random participant every 5 seconds</span>
        </label>
        <ScoreboardDemoControls current={demoCount} onPick={setDemoCount} combined={combined} onToggleCombined={() => setCombined(!combined)} />
        <Link to={`/scoreboard?demo=${demoCount}${combined ? '&combined=1' : ''}${simulate ? '&simulate=1' : ''}`} target="_blank" rel="noreferrer">open mock preview · {demoCount} agents ↗</Link>
      </div>
    </section>
  );
}
