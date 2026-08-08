import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PackNavChapter, PackNavItem } from './api';
import { jumpToLive } from './stage-anchors';

const OPEN_KEY = 'ntnx-stage-rail-open';

/**
 * The reading menu down the left of the terminal.
 *
 * It is a map of the bootcamp, in the bootcamp's own chapters, and it does
 * exactly one thing: open a step the player has already reached, to read
 * again. It never advances the game and never unlocks anything — a menu that
 * could skip a lab would turn the run into a table of contents.
 *
 * Every step behind the player opens, not only the ones still on screen: the
 * text comes back from the server, so a learner in Observability can go back
 * and re-read Persistent storage, and a reload costs nothing.
 */
export function StageRail({
  chapters,
  currentIndex,
  activeStage,
  onRead,
}: {
  chapters: PackNavChapter[];
  /** Index of the furthest stage the player has reached, -1 before the first. */
  currentIndex: number;
  /** Stage being played right now, marked as the reader's position. */
  activeStage: string | null;
  /** Open a step for re-reading. */
  onRead: (stage: string, title: string) => void;
}) {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, open ? '1' : '0');
    } catch {
      /* storage blocked — the rail just forgets between reloads */
    }
  }, [open]);

  const toggleChapter = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (chapters.length === 0) return null;

  if (!open) {
    return (
      <nav className="stage-rail is-shut" aria-label="Bootcamp contents">
        <button
          type="button"
          className="stage-rail-handle"
          onClick={() => setOpen(true)}
          title="Show the contents"
          aria-expanded={false}
        >
          <span aria-hidden="true">☰</span>
          <span className="stage-rail-handle-label">contents</span>
        </button>
      </nav>
    );
  }

  return (
    <nav className="stage-rail" aria-label="Bootcamp contents">
      <div className="stage-rail-head">
        <span className="stage-rail-title">contents</span>
        <button
          type="button"
          className="stage-rail-shut"
          onClick={() => setOpen(false)}
          title="Hide the contents"
          aria-expanded
        >
          ‹
        </button>
      </div>
      <div className="stage-rail-body">
        {chapters.map((ch) => (
          <Chapter
            key={ch.id}
            chapter={ch}
            collapsed={collapsed.has(ch.id)}
            onToggle={() => toggleChapter(ch.id)}
            currentIndex={currentIndex}
            activeStage={activeStage}
            onRead={onRead}
          />
        ))}
      </div>
      <button type="button" className="stage-rail-live" onClick={jumpToLive}>
        back to where you are ↓
      </button>
    </nav>
  );
}

function Chapter({
  chapter,
  collapsed,
  onToggle,
  currentIndex,
  activeStage,
  onRead,
}: {
  chapter: PackNavChapter;
  collapsed: boolean;
  onToggle: () => void;
  currentIndex: number;
  activeStage: string | null;
  onRead: (stage: string, title: string) => void;
}) {
  const flat = useMemo(() => flatten(chapter.items), [chapter.items]);
  const done = flat.filter((i) => i.index < currentIndex).length;
  const holdsActive = activeStage !== null && flat.some((i) => i.stage === activeStage);

  return (
    <section className={`rail-chapter${holdsActive ? ' is-here' : ''}`}>
      <button
        type="button"
        className="rail-chapter-head"
        onClick={onToggle}
        aria-expanded={!collapsed}
      >
        <span className="rail-caret" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
        <span className="rail-chapter-title">{chapter.title}</span>
        {chapter.optional && <span className="rail-tag rail-tag-opt">optional</span>}
        <span className="rail-count">{done}/{flat.length}</span>
      </button>
      {!collapsed && (
        <ul className="rail-list">
          {chapter.items.map((item) => (
            <Row
              key={item.stage}
              item={item}
              depth={0}
              currentIndex={currentIndex}
              activeStage={activeStage}
              onRead={onRead}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function Row({
  item,
  depth,
  currentIndex,
  activeStage,
  onRead,
}: {
  item: PackNavItem;
  depth: number;
  currentIndex: number;
  activeStage: string | null;
  onRead: (stage: string, title: string) => void;
}) {
  const isActive = item.stage === activeStage;
  const isDone = item.index < currentIndex;
  // Behind the player, or the step they are standing in: both are theirs to
  // re-read. Anything further on is not, and the server refuses it too.
  const canRead = item.index <= currentIndex;
  const state = isActive ? 'here' : isDone ? 'done' : 'ahead';

  return (
    <li className={`rail-row rail-row-d${depth}`}>
      <button
        type="button"
        className={`rail-link is-${state}${canRead ? '' : ' is-static'}`}
        onClick={canRead ? () => onRead(item.stage, item.title) : undefined}
        disabled={!canRead}
        title={canRead ? 'Read this step again' : 'Not there yet'}
      >
        <span className="rail-glyph" aria-hidden="true">
          {isActive ? '▸' : isDone ? '✓' : '·'}
        </span>
        <span className="rail-label">{item.title}</span>
        {item.hasCheck && <span className="rail-tag rail-tag-lab">lab</span>}
      </button>
      {item.items.length > 0 && (
        <ul className="rail-list">
          {item.items.map((sub) => (
            <Row
              key={sub.stage}
              item={sub}
              depth={depth + 1}
              currentIndex={currentIndex}
              activeStage={activeStage}
              onRead={onRead}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function flatten(items: PackNavItem[]): PackNavItem[] {
  return items.flatMap((i) => [i, ...flatten(i.items)]);
}
