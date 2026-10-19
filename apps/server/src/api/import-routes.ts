import { Hono, type Context } from 'hono';
import { DomainError } from '../domain/errors.ts';
import type { Domain } from '../domain/index.ts';
import { analyzeSheet, type SheetAnalysis } from '../import/analyze.ts';
import { commitImport, dryRun, rollbackBatch } from '../import/engine.ts';
import {
  EXPORT_ENTITIES,
  EXPORT_LABELS,
  exportAll,
  exportList,
  writeWorkbook,
  type ExportEntity,
} from '../import/export.ts';
import { buildColumns, parseFile, type ParsedFile } from '../import/parse.ts';
import { CUSTOM_TARGETS, TARGET_FIELDS, TARGET_LABELS } from '../import/fields.ts';
import { customKeyFor } from '../import/records.ts';
import { TRANSFORM_LABELS } from '../import/transforms.ts';
import { buildSampleWorkbook } from '../import/sample-data.ts';
import { ImportSessions } from '../import/session.ts';
import { bestTemplate } from '../import/suggest.ts';
import { applyTemplate, buildTemplate } from '../import/templates.ts';
import { TARGET_KEYS, type Decisions, type SheetConfig, type TargetKey } from '../import/types.ts';
import { jsonBody, parseListQuery } from './util.ts';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function download(c: Context, buf: Buffer, fileName: string) {
  return new Response(new Uint8Array(buf), {
    headers: {
      'content-type': XLSX_TYPE,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    },
  });
}

const today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

