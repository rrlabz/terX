import React, { useRef, useState } from 'react';
import { ConnectionProfile } from '../../utils/encryption';

interface ConnectionFormProps {
  connection?: ConnectionProfile | null;
  initialGroup?: string;
  onClose: () => void;
  onSubmit: (connection: ConnectionProfile) => Promise<void>;
}

const ConnectionForm: React.FC<ConnectionFormProps> = ({ connection, initialGroup, onClose, onSubmit }) => {
  const backdropMouseDownRef = useRef(false);

  const [formData, setFormData] = useState<ConnectionProfile>(
    connection || {
      id: `conn-${Date.now()}`,
      name: '',
      host: '',
      port: 22,
      username: '',
      description: '',
      group: initialGroup || 'Ungrouped',
    }
  );

  const [authType, setAuthType] = useState<'password' | 'key'>(
    connection?.privateKeyPath ? 'key' : 'password'
  );
  const [formError, setFormError] = useState<string | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    if (name === 'port') {
      const nextPort = Number(value);
      setFormData({
        ...formData,
        port: Number.isFinite(nextPort) ? nextPort : 0,
      });
      return;
    }

    setFormData({
      ...formData,
      [name]: value,
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const normalizedPort = Math.round(Number(formData.port));
    if (!Number.isFinite(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
      setFormError('Port must be a number between 1 and 65535.');
      return;
    }

    const payload: ConnectionProfile = {
      ...formData,
      port: normalizedPort,
    };

    try {
      setFormError(null);
      await window.electron?.ipcRenderer.invoke('connections:save', payload);
      await onSubmit(payload);
    } catch (error) {
      console.error('Failed to save connection:', error);
      setFormError('Failed to save connection. Please try again.');
    }
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        backdropMouseDownRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        const shouldClose = backdropMouseDownRef.current && e.target === e.currentTarget;
        backdropMouseDownRef.current = false;
        if (shouldClose) {
          onClose();
        }
      }}
    >
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0, marginBottom: '16px', fontSize: '14px' }}>
          {connection ? 'Edit Connection' : 'New Connection'}
        </h2>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Connection Name</label>
            <input
              type="text"
              name="name"
              value={formData.name}
              onChange={handleChange}
              placeholder="My Server"
              required
            />
          </div>

          <div className="form-group">
            <label>Group</label>
            <input
              type="text"
              name="group"
              value={formData.group || ''}
              onChange={handleChange}
              placeholder="Production / Staging"
            />
          </div>

          <div className="form-group">
            <label>Description</label>
            <input
              type="text"
              name="description"
              value={formData.description || ''}
              onChange={handleChange}
              placeholder="Short note about this host"
            />
          </div>

          <div style={{ display: 'flex', gap: '12px' }}>
            <div className="form-group" style={{ flex: 1 }}>
              <label>Host</label>
              <input
                type="text"
                name="host"
                value={formData.host}
                onChange={handleChange}
                placeholder="example.com"
                required
              />
            </div>

            <div className="form-group" style={{ flex: 0.5 }}>
              <label>Port</label>
              <input
                type="number"
                name="port"
                value={formData.port}
                onChange={handleChange}
                min="1"
                max="65535"
                required
              />
            </div>
          </div>

          <div className="form-group">
            <label>Username (optional)</label>
            <input
              type="text"
              name="username"
              value={formData.username}
              onChange={handleChange}
              placeholder="root (or leave blank to use Global Username)"
            />
          </div>

          <div className="form-group">
            <label>Authentication</label>
            <select
              value={authType}
              onChange={(e) => setAuthType(e.target.value as 'password' | 'key')}
            >
              <option value="password">Password</option>
              <option value="key">Private Key</option>
            </select>
          </div>

          {authType === 'password' && (
            <div className="form-group">
              <label>Password</label>
              <input
                type="password"
                name="password"
                value={formData.password || ''}
                onChange={handleChange}
                placeholder="Leave blank to prompt on connect"
              />
            </div>
          )}

          {authType === 'key' && (
            <div className="form-group">
              <label>Private Key Path</label>
              <input
                type="text"
                name="privateKeyPath"
                value={formData.privateKeyPath || ''}
                onChange={handleChange}
                placeholder="/home/user/.ssh/id_rsa"
              />
            </div>
          )}

          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit">Save Connection</button>
          </div>
          {formError && (
            <div style={{ marginTop: '10px', color: '#f6a8b0', fontSize: '11px' }} role="alert">
              {formError}
            </div>
          )}
        </form>
      </div>
    </div>
  );
};

export default ConnectionForm;
