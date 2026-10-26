import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { withAuthenticatedTaobaoSession } from '../browser-session.mjs';
import { collectSearchProducts, prepareSearch, searchError } from '../search-products.mjs';

export async function runSearchProducts(opts) {
  if (!opts.out || path.extname(opts.out).toLowerCase() !== '.json') throw searchError('INVALID_OUTPUT', '请指定新的 --out products.json。');
  try { await lstat(opts.out); throw searchError('OUTPUT_EXISTS', '输出已存在，请选择新文件。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const plan = await prepareSearch(opts);
  const report = { schemaVersion: 2, command: 'search products', status: 'running', startedAt: new Date().toISOString(),
    strategy: 'image-and-keyword-batches', deduplicated: false, input: { images: plan.images.map(({ name, sha256 }) => ({ name, sha256 })), keywords: plan.keywords, maxKeywordPages: plan.maxPages },
    scope: '候选召回；图片仅首批已渲染商品，关键词按请求页数；不代表全市场或已确认同款。',
    batches: [], products: [] };
  // Exclusive creation avoids overwriting user files, including dangling symlinks.
  const file = await open(opts.out, 'wx', 0o600);
  const save = async () => {
    report.recordCount = report.products.length;
    const buffer = Buffer.from(JSON.stringify(report, null, 2) + '\n');
    let offset = 0;
    while (offset < buffer.length) { const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset, offset); offset += bytesWritten; }
    await file.truncate(buffer.length); await file.sync();
  };
  try {
    await save();
    await withAuthenticatedTaobaoSession(opts, ({ context }) => collectSearchProducts(context, plan, report, save));
    report.status = 'completed'; report.finishedAt = new Date().toISOString(); await save();
    console.log(JSON.stringify({ status: report.status, out: path.resolve(opts.out), recordCount: report.recordCount, batches: report.batches }, null, 2));
    return report;
  } catch (error) {
    report.status = 'partial'; report.error = { code: error.code || 'SEARCH_FAILED', message: '采集停止；已保存成功批次，请检查命令错误和保留的浏览器页面。' };
    report.finishedAt = new Date().toISOString(); await save();
    console.error(JSON.stringify({ status: report.status, code: report.error.code, out: path.resolve(opts.out), recordCount: report.recordCount }));
    throw error;
  } finally { await file.close(); }
}
