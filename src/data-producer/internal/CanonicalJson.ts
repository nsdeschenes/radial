function canonicalizeJson(value: unknown): string {
  const ancestors = new Set<object>();
  return serialize(value, ancestors);
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'string') {
    assertUnicodeScalarValue(value);
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('JSON numbers must be finite.');
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Unsupported JSON value type ${typeof value}.`);
  }
  if (ancestors.has(value)) {
    throw new TypeError('JSON values must not contain cycles.');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError('JSON arrays must not be sparse.');
        }
        items.push(serialize(value[index], ancestors));
      }
      return `[${items.join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('JSON objects must have a plain object prototype.');
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareUtf16)
      .map(key => {
        assertUnicodeScalarValue(key);
        return `${JSON.stringify(key)}:${serialize(record[key], ancestors)}`;
      })
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertUnicodeScalarValue(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError('JSON strings must not contain lone surrogates.');
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError('JSON strings must not contain lone surrogates.');
    }
  }
}

export default canonicalizeJson;
