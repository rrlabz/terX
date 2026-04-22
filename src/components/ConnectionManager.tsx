import React, { useState } from 'react';
import { ConnectionProfile } from '../../utils/encryption';
import ConnectionForm from './ConnectionForm';

interface DragState {
  id: string;
  group: string;
}

interface DragOverState {
  id: string;
  position: 'before' | 'after';
}

interface GroupDragState {
  group: string;
}

interface GroupDragOverState {
  group: string;
  position: 'before' | 'after';
}

interface TreeContextMenuState {
  type: 'group' | 'host';
  x: number;
  y: number;
  group?: string;
  hostId?: string;
}

function getClampedMenuPosition(clientX: number, clientY: number): { x: number; y: number } {
  const menuWidth = 210;
  const menuHeight = 140;
  const margin = 8;

  const maxX = Math.max(margin, window.innerWidth - menuWidth - margin);
  const maxY = Math.max(margin, window.innerHeight - menuHeight - margin);

  return {
    x: Math.min(Math.max(margin, clientX), maxX),
    y: Math.min(Math.max(margin, clientY), maxY),
  };
}

interface ConnectionManagerProps {
  connections: ConnectionProfile[];
  onConnect: (connection: ConnectionProfile) => void;
  onConnectionsUpdate: () => void;
  activeConnectionIds: Set<string>;
  onError?: (message: string) => void;
}

