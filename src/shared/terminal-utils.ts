/**
 * Strips ANSI escape sequences, OSC control strings, and non-printable
 * control characters from terminal output so it can be displayed as
 * plain-text preview content (e.g. in tab ghost tooltips).
 *
 * Preserves tab (\t), newline (\n), and carriage return (\r).
 */
export function sanitizeTerminalPreview(text: string): string {
  let output = '';
  let index = 0;

  while (index < text.length) {
    const code = text.charCodeAt(index);

    // Strip ANSI escape sequences and OSC control strings.
    if (code === 27) {
      index += 1;

      if (index < text.length && text[index] === '[') {
        index += 1;
        while (index < text.length) {
          const seqCode = text.charCodeAt(index);
          index += 1;
          if (seqCode >= 64 && seqCode <= 126) {
            break;
          }
        }
        continue;
      }

      if (index < text.length && text[index] === ']') {
        index += 1;
        while (index < text.length && text.charCodeAt(index) !== 7) {
          index += 1;
        }
        if (index < text.length) {
          index += 1;
        }
        continue;
      }

      continue;
    }

    // Strip non-printable control chars except tab/newline/carriage return.
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      index += 1;
      continue;
    }

    output += text[index];
    index += 1;
  }

  return output;
}
