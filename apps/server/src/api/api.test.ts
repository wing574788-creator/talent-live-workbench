import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { openDb, runMigrations } from '../db/index.ts';
import { createDomain, type Domain } from '../domain/index.ts';
import { nicknameSimilarity } from '../domain/influencer-service.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-api-'));
const { db, sqlite } = openDb(dir);
runMigrations(db);
let domain: Domain;
let app: ReturnType<typeof createApp>;

afterAll(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const t of [
    'change_log',
    'pending_changes',
    'cooperations',
    'influencers',
    'platform_accounts',
    'products',
    'product_variants',
    'product_images',
    'attachments',
    'contacts',
    'influencer_contacts',
    'influencer_addresses',
    'follow_ups',
    'sample_shipments',
    'field_defs',
    'saved_views',
  ])
    sqlite.exec(`delete from ${t}`);
  domain = createDomain(db);
  app = createApp({ db, sqlite, domain, dataDir: dir });
});

async function call(method: string, url: string, body?: unknown) {
  const res = await app.request('/api' + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const newInfluencer = (nickname: string, accountId: string, platform = '小红书') =>
  call('POST', '/influencers', { influencer: { nickname }, accounts: [{ platform, accountId }] });

describe('商品', () => {
  it('创建商品连同规格；款号重复被拒绝；列表可搜索排序', async () => {
    const r = await call('POST', '/products', {
      product: { styleNo: 'A001', name: '羊毛大衣', livePriceCents: 129900 },
      variants: [
        { color: '黑色', size: 'M' },
        { color: '黑色', size: 'S' },
      ],
    });
    expect(r.status).toBe(200);
    expect(
      (await call('POST', '/products', { product: { styleNo: 'A001', name: '重复' } })).status,
    ).toBe(409);
    await call('POST', '/products', { product: { styleNo: 'B002', name: '风衣' } });
    const list = await call('GET', '/products?q=大衣');
    expect(list.body.rows.map((x: any) => x.styleNo)).toEqual(['A001']); // eslint-disable-line @typescript-eslint/no-explicit-any
    const sorted = await call('GET', '/products?sort=styleNo&dir=desc');
    expect(sorted.body.rows[0].styleNo).toBe('B002');
    const detail = await call('GET', `/products/${r.body.row.id}`);
    expect(detail.body.variants).toHaveLength(2);
  });

  it('规格重复整体回滚，不留下半个商品', async () => {
    const r = await call('POST', '/products', {
      product: { styleNo: 'C003', name: '半身裙' },
      variants: [
        { color: '黑色', size: 'M' },
        { color: '黑色', size: 'M' },
      ],
    });
    expect(r.status).toBe(409);
    expect((await call('GET', '/products?q=C003')).body.total).toBe(0);
  });

  it('排序列走白名单，非法列返回 400', async () => {
    expect((await call('GET', '/products?sort=id;drop')).status).toBe(400);
  });

  it('上传图片：落盘、可读取，第一张为主图，可改主图', async () => {
    const p = await call('POST', '/products', { product: { styleNo: 'D004', name: '针织衫' } });
    const upload = async (name: string) => {
      const form = new FormData();
      form.append('file', new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' }));
      const res = await app.request(`/api/products/${p.body.row.id}/images`, {
        method: 'POST',
        body: form,
      });
      return (await res.json()) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    const first = await upload('a.png');
    const second = await upload('b.png');
    await call('POST', `/products/${p.body.row.id}/images/${second.row.id}/primary`);
    const detail = await call('GET', `/products/${p.body.row.id}`);
    expect(detail.body.images.map((i: any) => i.id)).toEqual([second.row.id, first.row.id]); // eslint-disable-line @typescript-eslint/no-explicit-any
    const file = await app.request(`/api/attachments/${detail.body.images[0].attachmentId}/file`);
    expect(file.status).toBe(200);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    const bad = new FormData();
    bad.append('file', new File(['x'], 'x.exe', { type: 'application/x-msdownload' }));
    expect(
      (await app.request(`/api/products/${p.body.row.id}/images`, { method: 'POST', body: bad }))
        .status,
    ).toBe(400);
  });
});

describe('达人查重（PRD 5.2 验收）', () => {
  it('重复的平台 + 账号 ID 无法新建第二条，且不留下半个达人', async () => {
    expect((await newInfluencer('小美', 'xm001')).status).toBe(200);
    const dup = await newInfluencer('另一个小美', 'xm001');
    expect(dup.status).toBe(409);
    expect((await call('GET', '/influencers')).body.total).toBe(1);
    expect((await newInfluencer('小美', 'xm001', '抖音')).status).toBe(200);
  });

  it('实时查重：账号精确命中；昵称相似只提示、不自动合并', async () => {
    await newInfluencer('小美穿搭', 'xm001');
    await newInfluencer('完全不同的人', 'xm002');
    const exact = await call('GET', '/influencers/check-duplicate?platform=小红书&accountId=xm001');
    expect(exact.body.exact.influencer.nickname).toBe('小美穿搭');
    const similar = await call('GET', '/influencers/check-duplicate?nickname=小美 穿搭');
    expect(similar.body.exact).toBeNull();
    expect(similar.body.similar.map((s: any) => s.influencer.nickname)).toEqual(['小美穿搭']); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await call('GET', '/influencers')).body.total).toBe(2);
  });

  it('昵称相似度', () => {
    expect(nicknameSimilarity('小美·穿搭', '小美穿搭')).toBe(1);
    expect(nicknameSimilarity('小美', '小美穿搭日记')).toBeGreaterThanOrEqual(0.6);
    expect(nicknameSimilarity('阿花', '大壮')).toBeLessThan(0.6);
  });

  it('列表搜索同时匹配昵称和账号 ID，带账号摘要', async () => {
    await newInfluencer('小美', 'xm001');
    const byAccount = await call('GET', '/influencers?q=xm00');
    expect(byAccount.body.rows[0].accounts[0].accountId).toBe('xm001');
    expect((await call('GET', '/influencers?platform=抖音')).body.total).toBe(0);
  });
});

describe('达人合并走审核队列（PRD 5.2 验收）', () => {
  it('合并只生成待审核；通过后跟进、合作、样品、账号全部归到保留档案，被合并者软删除，可整批撤销', async () => {
    const keep = (await newInfluencer('小美', 'xm001')).body.influencer;
    const dupe = (await newInfluencer('小美的小号', 'xm001b')).body;
    const dupeInf = dupe.influencer;
    const me = domain.userActor();
    const coop = (
      domain.entity('cooperation').create(me, {
        influencerId: dupeInf.id,
        platformAccountId: dupe.accounts[0].id,
        stage: '完成',
      }) as any
    ).row; // eslint-disable-line @typescript-eslint/no-explicit-any
    domain.entity('follow_up').create(me, {
      occurredAt: new Date().toISOString(),
      method: '微信',
      influencerId: dupeInf.id,
      summary: '聊了合作',
    });
    domain.entity('sample_shipment').create(me, { influencerId: dupeInf.id });
    const contact = (await call('POST', '/e/contact', { name: '经纪人王', type: '经纪人' })).body
      .row;
    await call('POST', `/influencers/${dupeInf.id}/contacts`, {
      contactId: contact.id,
      isPrimary: true,
    });

    const req = await call('POST', `/influencers/${keep.id}/merge`, { mergeId: dupeInf.id });
    expect(req.status).toBe(202);
    expect((await call('GET', `/influencers/${dupeInf.id}`)).status).toBe(200); // 未审核前原样存在

    const approved = await call('POST', `/review/${req.body.pendingId}/approve`);
    expect(approved.status).toBe(200);
    expect((await call('GET', `/influencers/${dupeInf.id}`)).status).toBe(404);
    const detail = (await call('GET', `/influencers/${keep.id}`)).body;
    expect(detail.accounts.map((a: any) => a.accountId).sort()).toEqual(['xm001', 'xm001b']); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(detail.cooperations.map((c: any) => c.id)).toEqual([coop.id]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(detail.followUps).toHaveLength(1);
    expect(detail.summary.shipmentCount).toBe(1);
    expect(detail.contacts).toHaveLength(1);

    const undo = await call('POST', `/batches/${req.body.pendingId}/undo`);
    expect(undo.body.conflicts).toHaveLength(0);
    expect((await call('GET', `/influencers/${dupeInf.id}`)).status).toBe(200);
    expect((await call('GET', `/influencers/${keep.id}`)).body.accounts).toHaveLength(1);
  });

  it('不能合并到自己；审核前任一方被改动则判冲突', async () => {
    const a = (await newInfluencer('甲', 'a1')).body.influencer;
    const b = (await newInfluencer('乙', 'b1')).body.influencer;
    expect((await call('POST', `/influencers/${a.id}/merge`, { mergeId: a.id })).status).toBe(400);
    const req = await call('POST', `/influencers/${a.id}/merge`, { mergeId: b.id });
    await call('PATCH', `/e/influencer/${b.id}`, { patch: { rating: 'A' } });
    expect((await call('POST', `/review/${req.body.pendingId}/approve`)).status).toBe(409);
    expect((await call('GET', `/influencers/${b.id}`)).status).toBe(200);
  });
});

describe('联系人', () => {
  it('类型校验；关联多个达人；主要对接人唯一', async () => {
    expect((await call('POST', '/e/contact', { name: '王', type: '路人' })).status).toBe(400);
    const c1 = (
      await call('POST', '/e/contact', { name: '经纪人王', type: '经纪人', org: '某MCN' })
    ).body.row;
    const a = (await newInfluencer('甲', 'a1')).body.influencer;
    const c2 = (await call('POST', '/e/contact', { name: '私人商务李', type: '私人商务' })).body
      .row;
    await call('POST', `/influencers/${a.id}/contacts`, { contactId: c1.id, isPrimary: true });
    await call('POST', `/influencers/${a.id}/contacts`, { contactId: c2.id, isPrimary: true });
    const d = (await call('GET', `/influencers/${a.id}`)).body;
    expect(d.contacts.filter((l: any) => l.isPrimary)).toHaveLength(1); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(d.contacts.find((l: any) => l.isPrimary).contactId).toBe(c2.id); // eslint-disable-line @typescript-eslint/no-explicit-any
    const b = (await newInfluencer('乙', 'b1')).body.influencer;
    await call('POST', `/influencers/${b.id}/contacts`, { contactId: c1.id });
    expect((await call('GET', `/contacts/${c1.id}`)).body.influencers).toHaveLength(2);
    expect((await call('GET', '/contacts?f.type=经纪人')).body.total).toBe(1);
  });
});

describe('敏感字段默认打码', () => {
  it('列表、详情、变更历史都不含明文；reveal 才返回明文', async () => {
    const c = (
      await call('POST', '/e/contact', {
        name: '王',
        type: '经纪人',
        wechat: 'wangwx888',
        phone: '13812345678',
      })
    ).body.row;
    const list = await call('GET', '/contacts');
    expect(JSON.stringify(list.body)).not.toContain('13812345678');
    expect(list.body.rows[0].phone).toBe('138****5678');
    const detail = await call('GET', `/contacts/${c.id}`);
    expect(JSON.stringify(detail.body)).not.toMatch(/13812345678|wangwx888/);
    expect((await call('GET', `/contacts/${c.id}/reveal`)).body).toEqual({
      wechat: 'wangwx888',
      phone: '13812345678',
    });

    const inf = (
      await call('POST', '/influencers', { influencer: { nickname: '甲', realName: '张三丰' } })
    ).body.influencer;
    await call('POST', '/e/influencer_address', {
      influencerId: inf.id,
      recipient: '张三丰',
      phone: '13900001111',
      address: '上海市徐汇区某路 1 号',
    });
    const idetail = JSON.stringify((await call('GET', `/influencers/${inf.id}`)).body);
    expect(idetail).not.toMatch(/张三丰|13900001111|某路/);
    const rev = (await call('GET', `/influencers/${inf.id}/reveal`)).body;
    expect(rev.realName).toBe('张三丰');
    expect(rev.addresses[0].address).toContain('某路');
  });
});

describe('自定义字段', () => {
  it('定义后才能写值，类型校验，可按自定义字段筛选', async () => {
    expect(
      (
        await call('POST', '/e/product', {
          styleNo: 'X1',
          name: '连衣裙',
          custom: { season: '夏' },
        })
      ).status,
    ).toBe(400);
    await call('POST', '/e/field_def', {
      entity: 'product',
      key: 'season',
      label: '季节',
      type: 'select',
      options: ['春', '夏', '秋', '冬'],
    });
    await call('POST', '/e/field_def', {
      entity: 'product',
      key: 'weight_g',
      label: '克重',
      type: 'number',
    });
    expect(
      (
        await call('POST', '/e/product', {
          styleNo: 'X1',
          name: '连衣裙',
          custom: { season: '梅雨' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('POST', '/e/product', {
          styleNo: 'X1',
          name: '连衣裙',
          custom: { season: '夏', weight_g: '很重' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('POST', '/e/product', {
          styleNo: 'X1',
          name: '连衣裙',
          custom: { season: '夏', weight_g: 300 },
        })
      ).status,
    ).toBe(200);
    await call('POST', '/e/product', { styleNo: 'X2', name: '羽绒服', custom: { season: '冬' } });
    const res = await call('GET', '/products?c.season=夏');
    expect(res.body.rows.map((r: any) => r.styleNo)).toEqual(['X1']); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await call('GET', '/products?c.season%27)--=1')).status).toBe(400);
    expect((await call('GET', '/e/field_def?f.entity=product')).body.total).toBe(2);
  });
});

describe('保存视图与变更历史', () => {
  it('保存视图同名重复被拒绝；详情含变更历史并可撤销', async () => {
    const v = { entity: 'product', name: '在售大衣', config: { q: '大衣', hidden: ['name'] } };
    expect((await call('POST', '/e/saved_view', v)).status).toBe(200);
    expect((await call('POST', '/e/saved_view', v)).status).toBe(409);
    expect((await call('GET', '/e/saved_view?f.entity=product')).body.total).toBe(1);

    const p = (await call('POST', '/products', { product: { styleNo: 'H1', name: '大衣' } })).body
      .row;
    const upd = await call('PATCH', `/e/product/${p.id}`, {
      patch: { name: '长大衣' },
      expectedVersion: 1,
    });
    expect(
      (await call('PATCH', `/e/product/${p.id}`, { patch: { name: '短大衣' }, expectedVersion: 1 }))
        .status,
    ).toBe(409);
    const hist = (await call('GET', `/products/${p.id}`)).body.history;
    expect(hist[0].action).toBe('update');
    await call('POST', `/changes/${upd.body.logId}/undo`);
    expect((await call('GET', `/products/${p.id}`)).body.product.name).toBe('大衣');
  });
});

describe('合作 API', () => {
  async function coopFixture() {
    const inf = (await newInfluencer('小美', 'xm001')).body;
    const p1 = (await call('POST', '/products', { product: { styleNo: 'A1', name: '大衣' } })).body
      .row;
    const p2 = (await call('POST', '/products', { product: { styleNo: 'A2', name: '风衣' } })).body
      .row;
    return { inf: inf.influencer, acc: inf.accounts[0], p1, p2 };
  }

  it('新建合作同时写合作商品（各自佣金）；商品不存在时整体回滚', async () => {
    const { inf, acc, p1, p2 } = await coopFixture();
    const base = { influencerId: inf.id, platformAccountId: acc.id };
    const ok = await call('POST', '/cooperations', {
      cooperation: base,
      products: [
        { productId: p1.id, commissionPct: 20 },
        { productId: p2.id, commissionPct: 25 },
      ],
    });
    expect(ok.status).toBe(200);
    const detail = await call('GET', `/cooperations/${ok.body.row.id}`);
    expect(detail.body.products).toHaveLength(2);
    expect(detail.body.influencer.nickname).toBe('小美');

    const bad = await call('POST', '/cooperations', {
      cooperation: base,
      products: [
        { productId: p1.id, commissionPct: 20 },
        { productId: p1.id, commissionPct: 120 },
      ],
    });
    expect(bad.status).toBe(400);
    expect((await call('GET', '/cooperations')).body.total).toBe(1);
  });

  it('列表支持按阶段筛选、按达人昵称/账号 ID 搜索；阶段变更走 PATCH 并校验原因', async () => {
    const { inf, acc } = await coopFixture();
    const c = (
      await call('POST', '/cooperations', {
        cooperation: { influencerId: inf.id, platformAccountId: acc.id },
      })
    ).body.row;
    expect((await call('GET', '/cooperations?q=xm00')).body.total).toBe(1);
    expect((await call('GET', '/cooperations?q=不存在')).body.total).toBe(0);
    expect((await call('GET', '/cooperations?f.stage=洽谈中')).body.total).toBe(0);
    const lost = await call('PATCH', `/e/cooperation/${c.id}`, {
      patch: { stage: '流失' },
      expectedVersion: 1,
    });
    expect(lost.status).toBe(400);
    expect(lost.body.error).toMatch(/原因/);
    const ok = await call('PATCH', `/e/cooperation/${c.id}`, {
      patch: { stage: '流失', lostReason: '没档期' },
      expectedVersion: 1,
    });
    expect(ok.status).toBe(200);
    expect((await call('GET', '/cooperations?f.stage=流失')).body.rows[0].lostReason).toBe(
      '没档期',
    );
  });

  it('设置：跟进状态选项可增删，连续待回复阈值可改且有范围校验', async () => {
    const s = await call('GET', '/settings');
    expect(s.body.followStatuses.map((x: any) => x.value)).toContain('报价中');
    expect(s.body.replyStallCount).toBe(3);
    expect((await call('PUT', '/settings/replyStallCount', { value: 1 })).status).toBe(400);
    expect((await call('PUT', '/settings/replyStallCount', { value: 4 })).status).toBe(200);
    expect((await call('GET', '/settings')).body.replyStallCount).toBe(4);
    expect(s.body.defaultFollowDays).toBe(3);
    expect((await call('PUT', '/settings/defaultFollowDays', { value: 0 })).status).toBe(400);
    expect((await call('PUT', '/settings/defaultFollowDays', { value: 5 })).status).toBe(200);
    expect((await call('GET', '/settings')).body.defaultFollowDays).toBe(5);
    await call('POST', '/e/enum_option', { group: 'follow_status', value: '谈崩了' });
    expect((await call('GET', '/settings')).body.followStatuses.map((x: any) => x.value)).toContain(
      '谈崩了',
    );
  });
});

describe('样品台账 API', () => {
  it('寄出后收件信息打码；筛选在外/逾期；批量寄出逐条返回结果', async () => {
    const inf = (await newInfluencer('样品达人', 'smp001')).body.influencer;
    await call('POST', '/e/influencer_address', {
      influencerId: inf.id,
      recipient: '张三丰',
      phone: '13900001111',
      address: '上海市徐汇区某路 9 号',
      isDefault: true,
    });
    const p = (
      await call('POST', '/products', {
        product: { styleNo: 'S1', name: '针织衫' },
        variants: [{ color: '白色', size: 'M' }],
      })
    ).body.row;
    const s = await call('POST', '/samples/shipments', {
      influencerId: inf.id,
      items: [{ productId: p.id, color: '白色', size: 'M', qty: 2 }],
    });
    expect(s.status).toBe(200);
    const before = await call('GET', `/influencers/${inf.id}/samples`);
    expect(before.body.pendingShipments[0].items[0]).toMatchObject({
      styleNo: 'S1',
      productName: '针织衫',
      qty: 2,
    });

    const batch = await call('POST', '/samples/shipments/ship', {
      ids: [s.body.row.id, 'missing-id'],
      shippedAt: '2026-10-01',
    });
    expect(batch.body.shipped).toEqual([s.body.row.id]);
    expect(batch.body.failed).toHaveLength(1);

    const detail = await call('GET', `/influencers/${inf.id}/samples`);
    expect(JSON.stringify(detail.body)).not.toMatch(/13900001111|某路 9 号|张三丰/);
    expect(detail.body.summary.outstanding).toBe(2);
    expect(
      (await call('GET', '/samples?filter=outstanding')).body.rows.map((r: any) => r.influencer.id),
    ).toEqual([inf.id]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await call('GET', '/samples?filter=settled')).body.rows).toHaveLength(0);
  });

  it('退回超量返回 400；质检照片上传后可挂到退样明细', async () => {
    const inf = (await newInfluencer('退样达人', 'smp002')).body.influencer;
    const s = await call('POST', '/samples/shipments', {
      influencerId: inf.id,
      items: [{ styleNo: 'S2', productName: 'x', color: '黑', size: 'L', qty: 1 }],
    });
    expect(s.status).toBe(200); // 没地址，但待寄样单可以先建
    expect(
      (
        await call('POST', '/samples/returns', {
          influencerId: inf.id,
          returnedAt: '2026-10-02',
          items: [{ styleNo: 'S2', color: '黑', size: 'L', qty: 1 }],
        })
      ).status,
    ).toBe(400);

    const form = new FormData();
    form.append('file', new File([new Uint8Array([1, 2])], 'qa.png', { type: 'image/png' }));
    const up = await (
      await app.request('/api/attachments/image', { method: 'POST', body: form })
    ).json();
    expect(up.id).toBeTruthy();
    const bad = new FormData();
    bad.append('file', new File(['x'], 'x.txt', { type: 'text/plain' }));
    expect(
      (await app.request('/api/attachments/image', { method: 'POST', body: bad })).status,
    ).toBe(400);
  });
});

describe('样品天数设置 API', () => {
  it('读取和修改应寄回天数；越界、非整数、未知键被拒绝', async () => {
    const s = await call('GET', '/settings');
    expect(s.body).toMatchObject({
      returnAfterLiveDays: 3,
      returnAfterSignDays: 7,
      shipOverdueDays: 3,
    });
    expect((await call('PUT', '/settings/returnAfterLiveDays', { value: 5 })).status).toBe(200);
    expect((await call('PUT', '/settings/returnAfterSignDays', { value: 0 })).status).toBe(200);
    expect((await call('GET', '/settings')).body).toMatchObject({
      returnAfterLiveDays: 5,
      returnAfterSignDays: 0,
    });
    expect((await call('PUT', '/settings/returnAfterLiveDays', { value: -1 })).status).toBe(400);
    expect((await call('PUT', '/settings/returnAfterLiveDays', { value: 2.5 })).status).toBe(400);
    expect((await call('PUT', '/settings/shipOverdueDays', { value: 0 })).status).toBe(400);
    expect((await call('PUT', '/settings/nope', { value: 1 })).status).toBe(404);
  });
});

describe('审核页与变更日志 API（阶段 5）', () => {
  const agent = (batchId?: string) => ({
    type: 'agent' as const,
    userId: '',
    batchId,
    source: 'AI 测试',
  });
  const asAgent = (batchId?: string) => ({ ...agent(batchId), userId: domain.userId });

  it('审核对比：显示改动前后，敏感字段打码，不泄露快照里的明文', async () => {
    const inf = (
      await call('POST', '/influencers', { influencer: { nickname: '甲', realName: '张三丰' } })
    ).body.influencer;
    domain
      .entity('influencer')
      .update(asAgent(), inf.id, { refCommissionPct: 25, realName: '李四光' });
    const res = await call('GET', '/review/pending');
    expect(res.body.rows).toHaveLength(1);
    const p = res.body.rows[0];
    expect(p).toMatchObject({
      entity: 'influencer',
      target: '甲',
      reason: '修改金额或佣金',
      stale: false,
      actorType: 'agent',
    });
    expect(p.diff.find((x: any) => x.field === 'refCommissionPct')).toMatchObject({
      before: null,
      after: 25,
    }); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(JSON.stringify(res.body)).not.toMatch(/张三丰|李四光/);
  });

  it('冲突检测：提出后记录被改过会标出，通过时拒绝，重新确认后可通过', async () => {
    const inf = (await call('POST', '/influencers', { influencer: { nickname: '乙' } })).body
      .influencer;
    domain.entity('influencer').update(asAgent(), inf.id, { refCommissionPct: 30 });
    await call('PATCH', `/e/influencer/${inf.id}`, { patch: { refCommissionPct: 10 } }); // 用户随后手动改了同一字段
    const p = (await call('GET', '/review/pending')).body.rows[0];
    expect(p.stale).toBe(true);
    expect(p.staleReason).toMatch(/已被修改/);
    expect(p.diff[0]).toMatchObject({
      field: 'refCommissionPct',
      before: null,
      after: 30,
      current: 10,
    });
    expect((await call('POST', `/review/${p.id}/approve`)).status).toBe(409);
    expect((await call('GET', `/influencers/${inf.id}`)).body.influencer.refCommissionPct).toBe(10);
    await call('POST', `/review/${p.id}/rebase`);
    expect((await call('POST', `/review/${p.id}/approve`)).status).toBe(200);
    expect((await call('GET', `/influencers/${inf.id}`)).body.influencer.refCommissionPct).toBe(30);
    expect((await call('GET', '/review/pending')).body.rows).toHaveLength(0);
  });

  it('整批通过和整批驳回', async () => {
    const a = (await call('POST', '/influencers', { influencer: { nickname: '批A' } })).body
      .influencer;
    const b = (await call('POST', '/influencers', { influencer: { nickname: '批B' } })).body
      .influencer;
    const batch = domain.newBatchId();
    domain.entity('influencer').delete(asAgent(batch), a.id);
    domain.entity('influencer').delete(asAgent(batch), b.id);
    const rows = (await call('GET', '/review/pending')).body.rows;
    expect(rows.map((r: any) => r.batchSize)).toEqual([2, 2]); // eslint-disable-line @typescript-eslint/no-explicit-any
    const rej = await call('POST', `/review/batch/${batch}/reject`);
    expect(rej.body.rejected).toHaveLength(2);
    expect((await call('GET', `/influencers/${a.id}`)).status).toBe(200);

    const batch2 = domain.newBatchId();
    domain.entity('influencer').delete(asAgent(batch2), a.id);
    domain.entity('influencer').delete(asAgent(batch2), b.id);
    const ok = await call('POST', `/review/batch/${batch2}/approve`);
    expect(ok.body.approved).toHaveLength(2);
    expect((await call('GET', `/influencers/${a.id}`)).status).toBe(404);
  });

  it('变更日志：前后对比、敏感字段打码、按批汇总、可筛选和翻页，撤销后显示为"撤销"', async () => {
    const ct = (
      await call('POST', '/e/contact', { name: '王', type: '经纪人', phone: '13812345678' })
    ).body.row;
    await call('PATCH', `/e/contact/${ct.id}`, { patch: { phone: '13999990000', org: '某MCN' } });
    const batch = domain.newBatchId();
    const imp = {
      type: 'import' as const,
      userId: domain.userId,
      batchId: batch,
      source: '导入测试.xlsx',
    };
    domain.entity('contact').create(imp, { name: '导入一', type: 'MCN' });
    domain.entity('contact').create(imp, { name: '导入二', type: 'MCN' });

    const all = await call('GET', '/changes');
    expect(JSON.stringify(all.body)).not.toMatch(/13812345678|13999990000/);
    const upd = all.body.rows.find((r: any) => r.action === 'update'); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(upd.target).toBe('王');
    expect(upd.changes.map((c: any) => c.field).sort()).toEqual(['org', 'phone']); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(upd.changes.find((c: any) => c.field === 'phone')).toMatchObject({
      before: '138****5678',
      after: '139****0000',
    }); // eslint-disable-line @typescript-eslint/no-explicit-any

    const imported = await call('GET', '/changes?actor=import');
    expect(imported.body.rows).toHaveLength(2);
    expect(imported.body.rows[0]).toMatchObject({
      batchId: batch,
      batchSize: 2,
      source: '导入测试.xlsx',
    });
    expect((await call('GET', '/changes?entity=influencer')).body.rows).toHaveLength(0);

    const page1 = await call('GET', '/changes?limit=2');
    expect(page1.body.rows).toHaveLength(2);
    const page2 = await call('GET', `/changes?limit=10&before=${page1.body.next}`);
    expect(page2.body.rows.every((r: any) => r.id < page1.body.next)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any

    const undo = await call('POST', `/batches/${batch}/undo`);
    expect(undo.body.undone).toHaveLength(2);
    const after = await call('GET', '/changes?limit=10');
    expect(after.body.rows.filter((r: any) => r.undoOf)).toHaveLength(2); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(after.body.rows.filter((r: any) => r.revertedAt)).toHaveLength(2); // eslint-disable-line @typescript-eslint/no-explicit-any
  });
});

describe('首页 API', () => {
  it('返回四个数字和三块列表；1 秒内返回', async () => {
    const inf = (await newInfluencer('首页达人', 'home001')).body;
    await call('POST', '/cooperations', {
      cooperation: {
        influencerId: inf.influencer.id,
        platformAccountId: inf.accounts[0].id,
        stage: '洽谈中',
        nextFollowDate: '2020-01-01',
      },
    });
    const t0 = Date.now();
    const res = await call('GET', '/home');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(res.status).toBe(200);
    expect(res.body.cards.dueFollow).toEqual({ count: 1, overdue: 1 });
    expect(res.body.dueFollows[0]).toMatchObject({
      name: '首页达人',
      stage: '洽谈中',
      kind: 'cooperation',
    });
    expect(Object.keys(res.body)).toEqual(
      expect.arrayContaining(['sampleAlerts', 'upcomingLives', 'highlights', 'today']),
    );
  });
});

describe('日志与审核里的关联字段显示名称', () => {
  it('合并后，日志里"达人"一栏是昵称而不是 ID，被合并（已删除）的达人也能显示', async () => {
    const keep = (await newInfluencer('保留者', 'ref001')).body.influencer;
    const gone = (await newInfluencer('被合并者', 'ref002')).body;
    const req = await call('POST', `/influencers/${keep.id}/merge`, {
      mergeId: gone.influencer.id,
    });
    await call('POST', `/review/${req.body.pendingId}/approve`);
    const logs = (await call('GET', '/changes?entity=platform_account&limit=20')).body.rows;
    const moved = logs.find((l: any) => l.changes.some((c: any) => c.field === 'influencerId')); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(moved.changes.find((c: any) => c.field === 'influencerId')).toMatchObject({
      before: '被合并者',
      after: '保留者',
    }); // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  it('合并申请：被合并方在提出后被改过，同样判为需要重新确认，重新确认后可通过', async () => {
    const a = (await newInfluencer('甲方', 'mg001')).body.influencer;
    const b = (await newInfluencer('乙方', 'mg002')).body.influencer;
    const req = await call('POST', `/influencers/${a.id}/merge`, { mergeId: b.id });
    await call('PATCH', `/e/influencer/${b.id}`, { patch: { rating: 'B' } });
    const p = (await call('GET', '/review/pending')).body.rows.find(
      (r: any) => r.id === req.body.pendingId,
    ); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(p.stale).toBe(true);
    await call('POST', `/review/${req.body.pendingId}/rebase`); // 还没点过通过也能直接重新确认
    expect(
      (await call('GET', '/review/pending')).body.rows.find((r: any) => r.id === req.body.pendingId)
        .stale,
    ).toBe(false); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await call('POST', `/review/${req.body.pendingId}/approve`)).status).toBe(200);
    expect((await call('GET', `/influencers/${b.id}`)).status).toBe(404);
  });
});