const ConnectionManager: React.FC<ConnectionManagerProps> = ({
  connections,
  onConnect,
  onConnectionsUpdate,
  activeConnectionIds,
  onError,
}) => {
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<ConnectionProfile | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [localConnections, setLocalConnections] = useState<ConnectionProfile[]>(connections);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [dragOverState, setDragOverState] = useState<DragOverState | null>(null);
  const [groupDragState, setGroupDragState] = useState<GroupDragState | null>(null);
  const [groupDragOverState, setGroupDragOverState] = useState<GroupDragOverState | null>(null);
  const [contextMenu, setContextMenu] = useState<TreeContextMenuState | null>(null);
  const [newConnectionGroup, setNewConnectionGroup] = useState<string | null>(null);
  const [renameDialogGroup, setRenameDialogGroup] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  React.useEffect(() => {
    setLocalConnections(connections);
  }, [connections]);

  const groupedConnections = localConnections.reduce(
    (acc, conn) => {
      const group = conn.group || 'Ungrouped';
      if (!acc[group]) acc[group] = [];
      acc[group].push(conn);
      return acc;
    },
    {} as Record<string, ConnectionProfile[]>
  );

  const groupOrder = localConnections.reduce((acc, conn) => {
    const group = conn.group || 'Ungrouped';
    if (!acc.includes(group)) {
      acc.push(group);
    }
    return acc;
  }, [] as string[]);

  const orderedGroups = groupOrder
    .map((group) => [group, groupedConnections[group]] as [string, ConnectionProfile[]])
    .filter(([, groupConns]) => Array.isArray(groupConns) && groupConns.length > 0);

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const isSearching = normalizedSearch.length > 0;

  const filteredGroups = orderedGroups
    .map(([group, groupConns]) => {
      if (!isSearching) {
        return { group, groupConns };
      }

      const groupMatches = group.toLowerCase().includes(normalizedSearch);
      if (groupMatches) {
        return { group, groupConns };
      }

      const matchedHosts = groupConns.filter((conn) => {
        const haystack = `${conn.name} ${conn.host} ${conn.username} ${conn.description || ''}`.toLowerCase();
        return haystack.includes(normalizedSearch);
      });

      return { group, groupConns: matchedHosts };
    })
    .filter(({ groupConns }) => groupConns.length > 0);

  const handleAddConnection = () => {
    setNewConnectionGroup(null);
    setEditingConnection(null);
    setIsFormOpen(true);
  };

  const handleAddConnectionToGroup = (group: string) => {
    setNewConnectionGroup(group);
    setEditingConnection(null);
    setIsFormOpen(true);
    setContextMenu(null);
  };

  const handleEditConnection = (conn: ConnectionProfile) => {
    setEditingConnection(conn);
    setIsFormOpen(true);
  };

  const handleFormClose = () => {
    setIsFormOpen(false);
    setEditingConnection(null);
    setNewConnectionGroup(null);
  };

  const handleFormSubmit = async () => {
    handleFormClose();
    onConnectionsUpdate();
  };

  const persistConnectionOrder = async (updated: ConnectionProfile[]) => {
    try {
      await window.electron?.ipcRenderer.invoke('connections:save-all', updated);
    } catch (error) {
      console.error('Failed to persist reordered connections:', error);
      onError?.('Failed to save connection order');
    }
  };

  const persistConnections = async (updated: ConnectionProfile[]) => {
    try {
      await window.electron?.ipcRenderer.invoke('connections:save-all', updated);
      setLocalConnections(updated);
      onConnectionsUpdate();
    } catch (error) {
      console.error('Failed to persist connections:', error);
      onError?.('Failed to save connections');
    }
  };

  const openRenameGroupDialog = (oldGroup: string) => {
    setRenameDialogGroup(oldGroup);
    setRenameValue(oldGroup);
    setContextMenu(null);
  };

  const applyRenameGroup = async () => {
    if (!renameDialogGroup) {
      return;
    }

    const oldGroup = renameDialogGroup;
    const nextGroup = renameValue.trim();
    if (!nextGroup || nextGroup === oldGroup) {
      setRenameDialogGroup(null);
      setRenameValue('');
      return;
    }

    const updated = localConnections.map((conn) => {
      const currentGroup = conn.group || 'Ungrouped';
      if (currentGroup !== oldGroup) {
        return conn;
      }
      return { ...conn, group: nextGroup };
    });

    await persistConnections(updated);
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(oldGroup)) {
        next.delete(oldGroup);
        next.add(nextGroup);
      }
      return next;
    });
    setRenameDialogGroup(null);
    setRenameValue('');
  };

  const deleteHost = async (hostId: string) => {
    const target = localConnections.find((conn) => conn.id === hostId);
    if (!target) {
      setContextMenu(null);
      return;
    }

    try {
      await window.electron?.ipcRenderer.invoke('connections:delete', hostId);
      const updated = localConnections.filter((conn) => conn.id !== hostId);
      setLocalConnections(updated);
      if (selectedConnectionId === hostId) {
        setSelectedConnectionId(null);
      }
      onConnectionsUpdate();
    } catch (error) {
      console.error('Failed to delete host:', error);
    }

    setContextMenu(null);
  };

  const reorderWithinGroup = (draggedId: string, targetId: string, group: string, position: 'before' | 'after') => {
    const groupConnections = localConnections.filter((conn) => (conn.group || 'Ungrouped') === group);
    const draggedIndex = groupConnections.findIndex((conn) => conn.id === draggedId);
    const targetIndex = groupConnections.findIndex((conn) => conn.id === targetId);

    if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) {
      return;
    }

    const reorderedGroup = [...groupConnections];
    const [draggedConn] = reorderedGroup.splice(draggedIndex, 1);
    let insertionIndex = targetIndex;
    if (position === 'after') {
      insertionIndex += 1;
    }
    if (draggedIndex < insertionIndex) {
      insertionIndex -= 1;
    }
    reorderedGroup.splice(insertionIndex, 0, draggedConn);

    let groupPointer = 0;
    const updatedConnections = localConnections.map((conn) => {
      if ((conn.group || 'Ungrouped') !== group) {
        return conn;
      }
      const nextConn = reorderedGroup[groupPointer];
      groupPointer += 1;
      return nextConn;
    });

    setLocalConnections(updatedConnections);
    void persistConnectionOrder(updatedConnections);
  };

  const reorderGroups = (draggedGroup: string, targetGroup: string, position: 'before' | 'after') => {
    const currentOrder = [...groupOrder];
    const draggedIndex = currentOrder.indexOf(draggedGroup);
    const targetIndex = currentOrder.indexOf(targetGroup);

    if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) {
      return;
    }

    const reorderedGroups = [...currentOrder];
    reorderedGroups.splice(draggedIndex, 1);

    let insertionIndex = targetIndex;
    if (position === 'after') {
      insertionIndex += 1;
    }
    if (draggedIndex < insertionIndex) {
      insertionIndex -= 1;
    }

    reorderedGroups.splice(insertionIndex, 0, draggedGroup);

    const updatedConnections = reorderedGroups.flatMap((group) =>
      localConnections.filter((conn) => (conn.group || 'Ungrouped') === group)
    );

    setLocalConnections(updatedConnections);
    void persistConnectionOrder(updatedConnections);
  };

  const toggleGroup = (groupName: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupName)) {
        next.delete(groupName);
      } else {
        next.add(groupName);
      }
      return next;
    });
  };

  const selectedConnection = localConnections.find((conn) => conn.id === selectedConnectionId) || null;
  const contextHost = contextMenu?.hostId
    ? localConnections.find((conn) => conn.id === contextMenu.hostId)
    : null;

  const openGroupContextMenu = (e: React.MouseEvent, group: string) => {
    const pos = getClampedMenuPosition(e.clientX, e.clientY);
    setContextMenu({ type: 'group', group, x: pos.x, y: pos.y });
  };

  const openHostContextMenu = (e: React.MouseEvent, hostId: string) => {
    const pos = getClampedMenuPosition(e.clientX, e.clientY);
    setContextMenu({ type: 'host', hostId, x: pos.x, y: pos.y });
  };

  return (
    <div
      className="connection-manager"
      onClick={() => setContextMenu(null)}
      onContextMenu={(e) => {
        if (!(e.target as HTMLElement).closest('.tree-group-row, .tree-host-row')) {
          setContextMenu(null);
        }
      }}
    >
      <div style={{ marginBottom: '8px' }}>
        <button
          className="new-connection-button"
          onClick={handleAddConnection}
          style={{ width: '100%' }}
          title="New Connection"
          aria-label="New Connection"
        >
          + New
        </button>
      </div>

      <div className="connection-search-wrap">
        <input
          className="connection-search-input"
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setSearchQuery('');
            }
          }}
          placeholder="Search groups and hosts"
        />
      </div>

      <div className="connection-list">
        {filteredGroups.map(({ group, groupConns }) => (
          <div key={group} className="tree-group">
            <div
              className={`tree-row tree-group-row ${groupDragState?.group === group ? 'dragging' : ''} ${groupDragOverState?.group === group ? `drag-over-${groupDragOverState.position}` : ''}`}
              onClick={() => toggleGroup(group)}
              draggable={!isSearching}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', group);
                setGroupDragState({ group });
              }}
              onDragEnd={() => {
                setGroupDragState(null);
                setGroupDragOverState(null);
              }}
              onDragOver={(e) => {
                if (!groupDragState || groupDragState.group === group || isSearching) {
                  return;
                }
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                setGroupDragOverState({ group, position });
              }}
              onDragLeave={() => {
                if (groupDragOverState?.group === group) {
                  setGroupDragOverState(null);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (!groupDragState || groupDragState.group === group || isSearching) {
                  return;
                }
                const rect = e.currentTarget.getBoundingClientRect();
                const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                reorderGroups(groupDragState.group, group, position);
                setGroupDragState(null);
                setGroupDragOverState(null);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                openGroupContextMenu(e, group);
              }}
            >
              <span className="tree-cell tree-toggle">{collapsedGroups.has(group) ? '+' : '-'}</span>
              <span className="tree-cell tree-icon tree-icon-group" />
              <span className="tree-cell tree-label">{group}</span>
              <span className="tree-cell tree-meta">{groupConns.length}</span>
            </div>

            {(!collapsedGroups.has(group) || isSearching) &&
              <div className="tree-children">
                {groupConns.map((conn, index) => (
                  <div
                    key={conn.id}
                    className={`tree-row tree-host-row ${selectedConnectionId === conn.id ? 'selected' : ''} ${activeConnectionIds.has(conn.id) ? 'active' : ''} ${index === groupConns.length - 1 ? 'last-child' : ''} ${dragOverState?.id === conn.id ? `drag-over-${dragOverState.position}` : ''}`}
                    onClick={() => setSelectedConnectionId(conn.id)}
                    onDoubleClick={() => onConnect(conn)}
                    draggable={!isSearching}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', conn.id);
                      setDragState({ id: conn.id, group });
                    }}
                    onDragEnd={() => {
                      setDragState(null);
                      setDragOverState(null);
                    }}
                    onDragOver={(e) => {
                      if (!dragState || dragState.group !== group || dragState.id === conn.id || isSearching) {
                        return;
                      }
                      e.preventDefault();
                      const rect = e.currentTarget.getBoundingClientRect();
                      const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                      setDragOverState({ id: conn.id, position });
                    }}
                    onDragLeave={() => {
                      if (dragOverState?.id === conn.id) {
                        setDragOverState(null);
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (!dragState || dragState.group !== group || dragState.id === conn.id || isSearching) {
                        return;
                      }
                      const rect = e.currentTarget.getBoundingClientRect();
                      const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                      reorderWithinGroup(dragState.id, conn.id, group, position);
                      setDragState(null);
                      setDragOverState(null);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setSelectedConnectionId(conn.id);
                      openHostContextMenu(e, conn.id);
                    }}
                    title={`${conn.username}@${conn.host}:${conn.port}`}
                  >
                    <span className="tree-cell tree-toggle" />
                    <span className="tree-cell tree-icon tree-icon-host" />
                    <span className="tree-cell tree-label">{conn.name}</span>
                    <span className="tree-cell tree-meta">
                      {activeConnectionIds.has(conn.id) ? (
                        <span className="tree-active-indicator" title="Active session" aria-label="Active session">▶</span>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>}
          </div>
        ))}
        {connections.length === 0 && (
          <div style={{ padding: '20px', textAlign: 'center', color: 'var(--ui-text-muted)', fontSize: '12px' }}>
            No connections yet. Create one to get started.
          </div>
        )}
        {connections.length > 0 && filteredGroups.length === 0 && (
          <div style={{ padding: '20px', textAlign: 'center', color: 'var(--ui-text-muted)', fontSize: '12px' }}>
            No groups or hosts match your search.
          </div>
        )}
      </div>

      {contextMenu && (
        <div
          className="tree-context-menu"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.type === 'group' && contextMenu.group && (
            <>
              <div className="tree-context-header">Group: {contextMenu.group}</div>
              <button className="tree-context-item" onClick={() => openRenameGroupDialog(contextMenu.group!)}>
                <span>Rename Group</span>
              </button>
              <button className="tree-context-item" onClick={() => handleAddConnectionToGroup(contextMenu.group!)}>
                <span>New Connection In Group</span>
              </button>
            </>
          )}

          {contextMenu.type === 'host' && contextMenu.hostId && (
            <>
              <div className="tree-context-header">Host: {contextHost?.name || 'Selected Host'}</div>
              <button className="tree-context-item danger" onClick={() => void deleteHost(contextMenu.hostId!)}>
                <span>Delete Host</span>
                <span className="tree-context-hint">Del</span>
              </button>
            </>
          )}
        </div>
      )}

      {renameDialogGroup && (
        <div className="modal-overlay" onClick={() => setRenameDialogGroup(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0, marginBottom: '14px', fontSize: '13px' }}>Rename Group</h2>
            <div className="form-group" style={{ marginBottom: '10px' }}>
              <label>New Group Name</label>
              <input
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void applyRenameGroup();
                  }
                }}
              />
            </div>
            <div className="form-actions" style={{ marginTop: '12px' }}>
              <button type="button" className="btn-secondary" onClick={() => setRenameDialogGroup(null)}>
                Cancel
              </button>
              <button type="button" onClick={() => void applyRenameGroup()}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="connection-details-pane">
        <div className="details-title">Details</div>
        {selectedConnection ? (
          <>
            <div className="details-row">
              <span className="details-label">Name</span>
              <span className="details-value">{selectedConnection.name}</span>
            </div>
            <div className="details-row">
              <span className="details-label">Host</span>
              <span className="details-value">{selectedConnection.host}</span>
            </div>
            <div className="details-row">
              <span className="details-label">Port</span>
              <span className="details-value">{selectedConnection.port}</span>
            </div>
            <div className="details-row">
              <span className="details-label">Description</span>
              <span className="details-value">{selectedConnection.description || 'No description'}</span>
            </div>
            <div className="details-actions">
              <button
                style={{ flex: 1, padding: '5px 7px', fontSize: '10px' }}
                onClick={() => onConnect(selectedConnection)}
              >
                Connect
              </button>
              <button
                className="btn-secondary"
                style={{ flex: 1, padding: '5px 7px', fontSize: '10px' }}
                onClick={() => handleEditConnection(selectedConnection)}
              >
                Edit
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="details-empty">Select a host to view details</div>
            <div className="details-actions">
              <button style={{ flex: 1, padding: '5px 7px', fontSize: '10px' }} disabled>
                Connect
              </button>
              <button className="btn-secondary" style={{ flex: 1, padding: '5px 7px', fontSize: '10px' }} disabled>
                Edit
              </button>
            </div>
          </>
        )}
      </div>

      {isFormOpen && (
        <ConnectionForm
          connection={editingConnection}
          initialGroup={newConnectionGroup || undefined}
          onClose={handleFormClose}
          onSubmit={handleFormSubmit}
        />
      )}
    </div>
  );
};

export default React.memo(ConnectionManager);
