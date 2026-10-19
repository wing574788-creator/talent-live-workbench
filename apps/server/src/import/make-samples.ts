/** 生成导入功能的样例文件：pnpm samples:import（默认输出到 docs/samples/，可传目录参数） */
import fs from 'node:fs';
import path from 'node:path';
import { buildSampleCsvGbk, buildSampleWorkbook } from './sample-data.ts';

const out = path.resolve(
  process.argv[2] ?? path.join(process.cwd(), '..', '..', 'docs', 'samples'),
);
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, '钉钉多维表导出示例.xlsx'), buildSampleWorkbook());
fs.writeFileSync(path.join(out, '达人库-GBK编码.csv'), buildSampleCsvGbk());
console.log(`已生成样例文件：${out}`);
