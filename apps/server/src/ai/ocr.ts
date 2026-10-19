/**
 * 截图的本地 OCR（PRD 7.1 第 2 条）：图片只在本机识别，识别出来的文字再按外发规则发给模型，图片本身不外发。
 * 选型对比见 docs/DECISIONS.md。目前的引擎：Windows 自带 OCR（零安装、几百毫秒）。
 * 引擎做成可替换的接口，换成别的引擎（如 PaddleOCR）只需要新增一个实现。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DomainError } from '../domain/errors.ts';

export interface OcrEngine {
  readonly name: string;
  /** 这台机器能不能用；不能用时返回原因（给用户看的话） */
  check(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 识别一张图片，返回按行排列的原始文字 */
  recognize(imagePath: string): Promise<string[]>;
}

const CJK = '\\u3400-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f\\uff00-\\uffef';

/**
 * 清理识别结果：Windows OCR 会在汉字之间插空格（"小 美 的"），去掉汉字、全角标点之间的空格；
 * 英文单词、数字和汉字之间的空格保留；数字中间被拆开的小数点（"1 ． 2"）合回去。
 */
export function cleanOcrLines(lines: string[]): string {
  const between = new RegExp(`(?<=[${CJK}])[ \\t]+(?=[${CJK}])`, 'g');
  // 中文标点（、，：等）两边的空格也是识别出来的多余空格
  const punct = '\\u3001-\\u3003\\uff01-\\uff0f\\uff1a-\\uff20\\u3008-\\u3011';
  const aroundPunct = new RegExp(`[ \\t]+(?=[${punct}])|(?<=[${punct}])[ \\t]+`, 'g');
  return lines
    .map((l) =>
      l
        .replace(between, '')
        .replace(aroundPunct, '')
        .replace(/(\d)\s*[．.]\s*(\d)/g, '$1.$2')
        .replace(/[ \t]{2,}/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .join('\n');
}

// ───────────── Windows 自带 OCR ─────────────
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq ('IAsyncOperation' + [char]96 + '1') })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
$lang = New-Object Windows.Globalization.Language 'zh-Hans-CN'
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
if (-not $engine) { Write-Output '__NO_ENGINE__'; exit 0 }
if ($env:WB_OCR_CHECK -eq '1') { Write-Output '__OK__'; exit 0 }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:WB_OCR_IMAGE)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
foreach ($l in $result.Lines) { Write-Output $l.Text }
`;

function runPowerShell(env: Record<string, string>): Promise<string> {
  // -EncodedCommand 用 UTF-16LE 的 Base64：脚本里的中文和引号都不会出问题；图片路径通过环境变量传入，不拼进命令
  const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        env: { ...process.env, ...env },
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout, stderr) =>
        err ? reject(new Error(stderr?.trim() || err.message)) : resolve(stdout),
    );
  });
}

export class WindowsOcr implements OcrEngine {
  readonly name = 'Windows 自带 OCR';

  async check() {
    if (process.platform !== 'win32')
      return { ok: false as const, reason: '这台电脑不是 Windows，没有系统自带的 OCR。' };
    try {
      const out = await runPowerShell({ WB_OCR_CHECK: '1' });
      if (out.includes('__OK__')) return { ok: true as const };
      return {
        ok: false as const,
        reason:
          '系统没有安装简体中文的 OCR 语言包。到 Windows「设置 → 时间和语言 → 语言和区域」添加"中文（简体）"并勾选"OCR"功能后重试。',
      };
    } catch (e) {
      return {
        ok: false as const,
        reason: `调用系统 OCR 失败：${(e as Error).message.slice(0, 120)}`,
      };
    }
  }

  async recognize(imagePath: string) {
    const out = await runPowerShell({ WB_OCR_IMAGE: imagePath });
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && l !== '__NO_ENGINE__');
  }
}

// ───────────── 对外入口 ─────────────
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif']);
const MAX_BYTES = 10 * 1024 * 1024;

export class OcrService {
  constructor(private readonly engine: OcrEngine = new WindowsOcr()) {}

  get engineName() {
    return this.engine.name;
  }

  status() {
    return this.engine.check();
  }

  /** 识别一张截图，返回清理后的文字。图片只写到系统临时目录，识别完立刻删除。 */
  async recognize(
    bytes: Uint8Array,
    mime: string,
  ): Promise<{ text: string; engine: string; lines: number }> {
    if (!IMAGE_TYPES.has(mime))
      throw new DomainError('validation', '请上传 PNG、JPG、WebP 格式的截图');
    if (bytes.byteLength > MAX_BYTES) throw new DomainError('validation', '截图不能超过 10 MB');
    const st = await this.engine.check();
    if (!st.ok) throw new DomainError('validation', st.reason);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ocr-'));
    const file = path.join(
      dir,
      `shot.${mime.split('/')[1] === 'jpeg' ? 'jpg' : mime.split('/')[1]}`,
    );
    try {
      fs.writeFileSync(file, bytes);
      const lines = await this.engine.recognize(file);
      const text = cleanOcrLines(lines);
      if (!text)
        throw new DomainError(
          'validation',
          '没有识别出文字，请换一张更清晰的截图，或直接粘贴文字。',
        );
      return { text, engine: this.engine.name, lines: lines.length };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
