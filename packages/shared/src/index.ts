export * from './enums.ts';
export * from './schemas.ts';
export * from './mask.ts';

import { z } from 'zod';

/** 左侧导航，按分组显示（日常 / 资料库 / 工具），分组只是小标题，不折叠 */
export const NAV_GROUPS = ['日常', '资料库', '工具'] as const;
export const NAV_ITEMS = [
  { key: 'home', label: '首页', path: '/', group: '日常' },
  { key: 'cooperations', label: '合作', path: '/cooperations', group: '日常' },
  { key: 'samples', label: '寄样', path: '/samples', group: '日常' },
  { key: 'review', label: '审核', path: '/review', group: '日常' },
  { key: 'influencers', label: '达人', path: '/influencers', group: '资料库' },
  { key: 'contacts', label: '联系人', path: '/contacts', group: '资料库' },
  { key: 'products', label: '商品', path: '/products', group: '资料库' },
  { key: 'import', label: '导入', path: '/import', group: '工具' },
  { key: 'ai', label: 'AI 助手', path: '/ai', group: '工具' },
  { key: 'settings', label: '设置', path: '/settings', group: '工具' },
] as const;

export const healthSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  time: z.string(),
  db: z.object({ journalMode: z.string(), migrations: z.number() }),
});
export type Health = z.infer<typeof healthSchema>;

/** SSE 事件（Agent 流式对话，阶段 0 spike 与阶段 7 共用） */
export const agentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), delta: z.string() }),
  z.object({ type: z.literal('tool_start'), name: z.string(), args: z.unknown() }),
  z.object({
    type: z.literal('tool_end'),
    name: z.string(),
    result: z.unknown(),
    isError: z.boolean(),
  }),
  z.object({ type: z.literal('done') }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type AgentEvent = z.infer<typeof agentEventSchema>;
