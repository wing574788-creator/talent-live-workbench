/**
 * REST 路由：只做参数解析、调用领域服务、脱敏、序列化；不写 SQL，不写校验逻辑（铁律 1）。
 * 用户在页面上的操作一律以默认用户身份（actor.type = 'user'）调用。
 */
import fs from 'node:fs';
import { Hono } from 'hono';
import { SENSITIVE_FIELDS, maskRow } from '@workbench/shared';
import { DomainError } from '../domain/errors.ts';
import type { Domain } from '../domain/index.ts';
import { MAX_BATCH, appliedOf, type Row } from '../domain/types.ts';
import type { AttachmentStore } from '../storage.ts';
import { createAiApi } from '../ai/routes.ts';
import type { AiContext } from '../ai/index.ts';
import { createExportApi, createImportApi } from './import-routes.ts';
import { jsonBody, parseListQuery, writeResponse } from './util.ts';

/** 通用增删改允许的实体（列表和详情各自有专用路由） */
const WRITABLE = new Set([
  'product',
  'product_variant',
  'product_platform_link',
  'product_image',
  'influencer',
  'influencer_address',
  'platform_account',
  'contact',
  'influencer_contact',
  'field_def',
  'saved_view',
  'cooperation',
  'cooperation_product',
  'follow_up',
  'enum_option',
  'mapping_template',
]);

const maskInfluencer = (r: Row) => maskRow(r, SENSITIVE_FIELDS.influencer);
const maskContact = (r: Row) => maskRow(r, SENSITIVE_FIELDS.contact);
const maskAddress = (r: Row) => maskRow(r, SENSITIVE_FIELDS.influencer_address);
const maskShipment = <T extends Record<string, unknown>>(r: T) =>
  maskRow(r, SENSITIVE_FIELDS.sample_shipment);

/** 变更历史里的前后快照也要打码 */
function maskHistory<T extends { entity: string; before: unknown; after: unknown }>(
  logs: T[],
): T[] {
  const fieldsOf = (entity: string): readonly string[] =>
    (SENSITIVE_FIELDS as Record<string, readonly string[]>)[entity] ?? [];
  return logs.map((l) => {
    const f = fieldsOf(l.entity);
    if (!f.length) return l;
    return {
      ...l,
      before: l.before ? maskRow(l.before as Row, f) : l.before,
      after: l.after ? maskRow(l.after as Row, f) : l.after,
    };
  });
}

