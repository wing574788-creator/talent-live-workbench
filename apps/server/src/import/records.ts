/**
 * 把一张表的数据行按列映射转换成 ImportRecord：值转换、枚举映射、自定义字段、无法解析的单元格存为"导入原始值"。
 * 纯函数（只读配置和词典），不碰数据库。
 */
import { buildColumns, dataRows, type Cell, type ParsedSheet } from './parse.ts';
import { CUSTOM_TARGETS, TARGET_FIELDS, fieldOf } from './fields.ts';
import { resolveEnum } from './suggest.ts';
import {
  applyTransform,
  isEmpty,
  parseBool,
  parseDate,
  splitMulti,
  normalizePlatform,
  toText,
  type TransformType,
} from './transforms.ts';
import type {
  ColumnMapping,
  CustomType,
  EnumReport,
  FieldDef,
  ImportRecord,
  SheetConfig,
} from './types.ts';

export const RAW_FIELD_KEY = 'import_raw';
export const RAW_FIELD_LABEL = '导入原始值';

export interface BuildResult {
  records: ImportRecord[];
  enums: EnumReport[];
  /** 本次要新建的自定义字段 */
  newCustomFields: { key: string; label: string; type: CustomType }[];
  /** 配置本身的问题（两列映射到同一字段、必填字段没映射等），有问题时不能提交 */
  configIssues: string[];
  /** 是否有单元格被存进了"导入原始值" */
  usesRaw: boolean;
  columnNames: string[];
}

/** 自定义列的字段键：由表头文字稳定生成，同一个列下次导入会对应同一个字段 */
export function customKeyFor(header: string): string {
  let h = 5381;
  for (const ch of header) h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0;
  return `c_${h.toString(36)}`;
}

function parseNumber(raw: unknown) {
  if (typeof raw === 'number')
    return Number.isFinite(raw)
      ? { ok: true as const, value: raw }
      : { ok: false as const, error: '不是数字' };
  const s = toText(raw).replace(/[,，\s]/g, '');
  return /^-?\d+(\.\d+)?$/.test(s)
    ? { ok: true as const, value: Number(s) }
    : { ok: false as const, error: `不是数字：${toText(raw)}` };
}

function customValue(type: CustomType, raw: unknown, now: Date) {
  switch (type) {
    case 'number':
      return parseNumber(raw);
    case 'date':
      return parseDate(raw, now);
    case 'bool':
      return parseBool(raw);
    default:
      return { ok: true as const, value: toText(raw) };
  }
}

const SEPARATORS = /[/、,，;；|\n]/;

