import { resolveKey } from '@ntnx-game/engine';
import type { Locale, StageDefinition } from '@ntnx-game/engine';
import type { LoadedPack, PackNavItem } from './pack-loader';

/** A nav row with its title resolved and its position in the run pinned down. */
export interface ResolvedNavItem {
  /** Absent on a section heading, which groups rows without being one. */
  stage?: string;
  title: string;
  /**
   * Position in pack order — what the client compares against to lock a row.
   * A heading borrows the earliest index below it, so it unlocks exactly when
   * its first page does.
   */
  index: number;
  /** This stage is validated against the cluster, so it is a lab, not a read. */
  hasCheck: boolean;
  items: ResolvedNavItem[];
}

export interface ResolvedNavChapter {
  id: string;
  title: string;
  optional: boolean;
  items: ResolvedNavItem[];
}

/**
 * Turn a pack's `nav` manifest into something a menu can render: titles in the
 * player's language, and each row's index in the run.
 *
 * Rows naming a stage the pack does not have are dropped rather than rendered
 * dead. A menu is a promise that a place exists; a row that leads nowhere is
 * worse than a missing one, and the warning says which key to fix.
 */
export function resolvePackNav(
  pack: LoadedPack,
  locale: Locale,
  onWarn?: (message: string) => void,
): ResolvedNavChapter[] {
  const nav = pack.manifest.nav;
  if (!nav || nav.length === 0) return [];

  const byName = new Map<string, StageDefinition>(pack.stages.map((s) => [s.name, s]));
  const title = (key: string) => resolveKey(key, locale, pack.bundle);

  const walk = (items: PackNavItem[]): ResolvedNavItem[] => {
    const out: ResolvedNavItem[] = [];
    for (const item of items) {
      const children = item.items ? walk(item.items) : [];

      // A heading: no stage of its own, so it lives entirely off its children.
      // One with nothing left under it is a label over emptiness — drop it.
      if (item.stage === undefined) {
        if (children.length === 0) {
          onWarn?.(`pack nav has a heading with no reachable rows under it: ${item.title}`);
          continue;
        }
        out.push({
          title: title(item.title),
          index: Math.min(...children.map((c) => c.index)),
          hasCheck: false,
          items: children,
        });
        continue;
      }

      const stage = byName.get(item.stage);
      if (!stage) {
        onWarn?.(`pack nav names a stage the pack does not have: ${item.stage}`);
        continue;
      }
      out.push({
        stage: item.stage,
        title: title(item.title),
        index: stage.index,
        hasCheck: !!stage.check,
        items: children,
      });
    }
    return out;
  };

  const chapters: ResolvedNavChapter[] = [];
  for (const chapter of nav) {
    const items = walk(chapter.items);
    // An empty chapter is a heading over nothing.
    if (items.length === 0) continue;
    chapters.push({
      id: chapter.id,
      title: title(chapter.title),
      optional: chapter.optional === true,
      items,
    });
  }
  return chapters;
}
