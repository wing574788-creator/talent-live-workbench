/**
 * 外发网关：AI 会话每次向模型提供方发请求之前，都经过这里。
 * 顺序固定：外发配置检查（区域 / 是否允许外发）→ 固定脱敏 → 写外发日志 → 才允许发出。
 * 任何一步失败都不放行（适配层会换成无意义载荷让请求失败）。
 */
import type { Domain } from '../domain/index.ts';
import type { Purpose, ProviderSetting } from './config.ts';
import { OutboundGuard, assertRegionAllowed, loadPolicy, sanitizePayload } from './outbound.ts';

export interface GatewayTarget {
  provider: ProviderSetting;
  modelId: string;
  purpose: Purpose;
}

/** 提供方区域与外发配置是否允许；会话创建时先检查一次，给用户明确的提示 */
export function assertTargetAllowed(d: Domain, t: GatewayTarget) {
  assertRegionAllowed(loadPolicy(d), t.provider.region, t.provider.label);
}

export function createOutboundFilter(d: Domain, t: GatewayTarget) {
  return (payload: unknown) => {
    // 每次请求都重新读取配置和敏感值词典：中途改了外发设置、新增了联系人，下一次请求立刻生效
    const guard = new OutboundGuard(d, loadPolicy(d));
    assertRegionAllowed(guard.policy, t.provider.region, t.provider.label);
    const clean = sanitizePayload(payload, guard.dict, guard.hits);
    guard.log(`${t.provider.id}/${t.modelId}`, t.purpose, clean);
    return clean;
  };
}
