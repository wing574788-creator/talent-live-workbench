import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { buildColumns, dataRows, decodeCsv, detectHeader, parseFile, type Cell } from './parse.ts';

type Merge = XLSX.Range;
/** 在内存里生成一个 xlsx / xls，用来测试解析 */
function makeBook(
  sheets: Record<string, { rows: unknown[][]; merges?: Merge[] }>,
  bookType: XLSX.BookType = 'xlsx',
) {
  const wb = XLSX.utils.book_new();
  for (const [name, s] of Object.entries(sheets)) {
    const ws = XLSX.utils.aoa_to_sheet(s.rows);
    if (s.merges) ws['!merges'] = s.merges;
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType }));
}
const m = (r1: number, c1: number, r2: number, c2: number): Merge => ({
  s: { r: r1, c: c1 },
  e: { r: r2, c: c2 },
});

describe('xlsx 解析', () => {
  it('读取多个 sheet，去掉尾部空行空列，单元格去首尾空格，数字保持数字', () => {
    const buf = makeBook({
      达人: {
        rows: [
          ['昵称', '粉丝'],
          ['  小美 ', 12000],
          ['阿花', '1.2万'],
          [null, null],
          [null, null],
        ],
      },
      空表: { rows: [['x']] },
    });
    const f = parseFile(buf, 'a.xlsx');
    expect(f.sheets.map((s) => s.name)).toEqual(['达人', '空表']);
    expect(f.sheets[0]!.rows).toEqual([
      ['昵称', '粉丝'],
      ['小美', 12000],
      ['阿花', '1.2万'],
    ]);
    expect(f.encoding).toBeNull();
  });

  it('Excel 日期单元格保持为序列号，不受时区影响', () => {
    const ws = XLSX.utils.aoa_to_sheet([['日期'], [new Date(Date.UTC(2026, 2, 1))]], {
      cellDates: true,
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'S');
    const buf = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    const cell = parseFile(buf, 'd.xlsx').sheets[0]!.rows[1]![0];
    expect(typeof cell).toBe('number');
    expect(Math.floor(cell as number)).toBe(46082);
  });

  it('合并单元格：区域内每个格子都取左上角的值', () => {
    const buf = makeBook({
      S: {
        rows: [
          ['达人', '合作', '阶段'],
          ['小美', '秋冬款', '洽谈中'],
          [null, '针织专场', '已确认'],
          ['阿花', '基础款', '待建联'],
        ],
        merges: [m(1, 0, 2, 0)],
      },
    });
    const s = parseFile(buf, 'a.xlsx').sheets[0]!;
    expect(s.mergedCells).toBe(1);
    expect(s.rows.map((r) => r[0])).toEqual(['达人', '小美', '小美', '阿花']);
  });

  it('旧版 .xls 也能读', () => {
    const buf = makeBook({ S: { rows: [['昵称'], ['小美']] } }, 'biff8');
    expect(parseFile(buf, 'old.xls').sheets[0]!.rows[1]).toEqual(['小美']);
  });

  it('不支持的类型、空文件、没有数据的文件给出明确提示', () => {
    expect(() => parseFile(Buffer.from('x'), 'a.pdf')).toThrow(/只支持/);
    expect(() => parseFile(Buffer.alloc(0), 'a.xlsx')).toThrow(/空/);
    expect(() => parseFile(makeBook({ S: { rows: [[null]] } }), 'a.xlsx')).toThrow(/没有任何数据/);
    expect(() => parseFile(Buffer.from('not a real workbook at all'), 'a.xlsx')).toThrow();
  });
});

describe('CSV 编码识别', () => {
  const csv = '昵称,平台,粉丝\n小美,红书,12.3w\n阿花,抖音,1.2万\n';

  it('UTF-8、带 BOM 的 UTF-8、GBK 都能正确读出中文', () => {
    const utf8 = Buffer.from(csv, 'utf8');
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]);
    const gbk = iconv.encode(csv, 'gbk');
    expect(decodeCsv(utf8).encoding).toBe('utf-8');
    expect(decodeCsv(bom)).toMatchObject({ encoding: 'utf-8', text: csv });
    expect(decodeCsv(gbk)).toMatchObject({ encoding: 'gbk', text: csv });
    for (const [buf, enc] of [
      [utf8, 'utf-8'],
      [bom, 'utf-8'],
      [gbk, 'gbk'],
    ] as const) {
      const f = parseFile(buf, '达人.csv');
      expect(f.encoding).toBe(enc);
      expect(f.sheets[0]!.rows[1]).toEqual(['小美', '红书', '12.3w']);
      expect(f.sheets[0]!.name).toBe('达人');
    }
  });

  it('带引号和逗号的单元格、Windows 换行', () => {
    const f = parseFile(Buffer.from('名称,备注\r\n"A,B","第一行\r\n第二行"\r\n', 'utf8'), 'x.csv');
    expect(f.sheets[0]!.rows[1]).toEqual(['A,B', '第一行\n第二行']);
  });
});