/** 导入向导和导出的接口（PRD 6）。解析、转换、查重、写入都在 import/ 和领域层，这里只做参数解析。 */
export function createImportApi(domain: Domain, dataDir: string) {
  const r = new Hono();
  const sessions = new ImportSessions(dataDir);
  const actor = () => domain.userActor();

  /** 一张表的分析结果 + 按表头特征匹配到的模板（已套好的配置） */
  function describeSheet(
    parsed: ParsedFile,
    name: string,
    header?: { row: number; rows: number },
    target?: TargetKey,
  ) {
    const sheet = parsed.sheets.find((s) => s.name === name);
    if (!sheet) throw new DomainError('not_found', `没有名为「${name}」的 sheet`);
    const analysis: SheetAnalysis = analyzeSheet(sheet, header, target);
    const templates = domain.entity('mapping_template').list() as unknown as (Record<
      string,
      unknown
    > & { id: string; name: string; entity: string; headerSignature: string[] })[];
    const hit = bestTemplate(
      templates,
      analysis.columns.map((c) => c.name),
    );
    const applied = hit ? applyTemplate(hit.template as never, analysis.columns) : null;
    return {
      name: sheet.name,
      rowCount: analysis.rowCount,
      mergedCells: sheet.mergedCells,
      preview: sheet.rows.slice(0, 10),
      header: analysis.header,
      target: analysis.target,
      targetScores: analysis.targetScores,
      columns: analysis.columns.map((c) => ({ ...c, customKey: customKeyFor(c.name) })),
      suggestions: analysis.suggestions,
      template:
        hit && applied
          ? {
              id: hit.template.id,
              name: hit.template.name,
              score: Math.round(hit.score * 100) / 100,
              added: hit.added,
              missing: hit.missing,
              applied,
            }
          : null,
    };
  }

  /** 各目标的可映射字段、枚举选项、值转换类型（向导里的下拉直接用这份定义） */
  r.get('/meta', (c) => {
    const statuses = domain.settings.followStatuses();
    return c.json({
      targets: Object.fromEntries(
        TARGET_KEYS.map((t) => [
          t,
          {
            label: TARGET_LABELS[t],
            canCustom: CUSTOM_TARGETS.includes(t),
            fields: TARGET_FIELDS[t].map((f) => ({
              key: f.key,
              label: f.label,
              transform: f.transform,
              required: !!f.required,
              sensitive: !!f.sensitive,
              hint: f.hint ?? null,
              enum: f.enum ? (f.enum === 'follow_status' ? statuses : [...f.enum]) : null,
            })),
          },
        ]),
      ),
      transforms: TRANSFORM_LABELS,
    });
  });

  r.post('/upload', async (c) => {
    const form = await c.req.parseBody();
    const file = form['file'];
    if (!(file instanceof File)) throw new DomainError('validation', '请选择要导入的文件');
    const parsed = parseFile(Buffer.from(await file.arrayBuffer()), file.name);
    const sessionId = sessions.save(parsed);
    return c.json({
      sessionId,
      fileName: parsed.fileName,
      encoding: parsed.encoding,
      sheets: parsed.sheets
        .filter((s) => s.rows.length > 0)
        .map((s) => describeSheet(parsed, s.name)),
    });
  });

  /** 用户改了表头行、表头占几行或目标实体后，重新分析 */
  r.post('/:id/analyze', async (c) => {
    const { sheet, headerRow, headerRows, target } = await jsonBody(c);
    const parsed = sessions.load(c.req.param('id'));
    const header =
      Number.isInteger(headerRow) && Number.isInteger(headerRows)
        ? { row: headerRow, rows: Math.max(1, headerRows) }
        : undefined;
    return c.json(describeSheet(parsed, sheet, header, target));
  });

  const configsOf = (body: Record<string, unknown>) => {
    const configs = body.configs as SheetConfig[] | undefined;
    if (!Array.isArray(configs) || !configs.length)
      throw new DomainError('validation', '请先选择要导入的 sheet');
    return { configs, decisions: (body.decisions ?? {}) as Decisions };
  };

  r.post('/:id/dry-run', async (c) => {
    const { configs, decisions } = configsOf(await jsonBody(c));
    const parsed = sessions.load(c.req.param('id'));
    return c.json({ sheets: dryRun(domain, parsed, configs, decisions).sheets });
  });

  /** 错误行导出：原表的列 + 一列"错误原因"，改完可以再导入 */
  r.post('/:id/errors', async (c) => {
    const { configs, decisions } = configsOf(await jsonBody(c));
    const parsed = sessions.load(c.req.param('id'));
    const { sheets } = dryRun(domain, parsed, configs, decisions);
    const out = sheets.flatMap((s) => {
      const cfg = configs.find((x) => x.sheet === s.sheet)!;
      const src = parsed.sheets.find((x) => x.name === s.sheet)!;
      const { columns } = buildColumns(src.rows, { row: cfg.headerRow, rows: cfg.headerRows });
      const bad = s.rows.filter((row) => row.status === 'error');
      if (!bad.length) return [];
      return [
        {
          name: `${s.sheet}-错误行`,
          headers: ['原表行号', ...columns.map((col) => col.name), '错误原因'],
          rows: bad.map((row) => [
            row.rowNo,
            ...columns.map((col) => src.rows[row.rowNo - 1]?.[col.index] ?? null),
            row.issues
              .filter((i) => i.level === 'error')
              .map((i) => i.text)
              .join('；'),
          ]),
        },
      ];
    });
    if (!out.length) throw new DomainError('not_found', '没有错误行');
    return download(c, writeWorkbook(out), `导入错误行-${today()}.xlsx`);
  });

  r.post('/:id/commit', async (c) => {
    const body = await jsonBody(c);
    const { configs, decisions } = configsOf(body);
    const parsed = sessions.load(c.req.param('id'));
    const template = body.saveTemplate as { name?: string } | undefined;
    const outcome = commitImport(domain, parsed, configs, decisions, {
      fileName: parsed.fileName,
      templateId: body.templateId ?? null,
    });
    // 保存模板：每张 sheet 一个模板，下次按表头特征自动套用
    const saved: string[] = [];
    if (template?.name?.trim()) {
      for (const cfg of configs) {
        const sheet = parsed.sheets.find((s) => s.name === cfg.sheet)!;
        const { columns } = buildColumns(sheet.rows, { row: cfg.headerRow, rows: cfg.headerRows });
        const name =
          configs.length > 1 ? `${template.name.trim()} · ${cfg.sheet}` : template.name.trim();
        const res = domain
          .entity('mapping_template')
          .create(actor(), { name, ...buildTemplate(cfg, columns) });
        if (res.status === 'applied') saved.push(res.row.id);
      }
    }
    return c.json({ ...outcome, templateIds: saved });
  });

  // ───────────── 批次 ─────────────
  r.get('/batches', (c) => {
    const rows = domain.entity('import_batch').query({ limit: 100 }).rows;
    return c.json({ rows });
  });
  r.post('/batches/:id/rollback', (c) => c.json(rollbackBatch(domain, c.req.param('id'))));

  /** 样例文件：虚构的钉钉多维表导出，用来试一遍导入流程 */
  r.get('/sample.xlsx', (c) => download(c, buildSampleWorkbook(), '钉钉多维表导出示例.xlsx'));

  return r;
}

/** 导出：列表导出（带和页面一样的筛选）和全量导出 */
export function createExportApi(domain: Domain) {
  const r = new Hono();
  r.get('/list/:entity', (c) => {
    const entity = c.req.param('entity') as ExportEntity;
    if (!EXPORT_ENTITIES.includes(entity)) throw new DomainError('not_found', '不支持导出这个列表');
    const sheet = exportList(domain, entity, parseListQuery(c));
    return download(c, writeWorkbook([sheet]), `${EXPORT_LABELS[entity]}-${today()}.xlsx`);
  });
  r.get('/all', (c) => download(c, writeWorkbook(exportAll(domain)), `全量导出-${today()}.xlsx`));
  return r;
}
