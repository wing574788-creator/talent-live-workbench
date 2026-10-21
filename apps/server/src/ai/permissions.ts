/**
 * AI 助手权限：用户在「AI 助手 → 权限」里自定义，只能在安全底线之上收紧——
 * 外发脱敏不可关闭（outbound.ts），AI 的修改一律进审核（EntityService.propose）。
 * 这里决定：哪些写入/提议工具提供给模型，哪些 AI 功能可用。服务端强制执行，不只是前端隐藏。
 */
import {
  AI_FEATURES,
  aiPermissionsSchema,
  type AiFeatureKey,
  type AiPermissions,
} from '@workbench/shared';
import type { Domain } from '../domain/index.ts';
import { DomainError } from '../domain/errors.ts';

const KEY = 'permissions';

export const defaultPermissions = (): AiPermissions => ({ tools: {}, features: {} });

export function loadPermissions(d: Domain): AiPermissions {
  const row = d.entity('outbound_policy').findBy('key', KEY)[0];
  const parsed = aiPermissionsSchema.safeParse(row?.value ?? {});
  return parsed.success ? parsed.data : defaultPermissions();
}

export function savePermissions(d: Domain, input: unknown): AiPermissions {
  const parsed = aiPermissionsSchema.safeParse(input);
  if (!parsed.success) throw new DomainError('validation', 'AI 权限格式不对');
  const svc = d.entity('outbound_policy');
  const row = svc.findBy('key', KEY)[0];
  const value = parsed.data as unknown as Record<string, unknown>;
  if (row) svc.update(d.userActor(), row.id, { value });
  else svc.create(d.userActor(), { scope: 'global', key: KEY, value });
  return loadPermissions(d);
}

/** 工具是否开放给模型（只有写入、提议类工具受控；没写 = 允许） */
export const toolAllowed = (p: AiPermissions, name: string) =>
  (p.tools as Record<string, boolean | undefined>)[name] !== false;

export const featureEnabled = (p: AiPermissions, key: AiFeatureKey) => p.features[key] !== false;

/** 功能被关闭时直接拒绝（HTTP 403） */
export function assertFeature(d: Domain, key: AiFeatureKey) {
  if (!featureEnabled(loadPermissions(d), key))
    throw new DomainError(
      'ai_disabled',
      `「${AI_FEATURES[key]}」已在「AI 助手 → 权限」里关闭，需要时可以在那里重新打开。`,
    );
}