export function buildRecords(
  sheet: ParsedSheet,
  cfg: SheetConfig,
  opts: { followStatuses: string[]; now?: Date },
): BuildResult {
  const now = opts.now ?? new Date();
  const fields = TARGET_FIELDS[cfg.target];
  const { columns, dataStart } = buildColumns(sheet.rows, {
    row: cfg.headerRow,
    rows: cfg.headerRows,
  });
  const nameOf = new Map(columns.map((c) => [c.index, c.name]));
  const configIssues: string[] = [];
  const canKeepRaw = CUSTOM_TARGETS.includes(cfg.target);

  // 配置检查
  const used = new Map<string, string>();
  const customs: { key: string; label: string; type: CustomType }[] = [];
  for (const [idx, m] of Object.entries(cfg.mapping)) {
    const col = nameOf.get(Number(idx)) ?? `列 ${Number(idx) + 1}`;
    if (m.kind === 'field') {
      const fd = fieldOf(cfg.target, m.field);
      if (!fd) configIssues.push(`「${col}」映射到了不存在的字段「${m.field}」`);
      else if (used.has(m.field))
        configIssues.push(
          `「${col}」和「${used.get(m.field)}」都映射到了「${fd.label}」，一个字段只能对应一列`,
        );
      else used.set(m.field, col);
    } else if (m.kind === 'custom') {
      if (!/^[a-z][a-z0-9_]*$/.test(m.key)) configIssues.push(`「${col}」的自定义字段键不合法`);
      else if (customs.some((c) => c.key === m.key))
        configIssues.push(`「${col}」的自定义字段重复`);
      else customs.push({ key: m.key, label: m.label || col, type: m.type });
    }
  }
  for (const fd of fields) {
    if (fd.required && !used.has(fd.key))
      configIssues.push(`必填字段「${fd.label}」还没有对应的列`);
  }

  // 枚举字段：收集表里出现的每个值
  const enumCols = [...used.entries()].filter(([k]) => fieldOf(cfg.target, k)?.enum);
  const optionsOf = (fd: FieldDef): string[] =>
    fd.enum === 'follow_status' ? opts.followStatuses : [...(fd.enum ?? [])];
  const enumSeen = new Map<string, Map<string, number>>();

  const records: ImportRecord[] = [];
  let usesRaw = false;
  for (const { rowNo, cells } of dataRows(sheet.rows, dataStart)) {
    const rec: ImportRecord = { rowNo, values: {}, customs: {}, raws: [], issues: [] };
    for (const [idxS, m] of Object.entries(cfg.mapping)) {
      const idx = Number(idxS);
      const raw: Cell = cells[idx] ?? null;
      if (isEmpty(raw) || m.kind === 'ignore') continue;
      const col = nameOf.get(idx) ?? `列 ${idx + 1}`;
      if (m.kind === 'raw') {
        rec.raws.push(`${col}：${toText(raw)}`);
        continue;
      }
      if (m.kind === 'custom') {
        const r = customValue(m.type, raw, now);
        if (r.ok) rec.customs[m.key] = r.value;
        else {
          rec.raws.push(`${col}：${toText(raw)}`);
          rec.issues.push({ level: 'warn', text: `「${col}」${r.error}，已存为导入原始值` });
        }
        continue;
      }
      const fd = fieldOf(cfg.target, m.field);
      if (!fd) continue;

      if (fd.enum) {
        const key = toText(raw);
        const seen = enumSeen.get(fd.key) ?? new Map<string, number>();
        seen.set(key, (seen.get(key) ?? 0) + 1);
        enumSeen.set(fd.key, seen);
        const explicit = cfg.enumMap[fd.key]?.[key];
        const mapped = explicit !== undefined ? explicit : resolveEnum(fd.key, optionsOf(fd), key);
        if (mapped === null) {
          if (explicit === undefined)
            rec.issues.push({
              level: 'error',
              text: `「${col}」的值「${key}」还没有对应的系统选项`,
            });
        } else rec.values[fd.key] = mapped;
        continue;
      }

      const type: TransformType = m.transform ?? fd.transform;
      let r;
      if (type === 'platform' && SEPARATORS.test(toText(raw))) {
        // "小红书/抖音"：拆开后逐个归一
        const parts = splitMulti(raw).map((p) => normalizePlatform(p));
        const bad = parts.find((p) => !p.ok);
        r =
          bad && !bad.ok
            ? bad
            : { ok: true as const, value: parts.map((p) => (p.ok ? p.value : '')) };
      } else r = applyTransform(type, raw, now);
      if (r.ok) {
        rec.values[fd.key] = r.value;
        if (r.warning) rec.issues.push({ level: 'warn', text: `「${col}」${r.warning}` });
      } else if (canKeepRaw) {
        rec.raws.push(`${col}：${toText(raw)}`);
        rec.issues.push({
          level: 'warn',
          text: `「${col}」${r.error}，已存为导入原始值（原单元格不会丢）`,
        });
      } else {
        rec.issues.push({ level: 'warn', text: `「${col}」${r.error}，这个单元格没有导入` });
      }
    }
    if (rec.raws.length) usesRaw = true;
    records.push(rec);
  }

  const enums: EnumReport[] = enumCols.map(([key]) => {
    const fd = fieldOf(cfg.target, key)!;
    const options = optionsOf(fd);
    return {
      field: key,
      label: fd.label,
      options,
      values: [...(enumSeen.get(key) ?? new Map<string, number>()).entries()].map(
        ([raw, count]) => {
          const explicit = cfg.enumMap[key]?.[raw];
          const auto = resolveEnum(key, options, raw);
          return {
            raw,
            count,
            mapped: explicit !== undefined ? explicit : auto,
            auto: explicit === undefined && auto !== null,
            decided: explicit !== undefined || auto !== null,
          };
        },
      ),
    };
  });
  return {
    records,
    enums,
    newCustomFields: customs,
    configIssues,
    usesRaw,
    columnNames: columns.map((c) => c.name),
  };
}

export type { ColumnMapping };
