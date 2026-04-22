import { ConnectionProfile, ExportFieldSelection } from './types';

/**
 * Normalizes a partially-defined connection profile from an import file
 * into a complete ConnectionProfile with sensible defaults.
 */
export function normalizeImportedConnection(input: Partial<ConnectionProfile>, fallbackIndex: number): ConnectionProfile {
  return {
    id: typeof input.id === 'string' && input.id.length > 0 ? input.id : `conn-import-${Date.now()}-${fallbackIndex}`,
    name: typeof input.name === 'string' && input.name.length > 0 ? input.name : `Imported Host ${fallbackIndex + 1}`,
    host: typeof input.host === 'string' ? input.host : '',
    port: typeof input.port === 'number' && Number.isFinite(input.port) ? input.port : 22,
    username: typeof input.username === 'string' ? input.username : '',
    description: typeof input.description === 'string' ? input.description : '',
    password: typeof input.password === 'string' ? input.password : undefined,
    privateKeyPath: typeof input.privateKeyPath === 'string' ? input.privateKeyPath : undefined,
    group: typeof input.group === 'string' ? input.group : 'Ungrouped',
    tags: Array.isArray(input.tags) ? input.tags.filter((tag) => typeof tag === 'string') : undefined,
  };
}

/**
 * Projects a connection profile for export, selectively including fields
 * based on the user's field selection.
 */
export function projectConnectionForExport(connection: ConnectionProfile, fields: ExportFieldSelection): Partial<ConnectionProfile> {
  const projected: Partial<ConnectionProfile> = {
    id: connection.id,
    name: connection.name,
    host: connection.host,
    port: connection.port,
    group: connection.group,
    tags: connection.tags,
  };

  if (fields.username) {
    projected.username = connection.username;
  }

  if (fields.description) {
    projected.description = connection.description || '';
  }

  if (fields.password && connection.password) {
    projected.password = connection.password;
  }

  if (fields.privateKeyPath && connection.privateKeyPath) {
    projected.privateKeyPath = connection.privateKeyPath;
  }

  return projected;
}
