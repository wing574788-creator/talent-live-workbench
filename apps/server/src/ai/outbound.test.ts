import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, runMigrations } from '../db/index.ts';
import { createDomain, type Domain } from '../domain/index.ts';
import { appliedOf } from '../domain/types.ts';
import {
  OutboundGuard,
  assertRegionAllowed,
  buildDict,
  defaultPolicy,
  loadPolicy,
  noRedactions,
  sanitizePayload,
  sanitizeText,
  savePolicy,
  type SensitiveDict,
} from './outbound.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-outbound-'));
const { db, sqlite } = openDb(dir);
runMigrations(db);
let d: Domain;

afterAll(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const t of [
    'change_log',
    'outbound_logs',
    'outbound_policies',
    'field_defs',
    'sample_shipments',
    'influencer_addresses',
    'influencer_contacts',
    'contacts',
    'platform_accounts',
    'influencers',
  ])
    sqlite.exec(`delete from ${t}`);
  d = createDomain(db);
});

const EMPTY: SensitiveDict = { phone: [], wechat: [], address: [], name: [] };

describe('固定规则：手机号、微信号、地址、真实姓名', () => {
  it.each([
    ['13812345678', '手机号'],
    ['138 1234 5678', '手机号'],
    ['138-1234-5678', '手机号'],
    ['+86 138 1234 5678', '手机号'],
    ['手机 19912345678 谢谢', '手机号'],
  ])('手机号 %s 被替换', (raw, kind) => {
    const out = sanitizeText(`联系我 ${raw}`, EMPTY);
    expect(out).toContain(`[${kind}1]`);
    expect(out).not.toMatch(/\d{4}/);
  });

  it('微信号：带"微信/wx/vx"标签的 ID 被替换，标签保留', () => {
    expect(sanitizeText('微信：abc_123456 加我', EMPTY)).toBe('微信：[微信号1] 加我');
    expect(sanitizeText('wx abcdef12', EMPTY)).toBe('wx [微信号1]');
    expect(sanitizeText('VX:Sunny-2020', EMPTY)).toBe('VX:[微信号1]');
  });

  it('地址：省市区路号', () => {
    for (const a of [
      '上海市徐汇区某路 9 号',
      '广东省深圳市南山区科技园路1号',
      '北京市朝阳区建国路88号3栋201室',
      '浙江省杭州市西湖区文三路 398 号东部软件园',
    ]) {
      const out = sanitizeText(`寄到${a}，谢谢`, EMPTY);
      expect(out, a).toContain('[地址1]');
      expect(out, a).not.toMatch(/路|号/);
    }
  });

  it('带标签的姓名：收件人、真实姓名', () => {
    expect(sanitizeText('收件人：张三丰 手机 13812345678', EMPTY)).toBe(
      '收件人：[姓名1] 手机 [手机号1]',
    );
    expect(sanitizeText('真实姓名: 李四光', EMPTY)).toBe('真实姓名: [姓名1]');
  });

  it('身份证号、邮箱也一并处理', () => {
    expect(sanitizeText('身份证 110101199003071234', EMPTY)).toContain('[证件号1]');
    expect(sanitizeText('邮箱 someone@example.com', EMPTY)).toContain('[邮箱1]');
  });

  it('同一个值总是同一个占位符，不同的值编号不同', () => {
    const out = sanitizeText('13812345678 / 13900001111 / 13812345678', EMPTY);
    expect(out).toBe('[手机号1] / [手机号2] / [手机号1]');
  });

  it('不误伤：款号、数量、佣金、日期、金额、短数字', () => {
    const t =
      '示例达人 A001 羊毛大衣 黑色 M ×2，佣金 25 个点，10月21日 周三 晚上播，报价 ¥1,500，订单 12345678，粉丝 12.3w，2026-10-18';
    expect(sanitizeText(t, EMPTY)).toBe(t);
  });

  it('已经打码的值不会被当作新的手机号', () => {
    expect(sanitizeText('138****5678', EMPTY)).toBe('138****5678');
  });
});

