import type { CheckContext } from '@ntnx-game/engine';

export interface ProjectCategory {
  extId?: string;
  key?: string;
  value?: string;
  projectExtId?: string;
}

/** Read raw JSON: the older generated SDK drops projectExtId on deserialization. */
export async function projectCategories(ctx: Pick<CheckContext, 'nutanix'>): Promise<ProjectCategory[]> {
  const categories: ProjectCategory[] = [];
  for (let page = 0; page < 200; page++) {
    const result = await ctx.nutanix.rest.request<{
      data?: ProjectCategory[];
      metadata?: { totalAvailableResults?: number };
    }>('GET', `/api/prism/v4.2/config/categories?$page=${page}&$limit=100`);
    if (!Array.isArray(result.data)) throw new Error('Invalid category inventory response');
    categories.push(...result.data);
    if (result.data.length < 100 || categories.length >= (result.metadata?.totalAvailableResults ?? Infinity)) return categories;
  }
  throw new Error('Category inventory exceeded 200 pages');
}

export function categoryProjectError(categories: ProjectCategory[], key: string, projectId: string): string | undefined {
  const wrong = categories.find(c => c.key === key && ['Critical', 'Test'].includes(c.value ?? '') && c.projectExtId !== projectId);
  if (wrong) return `Category '${key}:${wrong.value}' must have Owner Project '${key.replace(/-cat$/, '-proj')}'. Sharing a category is not ownership. Existing category ownership cannot be changed in place.`;
}