export function createApi(domain: Domain, store: AttachmentStore, dataDir: string, ai: AiContext) {
  const api = new Hono();
  const actor = () => domain.userActor();

  api.onError((err, c) => {
    if (err instanceof DomainError) {
      const status = {
        validation: 400,
        not_found: 404,
        conflict: 409,
        duplicate: 409,
        invalid_state: 409,
        ai_not_configured: 400,
        outbound_blocked: 403,
        ai_disabled: 403,
      }[err.code] as 400 | 404 | 409;
      return c.json({ error: err.message, code: err.code, details: err.details }, status);
    }
    console.error(err);
    return c.json({ error: '服务器内部错误', code: 'internal' }, 500);
  });

  api.route('/import', createImportApi(domain, dataDir));
  api.route('/export', createExportApi(domain));
  api.route('/ai', createAiApi(ai, store));

  // ───────────── 通用写入 ─────────────
  api.post('/e/:entity', async (c) => {
    const entity = c.req.param('entity');
    if (!WRITABLE.has(entity)) throw new DomainError('not_found', '未知实体');
    return writeResponse(c, domain.entity(entity).create(actor(), await jsonBody(c)));
  });
  api.patch('/e/:entity/:id', async (c) => {
    const entity = c.req.param('entity');
    if (!WRITABLE.has(entity)) throw new DomainError('not_found', '未知实体');
    const { patch, expectedVersion } = await jsonBody(c);
    return writeResponse(
      c,
      domain.entity(entity).update(actor(), c.req.param('id'), patch, { expectedVersion }),
    );
  });
  api.delete('/e/:entity/:id', (c) => {
    const entity = c.req.param('entity');
    if (!WRITABLE.has(entity)) throw new DomainError('not_found', '未知实体');
    const v = c.req.query('expectedVersion');
    return writeResponse(
      c,
      domain.entity(entity).delete(actor(), c.req.param('id'), {
        expectedVersion: v ? Number(v) : undefined,
      }),
    );
  });
  /** field_def / saved_view 的简单列表 */
  api.get('/e/:entity', (c) => {
    const entity = c.req.param('entity');
    if (!['field_def', 'saved_view', 'enum_option', 'mapping_template'].includes(entity))
      throw new DomainError('not_found', '未知实体');
    return c.json(domain.entity(entity).query(parseListQuery(c)));
  });

  // ───────────── 撤销 / 审核 ─────────────
  api.post('/changes/:logId/undo', (c) =>
    writeResponse(c, domain.review.undo(actor(), c.req.param('logId'))),
  );
  api.post('/batches/:batchId/undo', (c) =>
    c.json(domain.review.undoBatch(actor(), c.req.param('batchId'))),
  );
  api.get('/review/pending', (c) => c.json({ rows: domain.reviewView.listPending() }));
  api.post('/review/batch/:batchId/approve', (c) =>
    c.json(domain.review.approveBatch(c.req.param('batchId'), domain.userId)),
  );
  api.post('/review/batch/:batchId/reject', (c) =>
    c.json({ rejected: domain.review.rejectBatch(c.req.param('batchId'), domain.userId) }),
  );
  /** 变更日志：可按实体、操作者、批次筛选；before 为上一页最后一条的 id */
  api.get('/changes', (c) => {
    const q = c.req.query();
    return c.json(
      domain.reviewView.listChanges({
        entity: q.entity || undefined,
        actorType: q.actor || undefined,
        batchId: q.batchId || undefined,
        before: q.before || undefined,
        limit: q.limit ? Number(q.limit) : undefined,
      }),
    );
  });
  /** 首页数据（今日待跟进、寄样预警、近 7 天开播、四个数字） */
  api.get('/home', (c) => c.json(domain.home.dashboard()));
  api.post('/review/:id/approve', (c) =>
    writeResponse(c, domain.review.approve(c.req.param('id'), domain.userId)),
  );
  api.post('/review/:id/reject', (c) => {
    domain.review.reject(c.req.param('id'), domain.userId);
    return c.json({ ok: true });
  });
  /** 在审核卡片上直接改待审核改动的字段，再点通过 */
  api.patch('/review/:id', async (c) => {
    const { patch } = await jsonBody(c);
    const data = domain.review.editPatch(c.req.param('id'), patch ?? {});
    return c.json({ ok: true, patch: data });
  });
  api.post('/review/:id/rebase', (c) => {
    domain.review.rebase(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ───────────── 商品 ─────────────
  api.get('/products', (c) => c.json(domain.entity('product').query(parseListQuery(c))));
  api.get('/products/:id', (c) => c.json(domain.read.productDetail(c.req.param('id'))));
  api.post('/products', async (c) => {
    const { product, variants = [], links = [] } = await jsonBody(c);
    const batchId = domain.newBatchId();
    const act = domain.userActor({ batchId });
    const created = domain.transaction(() => {
      const res = domain.entity('product').create(act, product);
      if (res.status !== 'applied') throw new DomainError('invalid_state', '新建商品不应进入审核');
      for (const v of variants)
        domain.entity('product_variant').create(act, { ...v, productId: res.row.id });
      for (const l of links)
        domain.entity('product_platform_link').create(act, { ...l, productId: res.row.id });
      return res.row;
    });
    return c.json({ status: 'applied', row: created, batchId });
  });
  api.post('/products/:id/images', async (c) => {
    const productId = c.req.param('id');
    domain.entity('product').require(productId);
    const form = await c.req.parseBody();
    const file = form['file'];
    if (!(file instanceof File)) throw new DomainError('validation', '请选择图片文件');
    const saved = await store.saveImage(file);
    const act = actor();
    const order = domain.entity('product_image').findBy('productId', productId).length;
    const row = domain.transaction(() => {
      const att = domain.entity('attachment').create(act, {
        kind: 'product_image',
        path: saved.path,
        originalName: file.name,
        mime: saved.mime,
        sizeBytes: saved.sizeBytes,
        ownerType: 'product',
        ownerId: productId,
      });
      if (att.status !== 'applied') throw new DomainError('invalid_state', '附件写入失败');
      const img = domain.entity('product_image').create(act, {
        productId,
        attachmentId: att.row.id,
        sortOrder: order,
      });
      if (img.status !== 'applied') throw new DomainError('invalid_state', '图片写入失败');
      return img.row;
    });
    return c.json({ status: 'applied', row });
  });
  /** 设为主图：把该图排到第一位，其余顺延 */
  api.post('/products/:id/images/:imageId/primary', (c) => {
    const imgs = domain
      .entity('product_image')
      .findBy('productId', c.req.param('id'))
      .sort((a, b) => (a.sortOrder as number) - (b.sortOrder as number));
    const target = imgs.find((i) => i.id === c.req.param('imageId'));
    if (!target) throw new DomainError('not_found', '图片不存在');
    const ordered = [target, ...imgs.filter((i) => i.id !== target.id)];
    domain.transaction(() =>
      ordered.forEach((img, i) =>
        domain.entity('product_image').update(actor(), img.id, { sortOrder: i }),
      ),
    );
    return c.json({ ok: true });
  });
  api.get('/attachments/:id/file', (c) => {
    const att = domain.entity('attachment').require(c.req.param('id'));
    const abs = store.resolve(att.path as string);
    if (!fs.existsSync(abs)) throw new DomainError('not_found', '文件不存在');
    return new Response(fs.readFileSync(abs), {
      headers: {
        'content-type': (att.mime as string) ?? 'application/octet-stream',
        'cache-control': 'private, max-age=3600',
      },
    });
  });

  // ───────────── 达人 ─────────────
  api.get('/influencers', (c) => {
    const res = domain.influencers.listWithSummary(parseListQuery(c));
    return c.json({ total: res.total, rows: res.rows.map(maskInfluencer) });
  });
  api.get('/influencers/check-duplicate', (c) => {
    const { platform, accountId, nickname } = c.req.query();
    const res = domain.influencers.checkDuplicate({ platform, accountId, nickname });
    return c.json({
      exact: res.exact && {
        account: res.exact.account,
        influencer: maskInfluencer(res.exact.influencer),
      },
      similar: res.similar.map((s) => ({
        score: s.score,
        influencer: maskInfluencer(s.influencer),
      })),
    });
  });
  api.post('/influencers', async (c) => {
    const body = await jsonBody(c);
    const res = domain.influencers.createWithAccounts(domain.userActor(), body as never);
    return c.json({ status: 'applied', ...res });
  });
  api.get('/influencers/:id', (c) => {
    const d = domain.read.influencerDetail(c.req.param('id'));
    return c.json({
      ...d,
      influencer: maskInfluencer(d.influencer),
      addresses: d.addresses.map(maskAddress),
      contacts: d.contacts.map((l) => ({ ...l, contact: maskContact(l.contact as Row) })),
      history: maskHistory(d.history),
    });
  });
  /** 点击"查看"才返回明文 */
  api.get('/influencers/:id/reveal', (c) => {
    const id = c.req.param('id');
    const d = domain.read.influencerDetail(id);
    return c.json({
      realName: d.influencer.realName,
      addresses: d.addresses,
      contacts: d.contacts.map((l) => ({
        id: (l.contact as Row).id,
        wechat: (l.contact as Row).wechat,
        phone: (l.contact as Row).phone,
      })),
    });
  });
  api.post('/influencers/:id/merge', async (c) => {
    const { mergeId } = await jsonBody(c);
    return writeResponse(c, domain.influencers.requestMerge(actor(), c.req.param('id'), mergeId));
  });
  api.post('/influencers/:id/contacts', async (c) => {
    const { contactId, isPrimary } = await jsonBody(c);
    const row = domain.influencers.linkContact(actor(), c.req.param('id'), contactId, !!isPrimary);
    return c.json({ status: 'applied', row });
  });

  // ───────────── 合作 ─────────────
  api.get('/cooperations', (c) => c.json(domain.cooperations.listEnriched(parseListQuery(c))));
  api.get('/cooperations/:id', (c) => {
    const d = domain.cooperations.detail(c.req.param('id'));
    return c.json({
      ...d,
      influencer: d.influencer && maskInfluencer(d.influencer),
      contact: d.contact && maskContact(d.contact),
      history: maskHistory(d.history as never),
    });
  });
  /** 新建合作：同时写入合作商品，失败整体回滚 */
  api.post('/cooperations', async (c) => {
    const { cooperation, products = [] } = await jsonBody(c);
    const batchId = domain.newBatchId();
    const act = domain.userActor({ batchId });
    const row = domain.transaction(() => {
      const res = domain.entity('cooperation').create(act, cooperation);
      if (res.status !== 'applied') throw new DomainError('invalid_state', '新建合作不应进入审核');
      for (const p of products) {
        domain.entity('cooperation_product').create(act, { ...p, cooperationId: res.row.id });
      }
      return res.row;
    });
    return c.json({ status: 'applied', row, batchId });
  });
  /** 手动触发阶段自动推进（服务启动和每小时也会自动跑） */
  api.post('/automation/run', (c) => c.json(domain.automation.runDaily()));

  // ───────────── 设置：跟进状态选项、连续待回复阈值 ─────────────
  /** 可在设置页修改的整数阈值：键 → [最小, 最大, 名称] */
  const INT_SETTINGS = {
    replyStallCount: [2, 20, '连续待回复次数'],
    defaultFollowDays: [1, 60, '默认下次跟进天数'],
    returnAfterLiveDays: [0, 90, '开播后应寄回天数（N）'],
    returnAfterSignDays: [0, 180, '签收后应寄回天数（M）'],
    shipOverdueDays: [1, 30, '待寄样预警天数'],
    signedNotLiveDays: [1, 365, '签收后未开播预警天数'],
  } as const;
  api.get('/settings', (c) =>
    c.json({
      followStatuses: domain.settings.enumRows('follow_status'),
      replyStallCount: domain.settings.get('replyStallCount'),
      defaultFollowDays: domain.settings.get('defaultFollowDays'),
      returnAfterLiveDays: domain.settings.get('returnAfterLiveDays'),
      returnAfterSignDays: domain.settings.get('returnAfterSignDays'),
      shipOverdueDays: domain.settings.get('shipOverdueDays'),
      signedNotLiveDays: domain.settings.get('signedNotLiveDays'),
    }),
  );
  api.put('/settings/:key', async (c) => {
    const key = c.req.param('key') as keyof typeof INT_SETTINGS;
    const rule = INT_SETTINGS[key];
    if (!rule) throw new DomainError('not_found', '未知设置项');
    const { value } = await jsonBody(c);
    const [min, max, name] = rule;
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new DomainError('validation', `${name}应为 ${min}~${max} 的整数`);
    }
    return writeResponse(c, domain.settings.set(actor(), key, value));
  });

  // ───────────── 样品台账（阶段 4） ─────────────
  const SAMPLE_FILTERS: Record<string, (r: Record<string, any>) => boolean> = {
    // eslint-disable-line @typescript-eslint/no-explicit-any
    outstanding: (r) => r.outstanding > 0,
    overdue: (r) => r.overdueQty > 0,
    qa: (r) => r.qaPending > 0,
    settled: (r) => r.settled,
    pendingShip: (r) => r.pendingShip > 0,
  };
  api.get('/samples', (c) => {
    const f = c.req.query('filter') ?? '';
    const rows = domain.samples.summaries();
    return c.json({ rows: SAMPLE_FILTERS[f] ? rows.filter(SAMPLE_FILTERS[f]!) : rows });
  });
  api.get('/samples/pending-shipments', (c) => c.json(domain.samples.pendingShipments()));
  api.get('/influencers/:id/samples', (c) => {
    const d = domain.samples.detail(c.req.param('id'));
    return c.json({
      ...d,
      influencer: maskInfluencer(d.influencer),
      timeline: d.timeline.map((t) => (t.type === 'ship' ? maskShipment(t) : t)),
      pendingShipments: d.pendingShipments.map(maskShipment),
    });
  });
  api.post('/samples/shipments', async (c) => {
    const row = domain.samples.createShipment(actor(), (await jsonBody(c)) as never);
    return c.json({ status: 'applied', row: maskShipment(row) });
  });
  /** 批量标记寄出：逐条成功或失败，失败的单条不影响其他 */
  api.post('/samples/shipments/ship', async (c) => {
    const { ids, shippedAt } = await jsonBody(c);
    if (!Array.isArray(ids) || !ids.length)
      throw new DomainError('validation', '请选择要寄出的寄样单');
    if (ids.length > MAX_BATCH)
      throw new DomainError('validation', `单次批量不能超过 ${MAX_BATCH} 条`);
    return c.json(domain.samples.shipMany(actor(), ids, shippedAt ?? null));
  });
  api.post('/samples/shipments/:id/ship', async (c) => {
    const row = domain.samples.ship(actor(), c.req.param('id'), await jsonBody(c));
    return c.json({ status: 'applied', row: maskShipment(row) });
  });
  api.post('/samples/shipments/:id/sign', async (c) => {
    const { signedAt } = await jsonBody(c);
    return c.json({
      status: 'applied',
      row: maskShipment(domain.samples.sign(actor(), c.req.param('id'), signedAt ?? null)),
    });
  });
  api.post('/samples/shipments/:id/extend-due', async (c) => {
    const { dueBackDate, note } = await jsonBody(c);
    if (!dueBackDate) throw new DomainError('validation', '请填写新的应寄回日期');
    return c.json({
      status: 'applied',
      row: maskShipment(
        domain.samples.extendDue(actor(), c.req.param('id'), dueBackDate, note ?? ''),
      ),
    });
  });
  api.post('/samples/returns', async (c) => {
    const row = domain.samples.createReturn(actor(), (await jsonBody(c)) as never);
    return c.json({ status: 'applied', row });
  });
  /** 质检结果、照片、处理结果：走实体更新，改动记日志；回收问题次数由写后钩子自动计数 */
  api.patch('/samples/return-items/:id', async (c) => {
    const { patch, expectedVersion } = await jsonBody(c);
    return writeResponse(
      c,
      domain
        .entity('sample_return_item')
        .update(actor(), c.req.param('id'), patch, { expectedVersion }),
    );
  });
  api.post('/samples/writeoffs', async (c) => {
    const row = domain.samples.createWriteoff(actor(), (await jsonBody(c)) as never);
    return c.json({ status: 'applied', row });
  });
  api.post('/influencers/:id/clear-addresses', (c) =>
    c.json({ cleared: domain.samples.clearAddresses(actor(), c.req.param('id')) }),
  );
  /** 质检照片等图片附件上传，返回附件 id 供退样明细引用 */
  api.post('/attachments/image', async (c) => {
    const form = await c.req.parseBody();
    const file = form['file'];
    if (!(file instanceof File)) throw new DomainError('validation', '请选择图片文件');
    const saved = await store.saveImage(file);
    const row = appliedOf(
      domain.entity('attachment').create(actor(), {
        kind: 'qa_photo',
        path: saved.path,
        originalName: file.name,
        mime: saved.mime,
        sizeBytes: saved.sizeBytes,
      }),
    ).row;
    return c.json({ id: row.id });
  });

  // ───────────── 联系人 ─────────────
  api.get('/contacts', (c) => {
    const res = domain.entity('contact').query(parseListQuery(c));
    return c.json({ total: res.total, rows: res.rows.map(maskContact) });
  });
  api.get('/contacts/:id', (c) => {
    const d = domain.read.contactDetail(c.req.param('id'));
    return c.json({
      ...d,
      contact: maskContact(d.contact),
      influencers: d.influencers.map((l) => ({ ...l, influencer: maskInfluencer(l.influencer) })),
      history: maskHistory(d.history),
    });
  });
  api.get('/contacts/:id/reveal', (c) => {
    const row = domain.entity('contact').require(c.req.param('id'));
    return c.json({ wechat: row.wechat, phone: row.phone });
  });

  return api;
}
