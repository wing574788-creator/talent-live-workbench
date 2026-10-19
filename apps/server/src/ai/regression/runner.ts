import type Database from 'better-sqlite3';
import type { Domain } from '../../domain/index.ts';
import type { AiContext } from '../index.ts';
import type { ChatEvent } from '../service.ts';
import { CASES, type RegressionCase, type ToolCall } from './cases.ts';
import { NOW, seedFixture } from './fixture.ts';

const RESET = [
  'change_log',
  'pending_changes',
  'outbound_logs',
  'ai_sessions',
  'sample_shipment_items',
  'sample_shipments',
  'follow_ups',
  'cooperation_products',
  'cooperations',
  'influencer_contacts',
  'platform_accounts',
  'influencers',
  'contacts',
  'product_variants',
  'products',
];

export interface CaseResult {
  id: string;
  title: string;
  passed: boolean;
  failures: string[];
  tools: string[];
  error?: string;
}

/** 逐个用例：重建固定数据 → 发一条消息 → 收集工具调用 → 断言。getDomain 每个用例重新取，保证数据干净。 */
export async function runRegression(
  ctx: AiContext,
  sqlite: Database.Database,
  opts: {
    only?: string[];
    onResult?: (r: CaseResult) => void;
    beforeCase?: (c: RegressionCase, fx: ReturnType<typeof seedFixture>) => void;
  } = {},
): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const c of CASES.filter((x) => !opts.only?.length || opts.only.includes(x.id))) {
    for (const t of RESET) sqlite.exec(`delete from ${t}`);
    const d: Domain = ctx.domain;
    const fx = seedFixture(d);
    opts.beforeCase?.(c, fx);
    const r = await runCase(ctx, sqlite, c, fx);
    results.push(r);
    opts.onResult?.(r);
  }
  return results;
}

async function runCase(
  ctx: AiContext,
  sqlite: Database.Database,
  c: RegressionCase,
  fx: ReturnType<typeof seedFixture>,
): Promise<CaseResult> {
  const events: ChatEvent[] = [];
  const calls: ToolCall[] = [];
  try {
    await ctx.service.chat(
      {
        text: c.text,
        mode: c.mode,
        now: NOW,
        context: c.context?.(fx),
        confirmed: c.confirmed?.(fx),
      },
      (e) => {
        events.push(e);
        if (e.type === 'tool' && e.state === 'start')
          calls.push({ name: e.name, args: (e.args ?? {}) as ToolCall['args'], ok: true });
        if (e.type === 'tool' && e.state === 'error') {
          const last = [...calls].reverse().find((x) => x.name === e.name && x.ok);
          if (last) last.ok = false;
        }
      },
    );
    const err = events.find((e) => e.type === 'error') as { message: string } | undefined;
    if (err)
      return {
        id: c.id,
        title: c.title,
        passed: false,
        failures: [],
        tools: calls.map((x) => x.name),
        error: err.message,
      };
    const reply = events
      .filter((e) => e.type === 'text')
      .map((e) => (e as { delta: string }).delta)
      .join('');
    const failures = c.check({ d: ctx.domain, fx, sqlite, events, calls, reply });
    return {
      id: c.id,
      title: c.title,
      passed: failures.length === 0,
      failures,
      tools: calls.map((x) => (x.ok ? x.name : `${x.name}(被拒)`)),
    };
  } catch (e) {
    return {
      id: c.id,
      title: c.title,
      passed: false,
      failures: [],
      tools: calls.map((x) => x.name),
      error: (e as Error).message,
    };
  }
}
