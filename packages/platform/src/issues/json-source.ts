const JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

/**
 * Return the exact source token at an object-key path in valid JSON.
 *
 * This scanner is independent of non-standard JSON.parse reviver metadata. It
 * follows JSON object structure, decodes escaped property names, ignores strings
 * and unrelated nested values, and uses the last duplicate key just as JSON.parse
 * does.
 */
export function jsonTokenAtPath(source: string, path: readonly string[]): string | undefined {
  let index = 0;

  const skipWhitespace = (): void => {
    while (index < source.length && JSON_WHITESPACE.has(source[index]!)) index += 1;
  };

  const scanString = (): void => {
    if (source[index] !== '"') throw new SyntaxError("expected JSON string");
    index += 1;
    while (index < source.length) {
      const character = source[index]!;
      index += 1;
      if (character === '"') return;
      if (character === "\\") {
        if (index >= source.length) throw new SyntaxError("unterminated JSON escape");
        index += 1;
      }
    }
    throw new SyntaxError("unterminated JSON string");
  };

  const scanPrimitive = (): void => {
    while (index < source.length) {
      const character = source[index]!;
      if (
        character === "," ||
        character === "]" ||
        character === "}" ||
        JSON_WHITESPACE.has(character)
      ) {
        return;
      }
      index += 1;
    }
  };

  const scanValue = (remainingPath: readonly string[] | undefined): string | undefined => {
    skipWhitespace();
    const start = index;
    const character = source[index];
    let matched: string | undefined;

    if (character === "{") {
      index += 1;
      skipWhitespace();
      if (source[index] !== "}") {
        while (true) {
          skipWhitespace();
          const keyStart = index;
          scanString();
          const key = JSON.parse(source.slice(keyStart, index)) as string;
          skipWhitespace();
          if (source[index] !== ":") throw new SyntaxError("expected JSON object colon");
          index += 1;

          if (remainingPath !== undefined && key === remainingPath[0]) {
            matched = scanValue(remainingPath.slice(1));
          } else {
            scanValue(undefined);
          }

          skipWhitespace();
          if (source[index] === "}") break;
          if (source[index] !== ",") throw new SyntaxError("expected JSON object delimiter");
          index += 1;
        }
      }
      index += 1;
    } else if (character === "[") {
      index += 1;
      skipWhitespace();
      if (source[index] !== "]") {
        while (true) {
          scanValue(undefined);
          skipWhitespace();
          if (source[index] === "]") break;
          if (source[index] !== ",") throw new SyntaxError("expected JSON array delimiter");
          index += 1;
        }
      }
      index += 1;
    } else if (character === '"') {
      scanString();
    } else {
      scanPrimitive();
    }

    return remainingPath?.length === 0 ? source.slice(start, index) : matched;
  };

  const token = scanValue(path);
  skipWhitespace();
  if (index !== source.length) throw new SyntaxError("unexpected trailing JSON source");
  return token;
}
