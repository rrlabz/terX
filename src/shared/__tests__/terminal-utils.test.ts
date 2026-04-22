import { sanitizeTerminalPreview } from '../terminal-utils';

describe('sanitizeTerminalPreview', () => {
  it('passes through plain text unchanged', () => {
    expect(sanitizeTerminalPreview('hello world')).toBe('hello world');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeTerminalPreview('')).toBe('');
  });

  it('strips CSI (ANSI escape) sequences', () => {
    expect(sanitizeTerminalPreview('\x1b[32mgreen\x1b[0m')).toBe('green');
  });

  it('strips consecutive CSI sequences', () => {
    expect(sanitizeTerminalPreview('\x1b[1m\x1b[32mbold green\x1b[0m')).toBe('bold green');
  });

  it('strips SGR sequences with multiple parameters', () => {
    expect(sanitizeTerminalPreview('\x1b[38;5;196mred text\x1b[0m')).toBe('red text');
  });

  it('strips OSC sequences (title changes)', () => {
    expect(sanitizeTerminalPreview('\x1b]0;Window Title\x07rest')).toBe('rest');
  });

  it('strips bare escape followed by non-bracket character', () => {
    const result = sanitizeTerminalPreview('\x1bXsome text');
    // Only the ESC byte is consumed; the following 'X' is kept as regular text
    expect(result).toBe('Xsome text');
  });

  it('preserves tab characters', () => {
    expect(sanitizeTerminalPreview('col1\tcol2\tcol3')).toBe('col1\tcol2\tcol3');
  });

  it('preserves newlines and carriage returns', () => {
    expect(sanitizeTerminalPreview('line1\nline2\rline3')).toBe('line1\nline2\rline3');
  });

  it('strips non-printable control characters (0x01-0x08)', () => {
    expect(sanitizeTerminalPreview('a\x01b\x02c\x08d')).toBe('abcd');
  });

  it('strips DEL character (0x7F)', () => {
    expect(sanitizeTerminalPreview('hello\x7fworld')).toBe('helloworld');
  });

  it('strips VT and FF but keeps tab/newline/CR', () => {
    // VT (0x0B) and FF (0x0C) should be stripped
    expect(sanitizeTerminalPreview('a\x0Bb\x0Cc')).toBe('abc');
    // Tab (0x09), LF (0x0A), CR (0x0D) should be kept
    expect(sanitizeTerminalPreview('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('handles mixed content: ANSI sequences + control chars + text', () => {
    const input = '\x1b[32m\x01hello\x1b[0m \x1b]0;title\x07world\x7f';
    expect(sanitizeTerminalPreview(input)).toBe('hello world');
  });

  it('handles unterminated OSC sequence at end of string', () => {
    // OSC without BEL terminator — should consume until end of string
    const result = sanitizeTerminalPreview('prefix\x1b]0;unterminated');
    expect(result).toBe('prefix');
  });

  it('handles cursor movement sequences', () => {
    // CSI A = cursor up, CSI H = cursor position
    expect(sanitizeTerminalPreview('\x1b[5A\x1b[10;20Htext')).toBe('text');
  });

  it('handles erase sequences', () => {
    // CSI 2J = clear screen, CSI K = erase line
    expect(sanitizeTerminalPreview('\x1b[2Jhello\x1b[K')).toBe('hello');
  });
});
