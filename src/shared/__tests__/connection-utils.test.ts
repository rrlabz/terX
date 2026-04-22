import { normalizeImportedConnection, projectConnectionForExport } from '../connection-utils';
import { ConnectionProfile } from '../types';

describe('normalizeImportedConnection', () => {
  it('returns a valid profile from completely empty input', () => {
    const result = normalizeImportedConnection({}, 0);
    expect(result.name).toBe('Imported Host 1');
    expect(result.host).toBe('');
    expect(result.port).toBe(22);
    expect(result.username).toBe('');
    expect(result.group).toBe('Ungrouped');
    expect(result.id).toMatch(/^conn-import-\d+-0$/);
  });

  it('preserves all valid fields when provided', () => {
    const input: Partial<ConnectionProfile> = {
      id: 'test-id',
      name: 'My Server',
      host: '192.168.1.1',
      port: 2222,
      username: 'admin',
      description: 'Production server',
      password: 'secret',
      privateKeyPath: '/home/user/.ssh/id_rsa',
      group: 'Production',
      tags: ['web', 'linux'],
    };
    const result = normalizeImportedConnection(input, 0);
    expect(result).toEqual(input);
  });

  it('uses fallback name with 1-indexed fallbackIndex', () => {
    const result = normalizeImportedConnection({}, 5);
    expect(result.name).toBe('Imported Host 6');
  });

  it('generates unique id incorporating fallback index', () => {
    const result = normalizeImportedConnection({}, 3);
    expect(result.id).toMatch(/^conn-import-\d+-3$/);
  });

  it('defaults port to 22 for NaN', () => {
    const result = normalizeImportedConnection({ port: NaN }, 0);
    expect(result.port).toBe(22);
  });

  it('defaults port to 22 for Infinity', () => {
    const result = normalizeImportedConnection({ port: Infinity }, 0);
    expect(result.port).toBe(22);
  });

  it('defaults port to 22 for negative Infinity', () => {
    const result = normalizeImportedConnection({ port: -Infinity }, 0);
    expect(result.port).toBe(22);
  });

  it('accepts valid port numbers', () => {
    expect(normalizeImportedConnection({ port: 22 }, 0).port).toBe(22);
    expect(normalizeImportedConnection({ port: 443 }, 0).port).toBe(443);
    expect(normalizeImportedConnection({ port: 65535 }, 0).port).toBe(65535);
  });

  it('filters non-string tags', () => {
    const result = normalizeImportedConnection({
      tags: ['valid', 123 as any, 'also-valid', null as any, undefined as any],
    }, 0);
    expect(result.tags).toEqual(['valid', 'also-valid']);
  });

  it('returns undefined tags when input has no tags', () => {
    const result = normalizeImportedConnection({}, 0);
    expect(result.tags).toBeUndefined();
  });

  it('returns undefined password when not provided', () => {
    const result = normalizeImportedConnection({}, 0);
    expect(result.password).toBeUndefined();
  });

  it('returns undefined privateKeyPath when not provided', () => {
    const result = normalizeImportedConnection({}, 0);
    expect(result.privateKeyPath).toBeUndefined();
  });

  it('uses empty string for empty-string id (generates new one)', () => {
    const result = normalizeImportedConnection({ id: '' }, 0);
    expect(result.id).toMatch(/^conn-import-/);
  });

  it('uses empty string for empty-string name (generates fallback)', () => {
    const result = normalizeImportedConnection({ name: '' }, 0);
    expect(result.name).toBe('Imported Host 1');
  });
});

describe('projectConnectionForExport', () => {
  const fullConnection: ConnectionProfile = {
    id: 'test-1',
    name: 'Server A',
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    description: 'Main server',
    password: 'secret123',
    privateKeyPath: '/keys/id_rsa',
    group: 'Production',
    tags: ['linux', 'web'],
  };

  it('always includes id, name, host, port, group, and tags', () => {
    const result = projectConnectionForExport(fullConnection, {});
    expect(result.id).toBe('test-1');
    expect(result.name).toBe('Server A');
    expect(result.host).toBe('10.0.0.1');
    expect(result.port).toBe(22);
    expect(result.group).toBe('Production');
    expect(result.tags).toEqual(['linux', 'web']);
  });

  it('excludes optional fields when not selected', () => {
    const result = projectConnectionForExport(fullConnection, {});
    expect(result.username).toBeUndefined();
    expect(result.description).toBeUndefined();
    expect(result.password).toBeUndefined();
    expect(result.privateKeyPath).toBeUndefined();
  });

  it('includes username when selected', () => {
    const result = projectConnectionForExport(fullConnection, { username: true });
    expect(result.username).toBe('root');
  });

  it('includes description when selected', () => {
    const result = projectConnectionForExport(fullConnection, { description: true });
    expect(result.description).toBe('Main server');
  });

  it('includes password when selected and present', () => {
    const result = projectConnectionForExport(fullConnection, { password: true });
    expect(result.password).toBe('secret123');
  });

  it('omits password when selected but connection has none', () => {
    const noPassword = { ...fullConnection, password: undefined };
    const result = projectConnectionForExport(noPassword, { password: true });
    expect(result.password).toBeUndefined();
  });

  it('includes privateKeyPath when selected and present', () => {
    const result = projectConnectionForExport(fullConnection, { privateKeyPath: true });
    expect(result.privateKeyPath).toBe('/keys/id_rsa');
  });

  it('includes all fields when all selected', () => {
    const result = projectConnectionForExport(fullConnection, {
      username: true,
      description: true,
      password: true,
      privateKeyPath: true,
    });
    expect(result.username).toBe('root');
    expect(result.description).toBe('Main server');
    expect(result.password).toBe('secret123');
    expect(result.privateKeyPath).toBe('/keys/id_rsa');
  });

  it('returns empty description string when selected but connection has none', () => {
    const noDesc = { ...fullConnection, description: undefined };
    const result = projectConnectionForExport(noDesc, { description: true });
    expect(result.description).toBe('');
  });
});
