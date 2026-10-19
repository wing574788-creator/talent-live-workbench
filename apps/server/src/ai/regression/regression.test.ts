/**
 * 回归集自检：用本地假接口按"理想脚本"回放，证明每个用例的断言和理想行为自洽；
 * 再用"坏模型"（该拦的没拦、乱写）回放，证明断言真的能发现问题。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, runMigrations } from '../../db/index.ts';
import { createDomain } from '../../domain/index.ts';
import { createAiContext, type AiContext } from '../index.ts';
import { startMockOpenAI, type MockServer } from '../mock-openai.ts';
import { CASES } from './cases.ts';
import { runRegression } from './runner.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-reg-'));
const { db, sqlite } = openDb(dir);
runMigrations(db);
let mock: MockServer;
let ctx: AiContext;

beforeAll(async () => {
  mock = await startMockOpenAI();
  ctx = createAiContext(createDomain(db), dir);
  ctx.store.upsertProvider({
    id: 'mock',
    kind: 'openai-compatible',
    label: '本地假接口',
    region: 'local',
    baseUrl: mock.url,
    models: ['mock-1'],
  });
  ctx.store.setKey('mock', 'mock-key-0123456789');
  ctx.store.setPurpose('extract', { provider: 'mock', model: 'mock-1' });
  ctx.store.setPurpose('chat', { provider: 'mock', model: 'mock-1' });
});
afterAll(async () => {
  await mock.close();
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('工具调用回归集', () => {
  it('理想脚本下全部用例通过', async () => {
    const results = await runRegression(ctx, sqlite, {
      beforeCase: (c, fx) => mock.setScript(c.ideal(fx)),
    });
    const failed = results.filter((r) => !r.passed);
    expect(failed.map((r) => `${r.id}: ${r.error ?? r.failures.join('；')}`)).toEqual([]);
    expect(results).toHaveLength(CASES.length);
  }, 120_000);

  it('用例 id 不重复，覆盖查询、录入、审核、安全几类', () => {
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    expect(CASES.length).toBeGreaterThanOrEqual(12);
    expect(CASES.some((c) => c.mode === 'chat')).toBe(true);
  });

  it('坏模型会被发现：什么都不做、或直接乱写', async () => {
    const noop = await runRegression(ctx, sqlite, {
      only: ['delete-request', 'prd-example', 'qa-signed-not-live'],
      beforeCase: () => mock.setScript([{ text: '好的。' }]),
    });
    expect(noop.every((r) => !r.passed)).toBe(true);
    // 问答模式下试图写入：写入工具不可用，且用例要求不能有写入
    const bad = await runRegression(ctx, sqlite, {
      only: ['qa-org'],
      beforeCase: (_c, fx) =>
        mock.setScript([
          {
            toolCalls: [
              { name: 'propose_delete', args: { entity: 'influencer', id: fx.ah.inf.id } },
            ],
          },
          { text: '已删除。' },
        ]),
    });
    expect(bad[0]!.passed).toBe(false);
  }, 60_000);
});
