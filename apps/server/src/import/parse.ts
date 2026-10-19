/**
 * 导入文件解析：.xlsx / .xls / .csv，合并单元格展开，CSV 自动识别 GBK 与 UTF-8，表头行识别。
 * 日期单元格保留为 Excel 序列号（不用 cellDates），避免时区造成的差一天；转换交给 transforms.ts。
 */
import iconv from 'iconv-lite';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { DomainError } from '../domain/errors.ts';
import { isEmpty, toText } from './transforms.ts';

export type Cell = string | number | boolean | null;

export interface ParsedSheet {
  name: string;
  /** 行 × 列，已展开合并单元格，去掉尾部空行空列 */
  rows: Cell[][];
  mergedCells: number;
}

export interface ParsedFile {
  fileName: string;
  /** csv 的编码；xlsx 为 null */
  encoding: 'utf-8' | 'gbk' | null;
  sheets: ParsedSheet[];
}

const MAX_BYTES = 30 * 1024 * 1024;
const MAX_ROWS = 20000;

/** CSV 编码识别：带 BOM 或能严格按 UTF-8 解码就用 UTF-8，否则按 GBK（Excel 另存为 CSV 的默认编码）。 */
export function decodeCsv(buf: Buffer): { text: string; encoding: 'utf-8' | 'gbk' } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch {
    return { text: iconv.decode(buf, 'gbk'), encoding: 'gbk' };
  }
}

const norm = (v: unknown): Cell => {
  if (v == null) return null;
  if (typeof v === 'string') {
    const s = v.replace(/\r\n?/g, '\n').trim();
    return s === '' ? null : s;
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return v as Cell;
};

function trim(rows: Cell[][]): Cell[][] {
  let last = rows.length;
  while (last > 0 && rows[last - 1]!.every((c) => c === null)) last--;
  const kept = rows.slice(0, last);
  let width = 0;
  for (const r of kept)
    for (let i = r.length - 1; i >= 0; i--)
      if (r[i] !== null) {
        width = Math.max(width, i + 1);
        break;
      }
  return kept.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? null));
}

function parseWorkbook(buf: Buffer): ParsedSheet[] {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false, cellNF: false, cellText: false });
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name]!;
    const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: true,
    });
    const rows: Cell[][] = raw.map((r) => r.map(norm));
    // 展开合并单元格：区域内所有格子都取左上角的值
    const merges = ws['!merges'] ?? [];
    for (const m of merges) {
      const v = rows[m.s.r]?.[m.s.c] ?? null;
      for (let r = m.s.r; r <= m.e.r; r++) {
        rows[r] ??= [];
        for (let c = m.s.c; c <= m.e.c; c++) rows[r]![c] = v;
      }
    }
    return { name, rows: trim(rows), mergedCells: merges.length };
  });
}

function parseCsv(
  buf: Buffer,
  fileName: string,
): { sheets: ParsedSheet[]; encoding: 'utf-8' | 'gbk' } {
  const { text, encoding } = decodeCsv(buf);
  const res = Papa.parse<string[]>(text, { skipEmptyLines: false });
  const rows: Cell[][] = res.data.map((r) => r.map(norm));
  return {
    sheets: [
      { name: fileName.replace(/\.[^.]+$/, '') || 'Sheet1', rows: trim(rows), mergedCells: 0 },
    ],
    encoding,
  };
}

export function parseFile(buf: Buffer, fileName: string): ParsedFile {
  if (buf.length === 0) throw new DomainError('validation', '文件是空的');
  if (buf.length > MAX_BYTES) throw new DomainError('validation', '文件不能超过 30 MB');
  const ext = fileName.toLowerCase().match(/\.(xlsx|xls|csv)$/)?.[1];
  if (!ext) throw new DomainError('validation', '只支持 .xlsx、.xls、.csv 文件');
  if (ext === 'xlsx' && !(buf[0] === 0x50 && buf[1] === 0x4b)) {
    throw new DomainError(
      'validation',
      '这不是有效的 .xlsx 文件（文件可能已损坏，或者其实是 CSV / 旧版 .xls，请改扩展名后重试）',
    );
  }
  try {
    if (ext === 'csv') {
      const { sheets, encoding } = parseCsv(buf, fileName);
      return check({ fileName, encoding, sheets });
    }
    return check({ fileName, encoding: null, sheets: parseWorkbook(buf) });
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw new DomainError('validation', `无法读取这个文件：${(err as Error).message}`);
  }
}

