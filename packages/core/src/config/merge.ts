/**
 * Merges a parsed config layer onto a base, validating against the base's shape. Anything unknown or of the
 * wrong type is skipped with a warning, so a bad config can never crash a hook; it just falls back to defaults.
 */
/** Number fields whose default is null (meaning "not configured"). */
const NULLABLE = new Set(['pricing.usd_per_mtok_input']);

export function mergeLayer<T>(base: T, layer: unknown, source: string, warnings: string[]): T {
  if (layer === undefined) return base;
  if (!isPlainObject(layer)) {
    warnings.push(`${source}: expected an object at the top level; ignored`);
    return base;
  }
  return mergeObject(base as Record<string, unknown>, layer, source, '', warnings) as T;
}

function mergeObject(
  base: Record<string, unknown>,
  layer: Record<string, unknown>,
  source: string,
  prefix: string,
  warnings: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(layer)) {
    const where = prefix ? `${prefix}.${key}` : key;
    if (key === '$schema' && prefix === '') continue;
    if (!(key in base)) {
      warnings.push(`${source}: unknown key "${where}"; ignored`);
      continue;
    }
    const current = base[key];
    if (isPlainObject(current)) {
      if (isPlainObject(value)) out[key] = mergeObject(current, value, source, where, warnings);
      else warnings.push(`${source}: "${where}" should be an object; ignored`);
    } else if (Array.isArray(current)) {
      if (Array.isArray(value) && value.every((v) => typeof v === 'string')) out[key] = [...value];
      else warnings.push(`${source}: "${where}" should be a list of strings; ignored`);
    } else if (NULLABLE.has(where)) {
      // Nullable number fields.
      if (value === null || isFiniteNumber(value)) out[key] = value;
      else warnings.push(`${source}: "${where}" should be a number or null; ignored`);
    } else if (typeof current === 'number') {
      if (isFiniteNumber(value) && value >= 0) out[key] = value;
      else warnings.push(`${source}: "${where}" should be a non-negative number; ignored`);
    } else if (typeof value === typeof current) {
      out[key] = value;
    } else {
      warnings.push(`${source}: "${where}" should be a ${typeof current}; ignored`);
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
