import type { Domain } from '../domain/index.ts';
import { AiConfigStore } from './config.ts';
import { ModelResolver } from './models.ts';
import { OcrService } from './ocr.ts';
import { AiService } from './service.ts';
import { HomeSummary } from './summary.ts';

/** AI 模块的共享对象：模型配置、模型解析（后面还会挂上会话服务） */
export interface AiContext {
  domain: Domain;
  store: AiConfigStore;
  resolver: ModelResolver;
  service: AiService;
  summary: HomeSummary;
  ocr: OcrService;
}

export function createAiContext(domain: Domain, dataDir: string): AiContext {
  const store = new AiConfigStore(dataDir);
  const ctx = { domain, store, resolver: new ModelResolver(store) } as AiContext;
  ctx.service = new AiService(ctx);
  ctx.summary = new HomeSummary(ctx);
  ctx.ocr = new OcrService();
  return ctx;
}
