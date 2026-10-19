/** 敏感字段列表默认打码（PRD 8.1）：点击后才请求明文。 */
export const SENSITIVE_FIELDS = {
  influencer: ['realName'],
  contact: ['wechat', 'phone'],
  influencer_address: ['recipient', 'phone', 'address'],
  sample_shipment: ['recipient', 'phone', 'address'],
} as const;

export function maskText(value: unknown, kind: 'name' | 'phone' | 'wechat' | 'address'): string {
  if (value == null || value === '') return '';
  const s = String(value);
  switch (kind) {
    case 'phone':
      return s.length >= 7 ? `${s.slice(0, 3)}****${s.slice(-4)}` : '****';
    case 'name':
      return `${s.slice(0, 1)}${'*'.repeat(Math.max(1, Math.min(s.length - 1, 3)))}`;
    case 'wechat':
      return `${s.slice(0, 1)}****`;
    case 'address':
      return `${s.slice(0, 6)}****`;
  }
}

const KIND: Record<string, 'name' | 'phone' | 'wechat' | 'address'> = {
  realName: 'name',
  recipient: 'name',
  phone: 'phone',
  wechat: 'wechat',
  address: 'address',
};

export function maskRow<T extends Record<string, unknown>>(row: T, fields: readonly string[]): T {
  const out: Record<string, unknown> = { ...row };
  for (const f of fields) if (f in out) out[f] = maskText(out[f], KIND[f] ?? 'name');
  return out as T;
}