describe('表头识别', () => {
  it('表头就在第一行', () => {
    expect(
      detectHeader([
        ['昵称', '平台', '粉丝'],
        ['小美', '红书', 1],
        ['阿花', '抖音', 2],
      ]),
    ).toEqual({ row: 0, rows: 1 });
  });

  it('跳过上面的标题行（整行同一个合并单元格）和空行', () => {
    const title = '达人库 2026 年 10 月导出';
    const rows: Cell[][] = [
      [title, title, title],
      [null, null, null],
      ['昵称', '平台', '粉丝'],
      ['小美', '红书', 1],
      ['阿花', '抖音', 2],
    ];
    expect(detectHeader(rows)).toEqual({ row: 2, rows: 1 });
  });

  it('跳过只有一两格的说明行', () => {
    const rows: Cell[][] = [
      ['导出人：王', null, null, null],
      ['昵称', '平台', '粉丝', '评级'],
      ['小美', '红书', 1, 'A'],
      ['阿花', '抖音', 2, 'B'],
    ];
    expect(detectHeader(rows)).toEqual({ row: 1, rows: 1 });
  });

  it('两行表头：上面一行是合并出来的分组，合成"分组/列名"', () => {
    const rows: Cell[][] = [
      ['基本信息', '基本信息', '平台数据', '平台数据'],
      ['昵称', '评级', '粉丝', '场均观看'],
      ['小美', 'A', 12000, 3000],
      ['阿花', 'B', 8000, 1500],
    ];
    const g = detectHeader(rows);
    expect(g).toEqual({ row: 0, rows: 2 });
    const { columns, dataStart } = buildColumns(rows, g);
    expect(columns.map((c) => c.name)).toEqual([
      '基本信息/昵称',
      '基本信息/评级',
      '平台数据/粉丝',
      '平台数据/场均观看',
    ]);
    expect(dataStart).toBe(2);
  });

  it('列名：空表头补"列N"、重名加序号、每列前 5 个非空样本', () => {
    const rows: Cell[][] = [
      ['昵称', '昵称', null, '备注'],
      ['a', 'b', 'x', null],
      ['c', null, null, null],
      ['d', 'e', 'y', null],
      ['e', 'f', null, null],
      ['f', 'g', null, null],
      ['g', 'h', null, null],
    ];
    const { columns } = buildColumns(rows, { row: 0, rows: 1 });
    expect(columns.map((c) => c.name)).toEqual(['昵称', '昵称(2)', '列3', '备注']);
    expect(columns[0]!.samples).toEqual(['a', 'c', 'd', 'e', 'f']);
    expect(columns[2]!.samples).toEqual(['x', 'y']);
  });

  it('数据行跳过空行，行号是 Excel 里的行号', () => {
    const rows: Cell[][] = [['昵称'], ['小美'], [null], ['阿花']];
    expect(dataRows(rows, 1).map((r) => [r.rowNo, r.cells[0]])).toEqual([
      [2, '小美'],
      [4, '阿花'],
    ]);
  });
});
