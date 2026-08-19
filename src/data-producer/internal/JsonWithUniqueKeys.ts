function parseJsonWithUniqueKeys(source: string): unknown {
  const inspector = new JsonSyntaxInspector(source);
  inspector.inspect();
  return JSON.parse(source) as unknown;
}

class JsonSyntaxInspector {
  readonly #source: string;
  #position = 0;

  constructor(source: string) {
    this.#source = source;
  }

  inspect(): void {
    this.#skipWhitespace();
    this.#inspectValue();
    this.#skipWhitespace();
    if (this.#position !== this.#source.length) {
      throw new SyntaxError('Unexpected content after JSON value.');
    }
  }

  #inspectValue(): void {
    const character = this.#source[this.#position];
    if (character === '{') {
      this.#inspectObject();
    } else if (character === '[') {
      this.#inspectArray();
    } else if (character === '"') {
      this.#readString();
    } else if (character === 't') {
      this.#readLiteral('true');
    } else if (character === 'f') {
      this.#readLiteral('false');
    } else if (character === 'n') {
      this.#readLiteral('null');
    } else {
      this.#readNumber();
    }
  }

  #inspectObject(): void {
    this.#position += 1;
    this.#skipWhitespace();
    const keys = new Set<string>();
    if (this.#consume('}')) {
      return;
    }

    while (true) {
      const key = this.#readString();
      if (keys.has(key)) {
        throw new SyntaxError('JSON object contained a duplicate key.');
      }

      keys.add(key);
      this.#skipWhitespace();
      this.#expect(':');
      this.#skipWhitespace();
      this.#inspectValue();
      this.#skipWhitespace();
      if (this.#consume('}')) {
        return;
      }

      this.#expect(',');
      this.#skipWhitespace();
    }
  }

  #inspectArray(): void {
    this.#position += 1;
    this.#skipWhitespace();
    if (this.#consume(']')) {
      return;
    }

    while (true) {
      this.#inspectValue();
      this.#skipWhitespace();
      if (this.#consume(']')) {
        return;
      }

      this.#expect(',');
      this.#skipWhitespace();
    }
  }

  #readString(): string {
    const start = this.#position;
    this.#expect('"');
    while (this.#position < this.#source.length) {
      const character = this.#source[this.#position];
      if (character === '"') {
        this.#position += 1;
        return JSON.parse(this.#source.slice(start, this.#position)) as string;
      }

      if (character === '\\') {
        this.#position += 1;
        if (this.#source[this.#position] === 'u') {
          this.#position += 4;
        }
      }

      this.#position += 1;
    }

    throw new SyntaxError('Unterminated JSON string.');
  }

  #readLiteral(literal: string): void {
    if (this.#source.slice(this.#position, this.#position + literal.length) !== literal) {
      throw new SyntaxError('Invalid JSON literal.');
    }

    this.#position += literal.length;
  }

  #readNumber(): void {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      this.#source.slice(this.#position)
    );
    if (match === null) {
      throw new SyntaxError('Invalid JSON value.');
    }

    this.#position += match[0].length;
  }

  #skipWhitespace(): void {
    while (/\s/.test(this.#source[this.#position] ?? '')) {
      this.#position += 1;
    }
  }

  #expect(character: string): void {
    if (!this.#consume(character)) {
      throw new SyntaxError(`Expected ${character} in JSON value.`);
    }
  }

  #consume(character: string): boolean {
    if (this.#source[this.#position] !== character) {
      return false;
    }

    this.#position += 1;
    return true;
  }
}

export default parseJsonWithUniqueKeys;
