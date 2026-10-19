import { nicknameSimilarity } from '../domain/influencer-service.ts';
import type { Domain } from '../domain/index.ts';
import type { Row } from '../domain/types.ts';
import type { Suspect } from './types.ts';

const lower = (s: unknown) =>
  String(s ?? '')
    .trim()
    .toLowerCase();
export const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');
const SIMILAR = 0.7;

/**
 * 导入时对照数据库查重用的内存索引。每张表开始时从数据库建一次；
 * 提交阶段每写入一条就登记进来，所以同一个文件里后面的行能看到前面刚建的记录。
 */
export class Indexes {
  private inf = new Map<string, Row>();
  private acc = new Map<string, string>();
  private accByInf = new Map<string, Row[]>();
  private nick = new Map<string, string[]>();
  private products = new Map<string, Row>();
  private contacts = new Map<string, Row>();
  private coops = new Map<string, Row>();
  private shipments = new Map<string, Row>();

  constructor(private readonly d: Domain) {
    for (const r of d.entity('influencer').list()) this.addInfluencer(r);
    for (const a of d.entity('platform_account').list()) this.addAccount(a);
    for (const p of d.entity('product').list()) this.addProduct(p);
    for (const c of d.entity('contact').list()) this.addContact(c);
    for (const c of d.entity('cooperation').list()) this.addCoop(c);
    for (const s of d.entity('sample_shipment').list()) this.addShipment(s);
  }

  // ───────────── 达人 ─────────────
  addInfluencer(r: Row) {
    this.inf.set(r.id, r);
    const k = lower(r.nickname);
    this.nick.set(k, [...(this.nick.get(k) ?? []), r.id]);
  }
  addAccount(a: Row) {
    this.acc.set(`${a.platform}|${lower(a.accountId)}`, a.influencerId as string);
    this.accByInf.set(a.influencerId as string, [
      ...(this.accByInf.get(a.influencerId as string) ?? []),
      a,
    ]);
  }
  influencer(id: string) {
    return this.inf.get(id);
  }
  accountOwner(platform: string, accountId: string) {
    return this.acc.get(`${platform}|${lower(accountId)}`);
  }
  accountsOf(infId: string) {
    return this.accByInf.get(infId) ?? [];
  }
  influencersByNickname(nick: string) {
    return this.nick.get(lower(nick)) ?? [];
  }

  /**
   * 引用一个已有达人：先当账号 ID 找（给了平台就限定平台），再当昵称找。
   * 同一个昵称对应多个达人时判为有歧义，不乱选。
   */
  resolveInfluencer(ref: string, platform?: string): { id?: string; error?: string } {
    const r = ref.trim();
    if (!r) return { error: '没有填写达人' };
    const hits = new Set<string>();
    for (const [key, id] of this.acc) {
      const [p, aid] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
      if (aid === lower(r) && (!platform || p === platform)) hits.add(id);
    }
    if (hits.size === 1) return { id: [...hits][0] };
    if (hits.size > 1) return { error: `账号 ID「${r}」对应多个达人，请同时填写平台` };
    const byNick = this.influencersByNickname(r);
    if (byNick.length === 1) return { id: byNick[0] };
    if (byNick.length > 1)
      return { error: `昵称「${r}」对应 ${byNick.length} 个达人，请改用账号 ID` };
    return { error: `找不到达人「${r}」（请先导入达人）` };
  }

  /** 昵称相同或相似的已有达人（只提示，不自动合并） */
  similarInfluencers(nickname: string): Suspect[] {
    const out: Suspect[] = [];
    for (const r of this.inf.values()) {
      const score = nicknameSimilarity(nickname, String(r.nickname));
      if (score >= SIMILAR)
        out.push({ id: r.id, label: String(r.nickname), score: Math.round(score * 100) / 100 });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 3);
  }

  // ───────────── 商品 ─────────────
  addProduct(p: Row) {
    this.products.set(lower(p.styleNo), p);
  }
  productByStyle(styleNo: string) {
    return this.products.get(lower(styleNo));
  }

  // ───────────── 联系人 ─────────────
  private static contactKeys(c: Record<string, unknown>) {
    const keys: string[] = [];
    if (digits(c.phone)) keys.push(`p|${digits(c.phone)}`);
    if (lower(c.wechat)) keys.push(`w|${lower(c.wechat)}`);
    // 手机和微信都没有时，用 姓名+机构+类型
    keys.push(`n|${lower(c.name)}|${lower(c.org)}|${lower(c.type)}`);
    return keys;
  }
  addContact(c: Row) {
    for (const k of Indexes.contactKeys(c)) if (!this.contacts.has(k)) this.contacts.set(k, c);
  }
  /** 手机 → 微信 → 姓名+机构+类型，依次精确匹配 */
  findContact(c: Record<string, unknown>): Row | undefined {
    const keys = Indexes.contactKeys(c);
    for (const k of keys)
      if (!k.startsWith('n|') || (!digits(c.phone) && !lower(c.wechat))) {
        const hit = this.contacts.get(k);
        if (hit) return hit;
      }
    return undefined;
  }
  contactsByName(name: string): Row[] {
    const out = new Map<string, Row>();
    for (const c of this.contacts.values()) if (lower(c.name) === lower(name)) out.set(c.id, c);
    return [...out.values()];
  }

  // ───────────── 合作 ─────────────
  static coopKey(infId: string, accountId: string, liveDate: unknown) {
    return `${infId}|${accountId}|${liveDate ?? ''}`;
  }
  addCoop(c: Row) {
    const k = Indexes.coopKey(c.influencerId as string, c.platformAccountId as string, c.liveDate);
    if (!this.coops.has(k)) this.coops.set(k, c);
  }
  coopByKey(infId: string, accountId: string, liveDate: unknown) {
    return this.coops.get(Indexes.coopKey(infId, accountId, liveDate));
  }

  // ───────────── 寄样 ─────────────
  addShipment(s: Row) {
    if (s.trackingNo) this.shipments.set(`${s.influencerId}|${lower(s.trackingNo)}`, s);
  }
  shipmentByTracking(infId: string, tracking: string) {
    return this.shipments.get(`${infId}|${lower(tracking)}`);
  }
}
