import crypto from 'node:crypto';

export const SKU_GROSS_METHOD = 'platform-sku-gross-kde-v2';
const BOOTSTRAP_REPEATS = 3000;
const round = (value, digits = 6) => Number(value.toFixed(digits));
const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const p = (sorted.length - 1) * q;
  const i = Math.floor(p);
  return sorted[i] + (sorted[Math.min(i + 1, sorted.length - 1)] - sorted[i]) * (p - i);
};
const standardDeviation = (values) => {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1));
};
const bandwidth = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
  return 0.9 * Math.min(standardDeviation(values), iqr / 1.34) * values.length ** -0.2 || 0.01;
};
const uniqueValues = values => [...new Set(values)].sort((a, b) => a - b);
const candidateGrid = (values, peak) => {
  const unique = uniqueValues(values);
  const grid = new Set(unique.map(x => round(x, 3)));
  for (let i = 1; i < unique.length; i++) grid.add(round((unique[i - 1] + unique[i]) / 2, 3));
  for (let x = Math.max(0.001, peak - 0.06); x <= peak + 0.0605; x += 0.001)
    grid.add(round(x, 3));
  return [...grid].sort((a, b) => a - b);
};
const modeAt = (values, h, grid) => {
  const frequencies = new Map();
  for (const value of values) frequencies.set(value, (frequencies.get(value) ?? 0) + 1);
  let best = grid[0], bestDensity = -1;
  for (const x of grid) {
    let density = 0;
    for (const [value, count] of frequencies) {
      const z = (x - value) / h;
      density += count * Math.exp(-0.5 * z * z);
    }
    if (density > bestDensity) { best = x; bestDensity = density; }
  }
  return best;
};
const mainMode = (values) => {
  if (values.length === 1) return values[0];
  const h = bandwidth(values), unique = uniqueValues(values);
  const coarse = [...unique];
  for (let i = 1; i < unique.length; i++) coarse.push((unique[i - 1] + unique[i]) / 2);
  const anchor = modeAt(values, h, coarse);
  const radius = Math.max(h, 0.02), fine = [];
  for (let x = Math.max(0.001, anchor - radius); x <= anchor + radius + 0.0005; x += 0.001)
    fine.push(round(x, 3));
  return modeAt(values, h, fine);
};
const rngFor = key => {
  const seed = crypto.createHash('sha256').update(String(key)).digest().readUInt32LE(0);
  let state = seed || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
};
const bootstrapInterval = (values, peak, key) => {
  const h = bandwidth(values), grid = candidateGrid(values, peak);
  const unique = uniqueValues(values), index = new Map(unique.map((value, i) => [value, i]));
  const kernels = grid.map(x => unique.map(value => {
    const z = (x - value) / h;
    return Math.exp(-0.5 * z * z);
  }));
  const next = rngFor(key), modes = [];
  for (let repeat = 0; repeat < BOOTSTRAP_REPEATS; repeat++) {
    const counts = new Int32Array(unique.length);
    for (let i = 0; i < values.length; i++) counts[index.get(values[Math.floor(next() * values.length)])]++;
    let best = grid[0], bestDensity = -1;
    for (let i = 0; i < grid.length; i++) {
      const kernel = kernels[i];
      let density = 0;
      for (let j = 0; j < counts.length; j++) density += counts[j] * kernel[j];
      if (density > bestDensity) { bestDensity = density; best = grid[i]; }
    }
    modes.push(best);
  }
  modes.sort((a, b) => a - b);
  return [quantile(modes, 0.025), quantile(modes, 0.975)];
};

export function estimatePlatformSkuGrossWeight(weights, { skuKey = '' } = {}) {
  const values = weights.map(Number);
  if (!values.length) return { status: 'no-valid-single-unit-sample', estimateKg: null,
    confidenceScore: null, confidenceLevel: null, sampleCount: 0 };
  if (values.some(x => !Number.isFinite(x) || x <= 0 || x > 100))
    throw new Error('平台 SKU 样本重量必须为有限正数且不超过 100 kg');
  const n = values.length, sorted = [...values].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25), q3 = quantile(sorted, 0.75), iqr = q3 - q1;
  const peak = mainMode(values);
  const ci = n >= 10 ? bootstrapInterval(values, peak, skuKey) : [null, null];
  const tailCount = values.filter(x => x < q1 - 1.5 * iqr || x > q3 + 1.5 * iqr).length;
  const tailFraction = tailCount / n;
  const sizePart = Math.min(1, Math.sqrt(n / 100));
  const precisionPart = ci[0] != null && ci[1] > ci[0]
    ? Math.min(1, 0.05 / ((ci[1] - ci[0]) / peak)) : 1;
  const concentrationPart = iqr > 0 ? Math.min(1, 0.25 / (iqr / peak)) : 1;
  const tailPart = Math.max(0, 1 - tailFraction / 0.20);
  const score = Math.min((sizePart * precisionPart * concentrationPart * tailPart) ** 0.25, sizePart);
  const halfCount = Math.ceil(n * 0.5);
  let low = sorted[0], high = sorted[halfCount - 1], width = high - low;
  for (let i = 1; i + halfCount <= n; i++) {
    const nextWidth = sorted[i + halfCount - 1] - sorted[i];
    if (nextWidth < width) { low = sorted[i]; high = sorted[i + halfCount - 1]; width = nextWidth; }
  }
  return { status: 'estimated', estimateKg: round(peak, 3), confidenceScore: round(score, 3),
    confidenceLevel: score >= 0.85 ? 'high' : score >= 0.60 ? 'medium' : 'low',
    sampleCount: n, ci95LowKg: ci[0] == null ? null : round(ci[0], 3),
    ci95HighKg: ci[1] == null ? null : round(ci[1], 3),
    medianKg: round(quantile(sorted, 0.5), 3),
    meanKg: round(values.reduce((a, b) => a + b, 0) / n, 3),
    iqrKg: round(iqr, 3), shortestHalfLowKg: round(low, 3),
    shortestHalfHighKg: round(high, 3), tailCount, tailFraction: round(tailFraction, 4),
    oneKgShare: round(values.filter(x => x === 1).length / n, 4),
    components: { size: round(sizePart, 4), precision: round(precisionPart, 4),
      concentration: round(concentrationPart, 4), tail: round(tailPart, 4) },
    bootstrapRepeats: n >= 10 ? BOOTSTRAP_REPEATS : 0 };
}