function check(f: ParsedFile): ParsedFile {
  if (!f.sheets.some((s) => s.rows.length > 0))
    throw new DomainError('validation', '文件里没有任何数据');
  for (const s of f.sheets) {
    if (s.rows.length > MAX_ROWS)
      throw new DomainError('validation', `「${s.name}」超过 ${MAX_ROWS} 行，请拆分后再导入`);
  }
  return f;
}

// ───────────── 表头识别 ─────────────
export interface HeaderGuess {
  /** 表头起始行（0 起） */
  row: number;
  /** 表头占几行（多行表头时 > 1） */
  rows: number;
}

const filled = (r: Cell[]) => r.filter((c) => !isEmpty(c));
const isText = (c: Cell) => typeof c === 'string';

/**
 * 自动推荐表头行：跳过标题行（整行是同一个合并单元格）和说明行，
 * 取前几行里第一行"文字多、内容不重复、下面紧跟着数据"的；上下两行都是文字且上一行有合并分组时判为两行表头。
 */
export function detectHeader(rows: Cell[][]): HeaderGuess {
  const scan = Math.min(rows.length, 15);
  const maxFilled = Math.max(1, ...rows.slice(0, scan).map((r) => filled(r).length));
  for (let i = 0; i < scan; i++) {
    const f = filled(rows[i]!);
    if (f.length < Math.max(2, Math.ceil(maxFilled * 0.6))) continue;
    const distinct = new Set(f.map(toText)).size;
    if (distinct < f.length * 0.8) {
      // 重复很多：可能是合并出来的分组表头，下一行才是真正的列名
      const next = rows[i + 1];
      if (
        next &&
        filled(next).length >= f.length * 0.8 &&
        filled(next).every(isText) &&
        distinct > 1
      )
        return { row: i, rows: 2 };
      continue;
    }
    if (f.filter(isText).length < f.length * 0.8) continue;
    // 上一行是分组表头（有合并）而本行是列名
    const prev = rows[i - 1];
    if (prev) {
      const pf = filled(prev);
      if (
        pf.length >= f.length * 0.8 &&
        new Set(pf.map(toText)).size < pf.length * 0.8 &&
        new Set(pf.map(toText)).size > 1
      ) {
        return { row: i - 1, rows: 2 };
      }
    }
    return { row: i, rows: 1 };
  }
  return { row: 0, rows: 1 };
}

export interface Column {
  index: number;
  name: string;
  /** 前 5 个非空样本 */
  samples: Cell[];
}

/** 把表头行（可多行）合成列名，并取每列前 5 个非空样本 */
export function buildColumns(
  rows: Cell[][],
  header: HeaderGuess,
): { columns: Column[]; dataStart: number } {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const dataStart = header.row + header.rows;
  const seen = new Map<string, number>();
  const columns: Column[] = [];
  for (let c = 0; c < width; c++) {
    const parts: string[] = [];
    for (let h = header.row; h < dataStart; h++) {
      const t = toText(rows[h]?.[c] ?? '').replace(/\s*\n\s*/g, ' ');
      if (t && parts[parts.length - 1] !== t) parts.push(t);
    }
    let name = parts.join('/') || `列${c + 1}`;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    if (n > 1) name = `${name}(${n})`;
    const samples: Cell[] = [];
    for (let r = dataStart; r < rows.length && samples.length < 5; r++) {
      const v = rows[r]?.[c] ?? null;
      if (!isEmpty(v)) samples.push(v);
    }
    columns.push({ index: c, name, samples });
  }
  // 整列没有表头也没有数据的空列去掉
  return {
    columns: columns.filter((c) => !/^列\d+$/.test(c.name) || c.samples.length > 0),
    dataStart,
  };
}

/** 数据行：跳过整行为空的行；rowNo 是 Excel 里的行号（从 1 起），方便用户对照原表 */
export function dataRows(rows: Cell[][], dataStart: number): { rowNo: number; cells: Cell[] }[] {
  const out: { rowNo: number; cells: Cell[] }[] = [];
  for (let r = dataStart; r < rows.length; r++) {
    const cells = rows[r]!;
    if (cells.every((c) => isEmpty(c))) continue;
    out.push({ rowNo: r + 1, cells });
  }
  return out;
}
