/**
 * 端到端（REST，走完整的 HTTP 应用）：建达人 → 建合作 → 洽谈多轮跟进 → 待寄样 → 寄出 → 开播 →
 * 退样质检 → 完成，并检查每一步的阶段、样品在外数量、变更日志、撤销。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { openDb, runMigrations } from './db/index.ts';
import { createDomain } from './domain/index.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-e2e-flow-'));
const { db, sqlite } = openDb(dir);
runMigrations(db);
const app = createApp({ db, sqlite, domain: createDomain(db), dataDir: dir });
afterAll(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const ok = async (method: string, url: string, body?: unknown) => {
  const r = await call(method, url, body);
  expect(r.status, `${method} ${url} → ${JSON.stringify(r.data)}`).toBeLessThan(300);
  return r.data;
};

describe('主流程端到端', () => {
  it('从建达人到合作完成', async () => {
    // 商品（含颜色尺码）
    const product = (
      await ok('POST', '/products', {
        product: { styleNo: 'A001', name: '羊毛大衣', livePriceCents: 129900 },
        variants: [
          { color: '黑色', size: 'S' },
          { color: '黑色', size: 'M' },
        ],
      })
    ).row;

    // 达人 + 账号
    const created = await ok('POST', '/influencers', {
      influencer: { nickname: '示例达人小美', realName: '测试甲' },
      accounts: [{ platform: '抖音', accountId: 'e2e_xm_001' }],
    });
    const inf = created.influencer;
    const account = created.accounts[0];
    // 账号重复：查重命中，不能再建
    const dup = await ok('GET', `/influencers/check-duplicate?platform=抖音&accountId=e2e_xm_001`);
    expect(dup.exact.influencer.id).toBe(inf.id);
    expect(
      (
        await call('POST', '/influencers', {
          influencer: { nickname: '另一个' },
          accounts: [{ platform: '抖音', accountId: 'e2e_xm_001' }],
        })
      ).status,
    ).toBe(409);

    // 合作：待建联，挂商品和佣金（佣金设在合作商品上）
    const coop = (
      await ok('POST', '/cooperations', {
        cooperation: { influencerId: inf.id, platformAccountId: account.id, stage: '待建联' },
        products: [{ productId: product.id, commissionPct: 20 }],
      })
    ).row;
    expect(coop.stage).toBe('待建联');

    // 洽谈中必须有下次跟进日期
    const refuse = await call('PATCH', `/e/cooperation/${coop.id}`, {
      patch: { stage: '洽谈中' },
      expectedVersion: coop.version,
    });
    expect(refuse.status).toBe(400);
    await ok('PATCH', `/e/cooperation/${coop.id}`, {
      patch: { stage: '洽谈中', followStatus: '已发邀约', nextFollowDate: '2026-10-20' },
    });

    // 洽谈多轮跟进：状态与下次跟进日期同步到合作
    for (const [i, [status, next]] of [
      ['待回复', '2026-10-22'],
      ['报价中', '2026-10-24'],
      ['选款中', '2026-10-26'],
    ].entries()) {
      await ok('POST', '/e/follow_up', {
        cooperationId: coop.id,
        occurredAt: new Date(Date.UTC(2026, 9, 18 + i, 4)).toISOString(),
        method: '微信',
        summary: `第 ${i + 1} 轮沟通`,
        followStatus: status,
        nextFollowDate: next,
      });
    }
    let detail = await ok('GET', `/cooperations/${coop.id}`);
    expect(detail.cooperation.followStatus).toBe('选款中');
    expect(detail.cooperation.nextFollowDate).toBe('2026-10-26');
    expect(detail.followUps).toHaveLength(3);

    // 确认合作、排期（开播日已过，方便之后由每日推进变成已开播）
    await ok('PATCH', `/e/cooperation/${coop.id}`, {
      patch: { stage: '已确认', liveDate: '2026-10-01' },
    });

    // 新建待寄样单 → 合作自动进入待寄样；还没寄出，不计入在外
    const ship = (
      await ok('POST', '/samples/shipments', {
        influencerId: inf.id,
        cooperationId: coop.id,
        items: [
          { productId: product.id, color: '黑色', size: 'S', qty: 1 },
          { productId: product.id, color: '黑色', size: 'M', qty: 2 },
        ],
      })
    ).row;
    expect((await ok('GET', `/cooperations/${coop.id}`)).cooperation.stage).toBe('待寄样');
    expect((await ok('GET', `/influencers/${inf.id}/samples`)).summary?.outstanding ?? 0).toBe(0);

    // 寄出 → 已排期，在外 3 件；应寄回日期按开播日 + N 天
    await ok('POST', `/samples/shipments/${ship.id}/ship`, {
      shippedAt: '2026-09-28',
      recipient: '测试甲',
      phone: '13800001111',
      address: '虚构市虚构区示例路1号',
      carrier: '示例快递',
      trackingNo: 'E2E0001',
    });
    await ok('POST', `/samples/shipments/${ship.id}/sign`, { signedAt: '2026-09-30' });
    expect((await ok('GET', `/cooperations/${coop.id}`)).cooperation.stage).toBe('已排期');
    let samples = (await ok('GET', '/samples')).rows;
    expect(
      samples.find((s: { influencer: { id: string } }) => s.influencer.id === inf.id).outstanding,
    ).toBe(3);

    // 每日推进：开播日已过 → 已开播 → 样品仍在外 → 待退样
    await ok('POST', '/automation/run');
    expect((await ok('GET', `/cooperations/${coop.id}`)).cooperation.stage).toBe('待退样');

    // 退样质检：先退 S 码（有污渍），在外 2 件，合作仍待退样；回收问题次数 +1
    await ok('POST', '/samples/returns', {
      influencerId: inf.id,
      returnedAt: '2026-10-12',
      items: [
        {
          styleNo: 'A001',
          productName: '羊毛大衣',
          color: '黑色',
          size: 'S',
          qty: 1,
          qaResult: '污渍',
          disposition: '待沟通',
        },
      ],
    });
    expect((await ok('GET', `/cooperations/${coop.id}`)).cooperation.stage).toBe('待退样');
    expect((await ok('GET', `/influencers/${inf.id}`)).influencer.recycleIssueCount).toBe(1);
    // 超量退回被拒绝
    expect(
      (
        await call('POST', '/samples/returns', {
          influencerId: inf.id,
          returnedAt: '2026-10-13',
          items: [{ styleNo: 'A001', productName: '羊毛大衣', color: '黑色', size: 'M', qty: 3 }],
        })
      ).status,
    ).toBe(400);
    // 再退 M 码 2 件，样品结清 → 待复盘
    await ok('POST', '/samples/returns', {
      influencerId: inf.id,
      returnedAt: '2026-10-14',
      items: [
        {
          styleNo: 'A001',
          productName: '羊毛大衣',
          color: '黑色',
          size: 'M',
          qty: 2,
          qaResult: '完好',
          disposition: '重新入库',
        },
      ],
    });
    detail = await ok('GET', `/cooperations/${coop.id}`);
    expect(detail.cooperation.stage).toBe('待复盘');
    samples = (await ok('GET', '/samples')).rows;
    expect(
      samples.find((s: { influencer: { id: string } }) => s.influencer.id === inf.id).outstanding,
    ).toBe(0);

    // 复盘后完成；付款状态是独立字段
    await ok('PATCH', `/e/cooperation/${coop.id}`, { patch: { paymentStatus: '已付' } });
    const done = await call('PATCH', `/e/cooperation/${coop.id}`, { patch: { stage: '完成' } });
    // 已完成的合作再改属于敏感操作：完成这一步本身由用户手动操作，直接生效
    expect(done.status).toBe(200);
    expect(done.data.status).toBe('applied');
    expect((await ok('GET', `/cooperations/${coop.id}`)).cooperation.stage).toBe('完成');

    // 变更日志完整，且可撤销：撤销"完成"回到待复盘
    const logs = await ok('GET', `/changes?entity=cooperation&limit=100`);
    const finish = logs.rows.find(
      (l: { changes: { field: string; after: string }[]; revertedAt: string | null }) =>
        !l.revertedAt && l.changes.some((c) => c.field === 'stage' && c.after === '完成'),
    );
    expect(finish).toBeTruthy();
    await ok('POST', `/changes/${finish.id}/undo`);
    expect((await ok('GET', `/cooperations/${coop.id}`)).cooperation.stage).toBe('待复盘');

    // 完成后，来自 AI 的修改要审核：已完成的合作被 AI 改动只生成待审核（见领域测试），这里只确认首页数据可用
    const home = await ok('GET', '/home');
    expect(home.cards.samples.outstanding).toBe(0);
  });
});
