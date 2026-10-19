import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createWorkbenchSession } from '../agent/adapter.ts';
import { createFauxModel, fauxAssistantMessage, fauxText } from '../agent/faux.ts';
import { openDb, runMigrations } from '../db/index.ts';
import { createDomain, type Domain } from '../domain/index.ts';
import type { ProviderSetting } from './config.ts';
import { assertTargetAllowed, createOutboundFilter } from './gateway.ts';
import { defaultPolicy, savePolicy } from './outbound.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-gw-'));
const { db, sqlite } = openDb(dir);
runMigrations(db);
let d: Domain;
afterAll(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  sqlite.exec(
    'delete from outbound_logs; delete from outbound_policies; delete from contacts; delete from change_log',
  );
  d = createDomain(db);
});

const provider = (region: ProviderSetting['region']): ProviderSetting => ({
  id: 'deepseek',
  kind: 'deepseek',
  label: 'DeepSeek',
  region,
});
const target = (region: ProviderSetting['region'] = 'domestic') => ({
  provider: provider(region),
  modelId: 'deepseek-flash',
  purpose: 'chat' as const,
});

async function session(filter: (p: unknown) => unknown, onBlocked?: (e: Error) => void) {
  const { faux, model, modelRuntime, agentDir, sent } = await createFauxModel({
    simulatePayload: true,
  });
  const s = await createWorkbenchSession({
    cwd: os.tmpdir(),
    agentDir,
    modelRuntime,
    model,
    tools: [],
    systemPrompt: '你是助手',
    outboundFilter: filter,
    onBlocked,
  });
  return { faux, s, sent };
}
const text = (x: unknown) => JSON.stringify(x);

describe('外发网关', () => {
  it('发出去的请求里手机号、微信号、地址已脱敏，且只有脱敏后的内容进入外发日志', async () => {
    d.entity('contact').create(d.userActor(), {
      name: '李经纪',
      type: '经纪人',
      wechat: 'abc_secret88',
      phone: '13800001111',
    });
    const { faux, s, sent } = await session(createOutboundFilter(d, target()));
    faux.setResponses([fauxAssistantMessage(fauxText('好的'))]);
    await s.prompt(
      '联系 13800001111，微信 abc_secret88，收货地址：浙江省杭州市余杭区文一西路 969 号 3 幢 502 室',
      () => {},
    );
    const out = text(sent);
    for (const secret of ['13800001111', 'abc_secret88', '文一西路', '502'])
      expect(out).not.toContain(secret);
    expect(out).toContain('[手机号1]');
    const logs = d.entity('outbound_log').list();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.model).toBe('deepseek/deepseek-flash');
    expect(logs[0]!.module).toBe('chat');
    for (const secret of ['13800001111', 'abc_secret88', '文一西路'])
      expect(String(logs[0]!.payload)).not.toContain(secret);
    expect(String(logs[0]!.payload)).toBe(text(sent[0])); // 日志里就是实际发出去的内容
    s.dispose();
  });

  it('过滤器抛错时不放行原文：请求被换成无意义载荷，并通知调用方', async () => {
    let blocked: Error | undefined;
    const { faux, s, sent } = await session(
      () => {
        throw new Error('词典读取失败');
      },
      (e) => (blocked = e),
    );
    faux.setResponses([fauxAssistantMessage(fauxText('不该走到这里'))]);
    await s.prompt('我的手机号 13800001111', () => {});
    expect(blocked?.message).toContain('词典读取失败');
    expect(text(sent)).not.toContain('13800001111');
    expect(text(sent)).toContain('blocked');
    s.dispose();
  });

  it('外发配置关闭外发 / 限定区域时，云端模型被拒绝，本机模型放行', async () => {
    savePolicy(d, { ...defaultPolicy(), allowOutbound: false });
    expect(() => assertTargetAllowed(d, target('domestic'))).toThrow(/不能使用/);
    expect(() => assertTargetAllowed(d, target('local'))).not.toThrow();
    savePolicy(d, { ...defaultPolicy(), region: 'domestic' });
    expect(() => assertTargetAllowed(d, target('foreign'))).toThrow(/仅允许境内/);
    expect(() => assertTargetAllowed(d, target('domestic'))).not.toThrow();
    // 请求时也会再检查一次
    expect(() => createOutboundFilter(d, target('foreign'))({ a: 1 })).toThrow(/仅允许境内/);
    expect(d.entity('outbound_log').list()).toHaveLength(0);
  });

  it('图片不会外发', () => {
    const filter = createOutboundFilter(d, target());
    expect(() =>
      filter({ messages: [{ role: 'user', content: [{ type: 'image', data: 'xxx' }] }] }),
    ).toThrow(/不允许把图片发给模型/);
    expect(d.entity('outbound_log').list()).toHaveLength(0);
  });
});