describe('库里已知的敏感值：精确替换（比规则更严）', () => {
  it('真实姓名、联系人手机/微信、收货地址、收件人都从数据库收集', () => {
    const u = d.userActor();
    const inf = d.influencers.createWithAccounts(u, {
      influencer: { nickname: '小美', realName: '张三丰' },
      accounts: [],
    }).influencer;
    d.entity('influencer_address').create(u, {
      influencerId: inf.id,
      recipient: '李雷',
      phone: '010-8888',
      address: '虚构市示例区样品路 2 号',
      isDefault: true,
    });
    d.entity('contact').create(u, {
      name: '经纪人王',
      type: '经纪人',
      wechat: 'wang_wx_001',
      phone: '13800000001',
    });
    const dict = buildDict(d);
    expect(dict.name).toEqual(expect.arrayContaining(['张三丰', '李雷']));
    expect(dict.phone).toEqual(expect.arrayContaining(['13800000001', '010-8888']));
    expect(dict.wechat).toEqual(['wang_wx_001']);
    expect(dict.address).toEqual(['虚构市示例区样品路 2 号']);

    const text =
      '小美本名张三丰，收件人李雷，微信是 wang_wx_001，电话 010-8888，寄到虚构市示例区样品路 2 号';
    const out = sanitizeText(text, dict);
    for (const secret of ['张三丰', '李雷', 'wang_wx_001', '010-8888', '样品路'])
      expect(out).not.toContain(secret);
    expect(out).toContain('小美'); // 昵称不是敏感信息
  });

  it('标为敏感的自定义字段，它的值也会被替换', () => {
    const u = d.userActor();
    d.entity('field_def').create(u, {
      entity: 'influencer',
      key: 'secret_note',
      label: '内部备注',
      type: 'text',
      sensitive: true,
    });
    d.entity('influencer').create(u, { nickname: '阿花', custom: { secret_note: '内部暗号狐狸' } });
    expect(sanitizeText('他的内部暗号狐狸很重要', buildDict(d))).not.toContain('暗号');
  });

  it('太短的值不进词典，避免把正常文字替换光', () => {
    d.entity('influencer').create(d.userActor(), { nickname: 'x', realName: '王' });
    expect(buildDict(d).name).toEqual([]);
  });
});

describe('载荷：递归脱敏所有字符串，图片一律拒绝', () => {
  it('嵌套的 messages、工具调用参数、系统提示都会处理', () => {
    const hits = noRedactions();
    const payload = {
      model: 'm',
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: [{ type: 'text', text: '电话 13812345678' }] },
        {
          role: 'assistant',
          tool_calls: [{ function: { name: 'x', arguments: '{"q":"微信：abc_123456"}' } }],
        },
      ],
    };
    const out = sanitizePayload(payload, EMPTY, hits);
    expect(JSON.stringify(out)).not.toMatch(/13812345678|abc_123456/);
    expect(hits.phone).toBe(1);
    expect(hits.wechat).toBe(1);
    expect(payload.messages[1]!.content).toEqual([{ type: 'text', text: '电话 13812345678' }]); // 原对象不被修改
  });

  it('图片内容块和 data:image 地址被拒绝', () => {
    expect(() =>
      sanitizePayload(
        { messages: [{ content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] }] },
        EMPTY,
      ),
    ).toThrow(/不允许把图片发给模型/);
    expect(() =>
      sanitizePayload({ messages: [{ content: [{ type: 'image', data: 'abc' }] }] }, EMPTY),
    ).toThrow(/不允许把图片/);
    expect(() => sanitizePayload({ x: 'data:image/png;base64,AAAA' }, EMPTY)).toThrow(
      /不允许把图片/,
    );
  });
});

