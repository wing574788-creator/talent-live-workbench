import type { Context } from 'hono';
import type { QueryOptions } from '../domain/entity-service.ts';
import type { WriteResult } from '../domain/types.ts';

export async function jsonBody(c: Context): Promise<Record<string, any>> {
  // eslint-disable-line @typescript-eslint/no-explicit-any
  return (await c.req.json().catch(() => ({}))) ?? {};
}

/** 列表查询参数：q、sort、dir、limit、offset、f.<列>=值（精确筛选）、c.<键>=值（自定义字段）。 */
export function parseListQuery(c: Context): QueryOptions & { platform?: string } {
  const raw = c.req.query();
  const filters: Record<string, string> = {};
  const custom: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('f.') && v) filters[k.slice(2)] = v;
    if (k.startsWith('c.') && v) custom[k.slice(2)] = v;
  }
  return {
    q: raw.q,
    sort: raw.sort || undefined,
    dir: raw.dir === 'desc' ? 'desc' : 'asc',
    limit: raw.limit ? Number(raw.limit) : undefined,
    offset: raw.offset ? Number(raw.offset) : undefined,
    platform: raw.platform || undefined,
    filters,
    custom,
  };
}

export function writeResponse(c: Context, r: WriteResult) {
  return r.status === 'applied' ? c.json(r) : c.json(r, 202);
}
