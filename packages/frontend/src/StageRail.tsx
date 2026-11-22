import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PackNavChapter, PackNavItem } from './api';

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
  // Shut by default: a bootcamp fully unfolded is a wall of rows. Only the
  // way down to where the player is stands open, and it opens further as they
  // advance. Nothing here ever closes a section the player opened by hand.
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, open ? '1' : '0');
    } catch {
      /* storage blocked — the rail just forgets between reloads */
    }
  }, [open]);

  useEffect(() => {
    const path = activePath(chapters, activeStage, currentIndex);
    setOpenIds((prev) => {
      if (path.every((k) => prev.has(k))) return prev;
      const next = new Set(prev);
      for (const k of path) next.add(k);
      return next;
    });
  }, [chapters, activeStage, currentIndex]);

  const toggle = useCallback((id: string) => {
    setOpenIds((prev) => {
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
            chapterKey={chapterKey(ch.id)}
            openIds={openIds}
            onToggle={toggle}
            currentIndex={currentIndex}
            activeStage={activeStage}
            onRead={onRead}
          />
        ))}
      </div>
    </nav>
  );
}

function Chapter({
  chapter,
  chapterKey: key,
  openIds,
  onToggle,
  currentIndex,
  activeStage,
  onRead,
}: {
  chapter: PackNavChapter;
  chapterKey: string;
  openIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  currentIndex: number;
  activeStage: string | null;
  onRead: (stage: string, title: string) => void;
}) {
  const collapsed = !openIds.has(key);
  // Headings are structure, not steps: the counter only tallies real stages.
  const flat = useMemo(
    () => flatten(chapter.items).filter((i) => i.stage !== undefined),
    [chapter.items],
  );
  const done = flat.filter((i) => i.index < currentIndex).length;
  const holdsActive = activeStage !== null && flat.some((i) => i.stage === activeStage);

  return (
    <section className={`rail-chapter${holdsActive ? ' is-here' : ''}`}>
      <button
        type="button"
        className="rail-chapter-head"
        onClick={() => onToggle(key)}
        aria-expanded={!collapsed}
      >
        <span className="rail-caret" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
        <span className="rail-chapter-title">{chapter.title}</span>
        {chapter.optional && <span className="rail-tag rail-tag-opt">optional</span>}
        <span className="rail-count">{done}/{flat.length}</span>
      </button>
      {!collapsed && (
        <ul className="rail-list">
          {chapter.items.map((item, i) => (
            <Row
              key={item.stage ?? `group-${i}`}
              item={item}
              rowKey={childKey(key, i)}
              depth={0}
              openIds={openIds}
              onToggle={onToggle}
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
  rowKey,
  depth,
  openIds,
  onToggle,
  currentIndex,
  activeStage,
  onRead,
}: {
  item: PackNavItem;
  rowKey: string;
  depth: number;
  openIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  currentIndex: number;
  activeStage: string | null;
  onRead: (stage: string, title: string) => void;
}) {
  const stage = item.stage;
  const isActive = stage !== undefined && stage === activeStage;
  const isDone = item.index < currentIndex;
  // Behind the player, or the step they are standing in: both are theirs to
  // re-read. Anything further on is not, and the server refuses it too.
  const canRead = stage !== undefined && item.index <= currentIndex;
  const state = isActive ? 'here' : isDone ? 'done' : 'ahead';

  const hasChildren = item.items.length > 0;
  const shown = openIds.has(rowKey);
  const children = hasChildren && shown && (
    <ul className="rail-list">
      {item.items.map((sub, i) => (
        <Row
          key={sub.stage ?? `group-${i}`}
          item={sub}
          rowKey={childKey(rowKey, i)}
          depth={depth + 1}
          openIds={openIds}
          onToggle={onToggle}
          currentIndex={currentIndex}
          activeStage={activeStage}
          onRead={onRead}
        />
      ))}
    </ul>
  );

  // A heading is structure, not a destination: it names the section its rows
  // belong to and is never clickable through to a stage. Since it has nothing
  // else to do, the whole label is what folds it.
  if (stage === undefined) {
    return (
      <li className={`rail-row rail-row-d${depth} rail-row-group`}>
        <button
          type="button"
          className={`rail-group-label is-${isDone ? 'done' : 'ahead'}`}
          onClick={() => onToggle(rowKey)}
          aria-expanded={shown}
        >
          <span className="rail-caret" aria-hidden="true">{shown ? '▾' : '▸'}</span>
          {item.title}
        </button>
        {children}
      </li>
    );
  }

  return (
    <li className={`rail-row rail-row-d${depth}`}>
      <div className="rail-row-head">
        {/* A row that is both a step and a section needs two targets: the
            label opens the reading panel, the caret folds what is under it. */}
        {hasChildren && (
          <button
            type="button"
            className="rail-fold"
            onClick={() => onToggle(rowKey)}
            aria-expanded={shown}
            aria-label={shown ? `Collapse ${item.title}` : `Expand ${item.title}`}
          >
            <span aria-hidden="true">{shown ? '▾' : '▸'}</span>
          </button>
        )}
        <button
          type="button"
          className={`rail-link is-${state}${canRead ? '' : ' is-static'}`}
          onClick={canRead ? () => onRead(stage, item.title) : undefined}
          disabled={!canRead}
          title={canRead ? 'Read this step again' : 'Not there yet'}
        >
          <span className="rail-glyph" aria-hidden="true">
            {isActive ? '▸' : isDone ? '✓' : '·'}
          </span>
          <span className="rail-label">{item.title}</span>
          {item.hasCheck && <span className="rail-tag rail-tag-lab">lab</span>}
        </button>
      </div>
      {children}
    </li>
  );
}

const chapterKey = (id: string) => `ch:${id}`;
const childKey = (parent: string, i: number) => `${parent}/${i}`;

/**
 * The keys that must be open for the player's own position to be visible:
 * its chapter, and every heading between that chapter and the row.
 *
 * The row itself is not included — reaching it is the point, opening it is
 * not. With nothing to match (an empty run), the first chapter stands open so
 * the menu never reads as broken.
 */
export function activePath(
  chapters: PackNavChapter[],
  activeStage: string | null,
  currentIndex: number,
): string[] {
  const isTarget = (item: PackNavItem) =>
    activeStage !== null
      ? item.stage === activeStage
      : item.stage !== undefined && item.index === currentIndex;

  const walk = (items: PackNavItem[], parent: string): string[] | null => {
    for (let i = 0; i < items.length; i++) {
      const key = childKey(parent, i);
      if (isTarget(items[i]!)) return [];
      const deeper = walk(items[i]!.items, key);
      if (deeper) return [key, ...deeper];
    }
    return null;
  };

  for (const ch of chapters) {
    const found = walk(ch.items, chapterKey(ch.id));
    if (found) return [chapterKey(ch.id), ...found];
  }
  return chapters.length > 0 ? [chapterKey(chapters[0]!.id)] : [];
}

function flatten(items: PackNavItem[]): PackNavItem[] {
  return items.flatMap((i) => [i, ...flatten(i.items)]);
}
