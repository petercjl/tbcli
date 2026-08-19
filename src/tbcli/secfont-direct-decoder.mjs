import { createHash } from 'node:crypto';

import { assertPageNotVerifying } from './taobao-guard.mjs';

const SECFONT_RUNTIME = Object.freeze({
  loaderUrl: 'https://g.alicdn.com/secdev/secfont/1.0.0/7ij1w4tp/wa.bin',
  dataUrl: 'https://g.alicdn.com/secdev/secfont/1.0.0/7ij1w4tp/1.bin',
  loaderSha256: 'f65c5553d0f199a828c9e8955bce02811f1d5c2891ece96444f24f79260eecfa',
  dataSha256: 'ac5626b20e7c73427e07036973315913d96c5d12e090f2f3f47eeec447ef19cb',
});

// Normalized 32x48 monochrome reference shapes for the digits rendered by the
// pinned 7ij1w4tp secfont runtime. They contain no shop or product data.
const PRICE_GLYPH_TEMPLATES = Object.freeze({
  '0': 'AB/4AAD//4AB///AD///8A////Af///8P////j////5/+B/+f/AH/3/gA/9/wAP/f8AD/3/AA/9/wAH/f8AB///AAf//wAH//8AB///AAf//wAH//8AB///AAf//wAH//8AB///AAf//wAH//8AB///AAf//wAH/f8AB/3/AA/9/wAP/f8AD/3/gA/9/8Af+f/wf/j////4////8H////A////AH///wAf//wAD//4AAD/gA',
  '1': 'AAH//wAH//8AP///A////wf///9////////////////////////////9////8f///wH///wB///gAf//AAH//wAB//8AAf//AAH//wAB//8AAf//AAH//wAB//8AAf//AAH//wAB//8AAf//AAH//wAB//8AAf//AAH//wAB//8AAf//AAH//wAB//8AAf//AAH//wAB//8AAf//AAH//wAB//',
  '2': 'AB/gAAH//4AH//+AD///8B////B////4f////H/4P/z/4B/+/8AP/v/AB/7/gAP+/4AD/gAAA/4AAAP+AAAD/gAAB/4AAAf+AAAP/gAAH/4AAB/8AAA//AAAf/AAAP/wAAH/4AAD/8AAB/+AAAf/gAAf/gAAP/wAAH/4AAD/+AAB/+AAAf/gAAf/gAAP/wAAD/8AAD/+AAB//AAA//gAAP//////////////////////////////////////////',
  '3': 'AA/wAAD//wAD//+AD///4A////Af///4P///+D/4P/x/8B/8f+AH/n/AB/5/wAf+f4AD/gAAA/4AAAP+AAAH/gAAB/4AAAf8AAAP/AAAf/gAB//wAAf/4AAH/8AAB//AAAf/4AAH//AAB//4AAA//AAAD/4AAAf+AAAD/gAAA/4AAAH+AAAB/wAAAf//gAP+f4AD/n/AB/5/4Af+f/Af/n/8f/w////8H///+A////AP///gA///gAH//wAAD8AA',
  '4': 'AAH/4AAB/+AAAf/gAAP/4AAH/+AAB//gAA//4AAP/+AAH//gAB//4AA/3+AAP9/gAH+f4AB/n+AA/x/gAP8f4AH+H+AB/h/gAf4f4AP8H+AH+B/gB/gf4Af4H+AP8B/gH+Af4B/gH+A/4B/gf8Af4H+AH+B/gB/g/4Af4P////////////////////////////////////8AAB/gAAAf4AAAH+AAAB/gAAAf4AAAH+AAAB/gAAAf4AAAH+AAAB/g',
  '5': 'f//+AH////h////4f///+H////h////4f///+H/jwAB/wAAAf8AAAH/AAAB/wAAAf8AAAH/AAAB/wAAAf8AAAH/AAAB/wAAAf9/+AH///4B////gf///8D////g////8P/z//j/wP/4/wAf+AAAH/gAAA/4AAAP+AAAB/wAAAf8AAAH/AAAB/wAAAf4AAAP+/oAD/v+AB/5/wAf+f+Af/n/8//x////4P///+A////AP///gA///gAH//wAAD8AA',
  '6': 'AAH/gAAB/wAAA/8AAAf+AAAH/gAAB/wAAA/8AAAf+AAAP/AAAD/gAAA/4AAAf8AAAP/AAAD/gAAB/4AAA/8AAAP+AAAD/gAAB///AA///4Af///gH///8B////g////8P////n/4H/5/4AP+f8AD/n/AAf9/wAH/f4AA//+AAP//gAD//4AA//+AAP9/wAH/f8AB/3/AA/5/4AP+f/gf/j/+f/4f///4H///+Af///AD///gAf//wAD//wAAA+AA',
  '7': '//H///////////////////////////////////////8AAAP/AAAD/gAAB/4AAAf+AAAP/AAAD/wAAB/4AAAf+AAAH/AAAB/wAAA/8AAAf+AAAH/gAAD/wAAA/8AAAP+AAAH/gAAB/4AAA/8AAAf/AAAH/gAAB/wAAAf8AAAP/AAAH/wAAB/4AAA/8AAAP/AAAD/gAAB/4AAAf+AAAP/gAAD/wAAB/8AAAf+AAAH/AAAD/wAAA/8AAAf+AAAH/gAA',
  '8': 'AAfgAAD//wAB//+AB///4A////AP///wH///+D/4H/w/4A/8f+AH/n/AA/5/gAH+f4AB/n+AAf5/gAH+f8AD/n/AB/4/4Af8P/AP/B////AP///wB///wAP//8AH///gD///8B////g////8f+AH/n/gB/5/wAP+/4AB/v+AAf//gAH//4AB//+AAf//gAH//4AB///AA/5/4Af+f/AP/n/8P/4////8H///+A////AP///gA///gAD//gAAB+AA',
  '9': 'AAfgAAD//wAD///AB///4A////Af///4H///+D/8H/x/8A/+f8AD/n/AA/5/gAH+f4AB/v+AAP7/AAD//wAA//8AAf//gAH/f4AB/n/AA/5/4Af+f/AP/j////4////8H///+A////gD///4A///8AA/v+AAAD/gAAB/wAAAf8AAAf+AAAH/gAAB/wAAA/8AAAf+AAAH/AAAD/wAAB/4AAAf+AAAP+AAAD/gAAB/4AAA/8AAAP+AAAH/gAAD/wAA',
  '.': '/8AAAP/AAAD/wAAA////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
});

