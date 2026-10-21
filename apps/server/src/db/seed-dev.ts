/** 向正在运行的开发服务写入虚构示例数据（走 REST，和页面操作一致）：pnpm --filter @workbench/server tsx src/db/seed-dev.ts */
const B = process.env.API ?? 'http://127.0.0.1:8787/api';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function post(url: string, body: unknown): Promise<any> {
  const res = await fetch(B + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) console.log(res.status, url, data.error);
  return data;
}

await post('/e/field_def', {
  entity: 'product',
  key: 'season',
  label: '季节',
  type: 'select',
  options: ['春', '夏', '秋', '冬'],
});
const p1 = (
  await post('/products', {
    product: {
      styleNo: 'A001',
      name: '羊毛大衣',
      livePriceCents: 129900,
      finalPriceCents: 119900,
      custom: { season: '冬' },
    },
    variants: [
      { color: '黑色', size: 'S' },
      { color: '黑色', size: 'M' },
      { color: '驼色', size: 'M' },
    ],
  })
).row;
const p2 = (
  await post('/products', {
    product: {
      styleNo: 'B002',
      name: '碎花连衣裙',
      livePriceCents: 29900,
      custom: { season: '夏' },
    },
  })
).row;

const mk = (nickname: string, platform: string, accountId: string, extra: object = {}) =>
  post('/influencers', { influencer: { nickname, ...extra }, accounts: [{ platform, accountId }] });
const xm = await mk('示例达人小美', '小红书', 'demo_xm_001', {
  realName: '测试甲',
  categoryTags: ['女装'],
  rating: 'A',
});
const xm2 = await mk('小美的小号', '小红书', 'demo_xm_002');
const ah = await mk('示例达人阿花', '抖音', 'demo_dy_001');
await post('/e/contact', {
  name: '经纪人示例王',
  type: '经纪人',
  org: '示例MCN',
  wechat: 'demo_wx_888',
  phone: '13800000000',
});

type Inf = { influencer: { id: string }; accounts: { id: string }[] };
const coop = async (inf: Inf, extra: object, products: object[] = []) =>
  (
    await post('/cooperations', {
      cooperation: {
        influencerId: inf.influencer.id,
        platformAccountId: inf.accounts[0]!.id,
        ...extra,
      },
      products,
    })
  ).row;

const c1 = await coop(
  xm,
  { stage: '洽谈中', followStatus: '报价中', nextFollowDate: '2026-10-17' },
  [
    { productId: p1.id, commissionPct: 20 },
    { productId: p2.id, commissionPct: 25 },
  ],
);
const c2 = await coop(
  ah,
  { stage: '洽谈中', followStatus: '待回复', nextFollowDate: '2026-10-30' },
  [{ productId: p2.id }],
);
await coop(xm2, { stage: '已确认', liveDate: '2026-10-25' }, [
  { productId: p1.id, commissionPct: 18 },
]);
await coop(ah, { stage: '待建联' });

const day = 86400_000;
for (const [i, status] of ['已发邀约', '待回复', '待回复', '待回复'].entries()) {
  await post('/e/follow_up', {
    cooperationId: c2.id,
    occurredAt: new Date(Date.now() - (5 - i) * day).toISOString(),
    method: '微信',
    summary: `第 ${i + 1} 次跟进`,
    followStatus: status,
  });
}
await post('/e/follow_up', {
  cooperationId: c1.id,
  occurredAt: new Date(Date.now() - 4 * day).toISOString(),
  method: '微信',
  summary: '对方想把佣金谈到 25%',
  followStatus: '报价中',
  intent: '高',
  // 洽谈中记跟进要带下次跟进日期；沿用合作上已逾期的日期，首页才有"逾期"示例
  nextFollowDate: '2026-10-17',
});
// ── 样品台账示例 ──
const infId = xm.influencer.id;
await post('/e/influencer_address', {
  influencerId: infId,
  recipient: '测试甲',
  phone: '13800001111',
  address: '虚构市虚构区示例路 1 号',
  isDefault: true,
});
await post('/e/influencer_address', {
  influencerId: ah.influencer.id,
  recipient: '测试乙',
  address: '虚构市示例区样品路 2 号',
  isDefault: true,
});
const ship1 = (
  await post('/samples/shipments', {
    influencerId: infId,
    cooperationId: c1.id,
    items: [
      { productId: p1.id, color: '黑色', size: 'M', qty: 2 },
      { productId: p1.id, color: '驼色', size: 'M', qty: 1 },
    ],
  })
).row;
await post(`/samples/shipments/${ship1.id}/ship`, {
  shippedAt: '2026-10-01',
  carrier: '示例快递',
  trackingNo: 'DEMO0001',
});
const ship2 = (
  await post('/samples/shipments', {
    influencerId: infId,
    items: [{ productId: p1.id, color: '黑色', size: 'S', qty: 1 }],
  })
).row;
await post(`/samples/shipments/${ship2.id}/ship`, { shippedAt: '2026-10-06' });
await post('/samples/returns', {
  influencerId: infId,
  returnedAt: '2026-10-12',
  items: [{ styleNo: 'A001', color: '黑色', size: 'M', qty: 1, qaResult: '污渍' }],
});
await post('/samples/shipments', {
  influencerId: ah.influencer.id,
  items: [{ productId: p2.id, color: '白色', size: 'S', qty: 2 }],
});
// ── 首页与审核示例 ──
const dayStr = (offset: number) =>
  new Date(Date.now() + 8 * 3600_000 + offset * 86400_000).toISOString().slice(0, 10);
await post('/e/contact', {
  name: '私人商务示例李',
  type: '私人商务',
  org: '示例工作室',
  nextFollowDate: dayStr(-3),
});
await post('/cooperations', {
  cooperation: {
    influencerId: xm2.influencer.id,
    platformAccountId: xm2.accounts[0]!.id,
    stage: '已排期',
    liveDate: dayStr(2),
  },
  products: [{ productId: p2.id }],
});
// 合并达人一律走审核队列：这里提交一条合并申请，审核页就有数据可看
await post(`/influencers/${infId}/merge`, { mergeId: xm2.influencer.id });
console.log('示例数据已写入');
export {};
