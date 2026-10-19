export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch('/api' + url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error ?? res.statusText, res.status, data?.code);
  return data as T;
}

export async function uploadFile(url: string, file: File) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api' + url, { method: 'POST', body: form });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error ?? res.statusText, res.status, data?.code);
  return data;
}

/** 构造查询串，忽略空值 */
export function qs(params: Record<string, string | number | undefined | null>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** 请求一个会返回文件的接口并触发浏览器下载（GET 或 POST） */
export async function downloadFile(
  method: string,
  url: string,
  body?: unknown,
  fallbackName = '导出.xlsx',
) {
  const res = await fetch('/api' + url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(data?.error ?? res.statusText, res.status, data?.code);
  }
  const cd = res.headers.get('content-disposition') ?? '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/);
  const name = m ? decodeURIComponent(m[1]!) : fallbackName;
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}