describe('按配置收紧', () => {
  const seed = () => {
    const u = d.userActor();
    d.entity('field_def').create(u, {
      entity: 'influencer',
      key: 'level',
      label: '合作等级',
      type: 'text',
      allowOutbound: true,
    });
    d.entity('field_def').create(u, {
      entity: 'influencer',
      key: 'internal',
      label: '内部标记',
      type: 'text',
    });
    d.entity('field_def').create(u, {
      entity: 'influencer',
      key: 'idno',
      label: '证件备注',
      type: 'text',
      sensitive: true,
      allowOutbound: true,
    });
    return appliedOf(
      d.entity('influencer').create(u, {
        nickname: '小美',
        realName: '张三丰',
        rating: 'A',
        refCommissionPct: 20,
        blacklistReason: '联系 13812345678 不回复',
        custom: { level: '金牌', internal: '不要外传', idno: '某号' },
      }),
    ).row;
  };

  it('默认：目录里的字段给模型，真实姓名这类固定脱敏字段根本不在其中；自由文本里的手机号被替换', () => {
    const inf = seed();
    const p = new OutboundGuard(d).project('influencer', inf);
    expect(p).toMatchObject({ nickname: '小美', rating: 'A', refCommissionPct: 20 });
    expect(p).not.toHaveProperty('realName');
    expect(p.blacklistReason).toBe('联系 [手机号1] 不回复');
  });

  it('自定义字段：允许外发的才给；敏感的永远不给；没标允许的默认不给', () => {
    const inf = seed();
    const p = new OutboundGuard(d).project('influencer', inf);
    expect(p['自定义:合作等级']).toBe('金牌');
    expect(JSON.stringify(p)).not.toMatch(/内部标记|证件备注|不要外传|某号/);
  });

  it('按字段设置：禁止 / 隐藏', () => {
    const inf = seed();
    const policy = {
      ...defaultPolicy(),
      fields: {
        'influencer.rating': 'deny' as const,
        'influencer.refCommissionPct': 'mask' as const,
        'influencer.custom.internal': 'allow' as const,
      },
    };
    const p = new OutboundGuard(d, policy).project('influencer', inf);
    expect(p).not.toHaveProperty('rating');
    expect(p.refCommissionPct).toBe('[已隐藏]');
    expect(p['自定义:内部标记']).toBe('不要外传'); // 用户明确允许了一个默认不外发的自定义字段
  });

  it('按模块禁止：assertModule 抛出，提示给用户看的原因', () => {
    const g = new OutboundGuard(d, { ...defaultPolicy(), modules: { contact: 'deny' } });
    expect(() => g.assertModule('contact')).toThrow(/「联系人」的数据不允许发给模型/);
    expect(() => g.assertModule('influencer')).not.toThrow();
  });

  it('配置存取：保存后能读回；没配置时是默认', () => {
    expect(loadPolicy(d)).toEqual(defaultPolicy());
    savePolicy(d, { ...defaultPolicy(), region: 'domestic', modules: { shipment: 'deny' } });
    savePolicy(d, {
      ...defaultPolicy(),
      region: 'domestic',
      modules: { shipment: 'deny', product: 'deny' },
    });
    expect(loadPolicy(d)).toMatchObject({
      region: 'domestic',
      modules: { shipment: 'deny', product: 'deny' },
    });
    expect(d.entity('outbound_policy').list()).toHaveLength(1);
  });

  it('区域限制：关闭外发 / 仅境内 / 仅本地', () => {
    const p = defaultPolicy();
    expect(() => assertRegionAllowed(p, 'foreign', 'Claude')).not.toThrow();
    expect(() =>
      assertRegionAllowed({ ...p, allowOutbound: false }, 'domestic', 'DeepSeek'),
    ).toThrow(/关闭了"允许外发"/);
    expect(() =>
      assertRegionAllowed({ ...p, allowOutbound: false }, 'local', 'Ollama'),
    ).not.toThrow();
    expect(() => assertRegionAllowed({ ...p, region: 'domestic' }, 'foreign', 'Claude')).toThrow(
      /仅允许境内模型/,
    );
    expect(() =>
      assertRegionAllowed({ ...p, region: 'domestic' }, 'domestic', 'DeepSeek'),
    ).not.toThrow();
    expect(() => assertRegionAllowed({ ...p, region: 'local' }, 'domestic', 'DeepSeek')).toThrow(
      /仅允许本地模型/,
    );
    expect(() => assertRegionAllowed({ ...p, region: 'local' }, 'local', 'Ollama')).not.toThrow();
  });
});

describe('外发日志', () => {
  it('记录模型、用途和实际发出的（脱敏后的）内容；日志里没有未脱敏的手机号、微信号、地址', () => {
    const u = d.userActor();
    d.entity('contact').create(u, {
      name: '经纪人王',
      type: '经纪人',
      wechat: 'wang_wx_001',
      phone: '13800000001',
    });
    const g = new OutboundGuard(d);
    const clean = sanitizePayload(
      {
        messages: [
          {
            role: 'user',
            content: '王的电话 13800000001 微信 wang_wx_001，寄到上海市徐汇区某路 9 号',
          },
        ],
      },
      g.dict,
      g.hits,
    );
    g.log('deepseek/deepseek-flash', 'extract', clean);
    const rows = d.entity('outbound_log').list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: 'deepseek/deepseek-flash', module: 'extract' });
    expect(String(rows[0]!.payload)).not.toMatch(/13800000001|wang_wx_001|某路/);
    expect(String(rows[0]!.payload)).toContain('[手机号1]');
  });
});
