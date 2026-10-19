import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/index.ts';
import { changeLog } from '../db/schema.ts';
import type { ServiceRegistry } from './entity-service.ts';
import type { Row } from './types.ts';

/** 详情抽屉用的聚合读取。只读，不写入。 */
export class ReadModels {
  constructor(
    private readonly db: Db,
    private readonly registry: ServiceRegistry,
  ) {}

  private svc(name: string) {
    return this.registry.get(name);
  }

  history(entity: string, id: string, limit = 50) {
    return this.db
      .select()
      .from(changeLog)
      .where(eq(changeLog.entityId, id))
      .orderBy(desc(changeLog.id))
      .limit(limit)
      .all()
      .filter((l) => l.entity === entity);
  }

  productDetail(id: string) {
    const product = this.svc('product').require(id);
    const attachments = this.svc('attachment');
    const images = this.svc('product_image')
      .findBy('productId', id)
      .sort((a, b) => (a.sortOrder as number) - (b.sortOrder as number))
      .map((img) => ({ ...img, attachment: attachments.get(img.attachmentId as string) }));
    const coops = this.svc('cooperation_product')
      .findBy('productId', id)
      .map((cp) => {
        const coop = this.svc('cooperation').get(cp.cooperationId as string);
        if (!coop) return undefined;
        const inf = this.svc('influencer').get(coop.influencerId as string);
        return { ...cp, cooperation: coop, influencerNickname: inf?.nickname };
      })
      .filter(Boolean);
    return {
      product,
      variants: this.svc('product_variant').findBy('productId', id),
      links: this.svc('product_platform_link').findBy('productId', id),
      images,
      cooperations: coops,
      history: this.history('product', id),
    };
  }

  influencerDetail(id: string) {
    const influencer = this.svc('influencer').require(id);
    const cooperations = this.svc('cooperation').findBy('influencerId', id);
    const shipments = this.svc('sample_shipment').findBy('influencerId', id);
    const links = this.svc('influencer_contact').findBy('influencerId', id);
    const contacts = links
      .map((l) => ({ ...l, contact: this.svc('contact').get(l.contactId as string) }))
      .filter((l) => l.contact);
    const followUps = [
      ...this.svc('follow_up').findBy('influencerId', id),
      ...cooperations.flatMap((c) => this.svc('follow_up').findBy('cooperationId', c.id)),
    ];
    const unique = [...new Map(followUps.map((f) => [f.id, f])).values()].sort((a, b) =>
      String(b.occurredAt).localeCompare(String(a.occurredAt)),
    );
    return {
      influencer,
      accounts: this.svc('platform_account').findBy('influencerId', id),
      addresses: this.svc('influencer_address').findBy('influencerId', id),
      contacts,
      cooperations,
      followUps: unique.slice(0, 50),
      summary: {
        coopCount: cooperations.length,
        shipmentCount: shipments.length,
        recycleIssueCount: influencer.recycleIssueCount as number,
      },
      history: this.history('influencer', id),
    };
  }

  contactDetail(id: string) {
    const contact = this.svc('contact').require(id);
    const links = this.svc('influencer_contact').findBy('contactId', id);
    const influencers = links
      .map((l) => ({
        ...l,
        influencer: this.svc('influencer').get(l.influencerId as string) as Row,
      }))
      .filter((l) => l.influencer);
    return {
      contact,
      influencers,
      followUps: this.svc('follow_up')
        .findBy('contactId', id)
        .sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt))),
      history: this.history('contact', id),
    };
  }
}