export function parseSecfontPrice(value) {
  const match = String(value || '').match(/^\[([A-Za-z0-9_]+)#(\d+)#([A-Za-z0-9+/=]+)#\]$/);
  if (!match) return null;
  return {
    runtimeId: match[1],
    parameter: Number(match[2]),
    payload: match[3],
  };
}

export function normalizeDirectPrice(value) {
  const text = String(value || '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error(`直接还原后的价格格式异常：${text || '(空)'}`);
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0) throw new Error(`直接还原后的价格无效：${text}`);
  return number.toFixed(2);
}

export async function decodeSecfontApiPrices({ page, items, fetchImpl = fetch }) {
  const targets = items
    .map((item) => ({ itemId: String(item.itemId), parsed: parseSecfontPrice(item.encodedPrice) }))
    .filter((entry) => entry.itemId && entry.parsed);
  if (!targets.length) return [];

  await assertPageNotVerifying(page);
  const [loaderBytes, dataBytes] = await Promise.all([
    fetchPinnedResource({
      url: SECFONT_RUNTIME.loaderUrl,
      expectedHash: SECFONT_RUNTIME.loaderSha256,
      maxBytes: 256 * 1024,
      fetchImpl,
    }),
    fetchPinnedResource({
      url: SECFONT_RUNTIME.dataUrl,
      expectedHash: SECFONT_RUNTIME.dataSha256,
      maxBytes: 512 * 1024,
      fetchImpl,
    }),
  ]);
  const result = await page.evaluate(async ({
    targets: inputTargets,
    loaderBase64,
    dataBase64,
    templates,
  }) => {
    const fromBase64 = (encoded) => Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    const unpackBits = (encoded) => {
      const bytes = fromBase64(encoded);
      const bits = [];
      for (let index = 0; index < 32 * 48; index += 1) {
        bits.push((bytes[index >> 3] >> (7 - (index & 7))) & 1);
      }
      return bits;
    };
    const templateBits = Object.fromEntries(
      Object.entries(templates).map(([character, encoded]) => [character, unpackBits(encoded)]),
    );
    const loader = fromBase64(loaderBase64);
    const decoderData = fromBase64(dataBase64);
    const separator = loader.indexOf(0);
    if (separator < 1 || separator > 4096) throw new Error('secfont 运行时格式异常：缺少分隔符');
    const source = new TextDecoder('latin1').decode(loader.slice(0, separator));
    const wasm = loader.slice(separator + 1);
    if (!source.startsWith('function V1(e)') || wasm.length < 8
      || wasm[0] !== 0 || wasm[1] !== 0x61 || wasm[2] !== 0x73 || wasm[3] !== 0x6d) {
      throw new Error('secfont 运行时格式校验失败');
    }
    const createDecoder = Function(`"use strict"; return (${source});`);
    const decodeToSpan = await createDecoder()(wasm);

    const rasterize = (text, fontFamily) => {
      const canvas = document.createElement('canvas');
      canvas.width = 4096;
      canvas.height = 180;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#000';
      context.font = `100px "${String(fontFamily).replaceAll('"', '')}"`;
      context.textBaseline = 'alphabetic';
      context.fillText(text, 10, 120);
      const measuredWidth = context.measureText(text).width;
      if (!Number.isFinite(measuredWidth) || measuredWidth <= 0 || measuredWidth > 3800) {
        throw new Error(`secfont 价格轮廓宽度异常：${measuredWidth}`);
      }
      const image = context.getImageData(0, 0, Math.ceil(measuredWidth) + 20, canvas.height);
      const ink = (x, y) => image.data[(y * image.width + x) * 4] < 128;
      const columnInk = [];
      for (let x = 0; x < image.width; x += 1) {
        let count = 0;
        for (let y = 0; y < image.height; y += 1) count += ink(x, y) ? 1 : 0;
        columnInk.push(count);
      }
      const glyphs = [];
      let start = -1;
      for (let x = 0; x <= columnInk.length; x += 1) {
        if ((columnInk[x] || 0) > 0 && start < 0) start = x;
        if (((columnInk[x] || 0) === 0 || x === columnInk.length) && start >= 0) {
          let minY = image.height;
          let maxY = -1;
          for (let sourceX = start; sourceX < x; sourceX += 1) {
            for (let sourceY = 0; sourceY < image.height; sourceY += 1) {
              if (ink(sourceX, sourceY)) {
                minY = Math.min(minY, sourceY);
                maxY = Math.max(maxY, sourceY);
              }
            }
          }
          const sourceWidth = x - start;
          const sourceHeight = maxY - minY + 1;
          const bits = [];
          for (let targetY = 0; targetY < 48; targetY += 1) {
            for (let targetX = 0; targetX < 32; targetX += 1) {
              const sourceX = start + Math.min(
                sourceWidth - 1,
                Math.floor((targetX + 0.5) * sourceWidth / 32),
              );
              const sourceY = minY + Math.min(
                sourceHeight - 1,
                Math.floor((targetY + 0.5) * sourceHeight / 48),
              );
              bits.push(ink(sourceX, sourceY) ? 1 : 0);
            }
          }
          glyphs.push(bits);
          start = -1;
        }
      }
      return glyphs;
    };
    const classify = (bits) => {
      let best = { character: '', distance: Number.POSITIVE_INFINITY };
      for (const [character, reference] of Object.entries(templateBits)) {
        let different = 0;
        for (let index = 0; index < bits.length; index += 1) {
          if (bits[index] !== reference[index]) different += 1;
        }
        const distance = different / bits.length;
        if (distance < best.distance) best = { character, distance };
      }
      return best;
    };

    const decoded = [];
    for (const target of inputTargets) {
      const binary = atob(target.parsed.payload);
      const span = decodeToSpan(
        target.parsed.runtimeId,
        binary,
        target.parsed.parameter,
        decoderData,
      );
      await document.fonts.ready;
      const glyphs = rasterize(span.textContent, span.style.fontFamily);
      const classified = glyphs.map(classify);
      const maxDistance = Math.max(...classified.map((entry) => entry.distance), 0);
      const price = classified.map((entry) => entry.character).join('');
      if (maxDistance > 0.12 || !/^\d+(?:\.\d{1,2})?$/.test(price)) {
        throw new Error(`商品 ${target.itemId} 的价格轮廓置信度不足，已停止执行`);
      }
      decoded.push({ itemId: target.itemId, price, maxDistance });
    }
    return decoded;
  }, {
    targets,
    loaderBase64: loaderBytes.toString('base64'),
    dataBase64: dataBytes.toString('base64'),
    templates: PRICE_GLYPH_TEMPLATES,
  });
  await assertPageNotVerifying(page);

  if (!Array.isArray(result) || result.length !== targets.length) {
    throw new Error(`secfont 直接还原数量异常：${result?.length || 0}/${targets.length}`);
  }
  return result.map((entry) => ({
    itemId: String(entry.itemId),
    price: normalizeDirectPrice(entry.price),
    confidence: 1 - Number(entry.maxDistance || 0),
  }));
}

async function fetchPinnedResource({
  url,
  expectedHash,
  maxBytes,
  fetchImpl,
}) {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'g.alicdn.com') {
    throw new Error(`拒绝下载非固定官方 secfont 资源：${url}`);
  }
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`secfont 静态资源下载失败：HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > maxBytes) {
    throw new Error(`secfont 静态资源大小异常：${bytes.length}`);
  }
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  if (actualHash !== expectedHash) throw new Error('secfont 静态资源指纹已变化，已停止执行');
  return bytes;
}
