import fs from 'node:fs';
import path from 'node:path';

export function resolveShopProductsCheckpointPath({ outPath = '', shopId = '', cachePath = '' } = {}) {
  if (cachePath) return path.resolve(cachePath);
  if (outPath) return `${path.resolve(outPath)}.checkpoint.json`;
  const suffix = String(shopId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '') || 'unknown';
  return path.resolve(`tbcli-shop-products-${suffix}.checkpoint.json`);
}

export function writeShopProductsCheckpoint(file, checkpoint) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify({
    version: 1,
    ...checkpoint,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`;
  fs.writeFileSync(temporary, body, 'utf8');
  fs.renameSync(temporary, target);
  return target;
}
