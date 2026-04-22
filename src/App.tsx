import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import './App.css';
import ConnectionManager from './components/ConnectionManager';
import TerminalTabs from './components/TerminalTabs';
import { sanitizeTerminalPreview } from './shared/terminal-utils';
import type { ConnectionProfile, ShutdownStatePayload } from './shared/types';

interface ElectronAPI {
  platform?: string;
  ipcRenderer: {
    invoke: (channel: string, ...args: any[]) => Promise<any>;
    send: (channel: string, ...args: any[]) => void;
    on: (channel: string, listener: (event: any, ...args: any[]) => void) => (() => void);
    off: (channel: string, listener: (event: any, ...args: any[]) => void) => void;
    once: (channel: string, listener: (event: any, ...args: any[]) => void) => void;
    removeAllListeners: (channel: string) => void;
  };
}

declare global {
  interface Window {
    electron?: ElectronAPI;
  }
}

interface AppToast {
  id: number;
  type: 'error' | 'success' | 'info';
  message: string;
}

const App: React.FC = () => {
  const MIN_SIDEBAR_WIDTH = 220;
  const MAX_SIDEBAR_WIDTH = 560;

  const [connections, setConnections] = useState<ConnectionProfile[]>([]);
  const [activeTabs, setActiveTabs] = useState<Map<string, ConnectionProfile>>(new Map());
  const [selectedTab, setSelectedTab] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tabPreviewTextRef = useRef<Record<string, string>>({});
  const tabPreviewRawRef = useRef<Record<string, string>>({});
  const [sidebarWidth, setSidebarWidth] = useState<number>(MIN_SIDEBAR_WIDTH);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [isSidebarHidden, setIsSidebarHidden] = useState(false);
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const [terminalScrollback, setTerminalScrollback] = useState<number>(10000);
  const [terminalFontSize, setTerminalFontSize] = useState<number>(12);
  const [showLaunchSplash, setShowLaunchSplash] = useState(true);
  const [initTasksCompleted, setInitTasksCompleted] = useState({
    connections: false,
    settings: false,
    windowState: false,
  });
  const [showCloseAllConfirm, setShowCloseAllConfirm] = useState(false);
  const [shutdownOverlay, setShutdownOverlay] = useState<{ visible: boolean; message: string }>({
    visible: false,
    message: 'Please wait, we are closing SSH connections...',
  });
  const [toasts, setToasts] = useState<AppToast[]>([]);
  const toastIdRef = useRef(0);

  // Stable getter callbacks for preview data. TerminalTabs calls these
  // on-demand (ghost tooltip render) instead of receiving the full data
  // objects as props that would trigger re-renders on every terminal event.
  const getPreviewText = useCallback((tabId: string) => tabPreviewTextRef.current[tabId] || '', []);
  const getPreviewRaw = useCallback((tabId: string) => tabPreviewRawRef.current[tabId] || '', []);

  const showToast = useCallback((type: AppToast['type'], message: string) => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    if (initTasksCompleted.connections && initTasksCompleted.settings && initTasksCompleted.windowState) {
      // Add a tiny artificial delay so it doesn't just flash for 10ms on fast computers
      const minDisplayTimer = window.setTimeout(() => {
        setShowLaunchSplash(false);
      }, 600);
      return () => window.clearTimeout(minDisplayTimer);
    }
  }, [initTasksCompleted]);

  useEffect(() => {
    const handleShutdownState = (_event: any, payload: ShutdownStatePayload) => {
      const nextMessage = (payload?.message || '').trim() || 'Please wait, we are closing SSH connections...';

      setShutdownOverlay({
        visible: true,
        message: nextMessage,
      });
    };

    const cleanup = window.electron?.ipcRenderer.on('app:shutdown-state', handleShutdownState);
    return () => {
      cleanup?.();
    };
  }, []);

  const loadConnections = useCallback(async () => {
    try {
      const result = await window.electron?.ipcRenderer.invoke('connections:load');
      setConnections(result || []);
    } catch (error) {
      console.error('Failed to load connections:', error);
      showToast('error', 'Failed to load connections');
    } finally {
      setInitTasksCompleted((prev) => ({ ...prev, connections: true }));
    }
  }, [showToast]);

  useEffect(() => {
    loadConnections();
  }, [loadConnections]);

  useEffect(() => {
    const syncWindowState = async () => {
      try {
        const result = await window.electron?.ipcRenderer.invoke('window:is-maximized');
        if (result?.success) {
          setIsWindowMaximized(Boolean(result.maximized));
        }
      } catch (error) {
        console.error('Failed to read maximize state:', error);
      } finally {
        setInitTasksCompleted((prev) => ({ ...prev, windowState: true }));
      }
    };

    const handleWindowMaximizedState = (_event: any, payload: any) => {
      setIsWindowMaximized(Boolean(payload?.maximized));
    };

    void syncWindowState();
    const cleanup = window.electron?.ipcRenderer.on('window:maximized-state', handleWindowMaximizedState);

    return () => {
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const result = await window.electron?.ipcRenderer.invoke('settings:load');
        if (result?.success && result?.settings) {
          if (typeof result.settings.terminalScrollback === 'number') {
            setTerminalScrollback(result.settings.terminalScrollback);
          }
          if (typeof result.settings.terminalFontSize === 'number') {
            setTerminalFontSize(result.settings.terminalFontSize);
          }
        }
      } catch (error) {
        console.error('Failed to load settings:', error);
      } finally {
        setInitTasksCompleted((prev) => ({ ...prev, settings: true }));
      }
    };

    const handleSettingsUpdated = (_event: any, settings: any) => {
      if (typeof settings?.terminalScrollback === 'number') {
        setTerminalScrollback(settings.terminalScrollback);
      }
      if (typeof settings?.terminalFontSize === 'number') {
        setTerminalFontSize(settings.terminalFontSize);
      }
    };

    void loadSettings();
    const cleanup = window.electron?.ipcRenderer.on('settings:updated', handleSettingsUpdated);

    return () => {
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    const handleConnectionsUpdated = () => {
      void loadConnections();
    };

    const cleanup = window.electron?.ipcRenderer.on('connections:updated', handleConnectionsUpdated);
    return () => {
      cleanup?.();
    };
  }, [loadConnections]);

  useEffect(() => {
    const handleTerminalData = (_event: any, payload: any) => {
      if (!payload?.tabId || typeof payload?.data !== 'string') {
        return;
      }

      // Write to refs instead of state.  Terminal data events fire hundreds
      // of times per second; triggering React re-renders from each one was
      // the main cause of sluggishness on slower machines.  The preview data
      // is only consumed on-demand by the ghost tooltip via getter callbacks.
      const prevText = tabPreviewTextRef.current[payload.tabId] || '';
      tabPreviewTextRef.current[payload.tabId] = sanitizeTerminalPreview(prevText + payload.data).slice(-1600);

      const prevRaw = tabPreviewRawRef.current[payload.tabId] || '';
      tabPreviewRawRef.current[payload.tabId] = (prevRaw + payload.data).slice(-8000);
    };

    const cleanup = window.electron?.ipcRenderer.on('terminal:data', handleTerminalData);
    return () => {
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    if (!isResizingSidebar) {
      return;
    }

    if (isSidebarHidden) {
      return;
    }

    const handleMouseMove = (event: MouseEvent) => {
      const nextWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, event.clientX));
      setSidebarWidth(nextWidth);
    };

    const handleMouseUp = () => {
      setIsResizingSidebar(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingSidebar, isSidebarHidden]);

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.altKey && event.code === 'Space') {
        event.preventDefault();
        void handleShowWindowMenu();
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown);
    };
  }, []);



  const handleConnect = async (connection: ConnectionProfile) => {
    const existingTabEntry = Array.from(activeTabs.entries()).find(([, tabConnection]) => tabConnection.id === connection.id);
    if (existingTabEntry) {
      setSelectedTab(existingTabEntry[0]);
      setError(null);
      return;
    }

    const tabId = `${connection.id}-${Date.now()}`;
    
    // Initiate SSH connection
    try {
      const result = await window.electron?.ipcRenderer.invoke('ssh:connect', connection, tabId);

      if (!result?.success) {
        setError(result?.error ?? 'Connection failed. Please try again.');
        return;
      }

      setActiveTabs((prevTabs) => {
        const newTabs = new Map(prevTabs);
        newTabs.set(tabId, connection);
        return newTabs;
      });
      setSelectedTab(tabId);
      setError(null);
    } catch (error) {
      const errorMsg = (error as Error).message;
      console.error('Connection failed:', error);
      setError(errorMsg);
    }
  };

  const handleConnectDuplicate = async (connection: ConnectionProfile) => {
    const tabId = `${connection.id}-${Date.now()}`;

    try {
      const result = await window.electron?.ipcRenderer.invoke('ssh:connect', connection, tabId);

      if (!result?.success) {
        setError(result?.error ?? 'Connection failed. Please try again.');
        return;
      }

      setActiveTabs((prevTabs) => {
        const newTabs = new Map(prevTabs);
        newTabs.set(tabId, connection);
        return newTabs;
      });
      setSelectedTab(tabId);
      setError(null);
    } catch (error) {
      const errorMsg = (error as Error).message;
      console.error('Duplicate connection failed:', error);
      setError(errorMsg);
    }
  };

  const handleDisconnect = useCallback((tabId: string) => {
    const newTabs = new Map(activeTabs);
    newTabs.delete(tabId);
    setActiveTabs(newTabs);

    // Clean preview refs.
    const { [tabId]: _t, ...restText } = tabPreviewTextRef.current;
    tabPreviewTextRef.current = restText;
    const { [tabId]: _r, ...restRaw } = tabPreviewRawRef.current;
    tabPreviewRawRef.current = restRaw;

    if (selectedTab === tabId) {
      setSelectedTab(newTabs.size > 0 ? Array.from(newTabs.keys())[0] : null);
    }

    // Fire-and-forget: disconnect in background.
    window.electron?.ipcRenderer.invoke('ssh:disconnect', tabId).catch((error) => {
      console.error('Disconnect failed:', error);
    });
  }, [activeTabs, selectedTab]);

  const handleDisconnectAll = () => {
    const tabIds = Array.from(activeTabs.keys());
    if (tabIds.length === 0) {
      return;
    }

    // Update UI immediately so all tabs disappear at once.
    setActiveTabs(new Map());
    setSelectedTab(null);
    tabPreviewTextRef.current = {};
    tabPreviewRawRef.current = {};
    setShowCloseAllConfirm(false);

    // Fire-and-forget: disconnect all in background.
    tabIds.forEach((tabId) => {
      window.electron?.ipcRenderer.invoke('ssh:disconnect', tabId).catch((error) => {
        console.error(`Disconnect failed for tab ${tabId}:`, error);
      });
    });
  };

  const handleRequestDisconnectAll = () => {
    if (activeTabs.size === 0) {
      return;
    }

    setShowCloseAllConfirm(true);
  };

  const handleReconnectTab = async (tabId: string) => {
    const connection = activeTabs.get(tabId);
    if (!connection) {
      return;
    }

    try {
      const result = await window.electron?.ipcRenderer.invoke('ssh:connect', connection, tabId);
      if (!result?.success) {
        setError(result?.error || 'Reconnect failed');
        return;
      }

      setSelectedTab(tabId);
      setError(null);
    } catch (error) {
      console.error('Reconnect failed:', error);
      setError((error as Error).message);
    }
  };

  const handleReorderTabs = (orderedTabIds: string[]) => {
    setActiveTabs((prevTabs) => {
      const reordered = new Map<string, ConnectionProfile>();

      orderedTabIds.forEach((tabId) => {
        const conn = prevTabs.get(tabId);
        if (conn) {
          reordered.set(tabId, conn);
        }
      });

      // Keep any unexpected leftover tabs to avoid accidental loss.
      prevTabs.forEach((conn, tabId) => {
        if (!reordered.has(tabId)) {
          reordered.set(tabId, conn);
        }
      });

      return reordered;
    });
  };

  const handleMinimizeWindow = async () => {
    try {
      await window.electron?.ipcRenderer.invoke('window:minimize');
    } catch (error) {
      console.error('Failed to minimize window:', error);
    }
  };

  const handleToggleMaximizeWindow = async () => {
    try {
      const result = await window.electron?.ipcRenderer.invoke('window:toggle-maximize');
      if (result?.success) {
        setIsWindowMaximized(Boolean(result.maximized));
      }
    } catch (error) {
      console.error('Failed to toggle maximize:', error);
    }
  };

  const handleCloseWindow = async () => {
    try {
      setShutdownOverlay({
        visible: true,
        message: 'Please wait, we are closing SSH connections...',
      });
      await window.electron?.ipcRenderer.invoke('window:close');
    } catch (error) {
      console.error('Failed to close window:', error);
      setShutdownOverlay((prev) => ({ ...prev, visible: false }));
    }
  };

  const handleOpenSettingsWindow = async () => {
    try {
      await window.electron?.ipcRenderer.invoke('window:open-settings');
    } catch (error) {
      console.error('Failed to open settings window:', error);
    }
  };

  const handleShowWindowMenu = async (x?: number, y?: number) => {
    try {
      await window.electron?.ipcRenderer.invoke('window:show-system-menu', { x, y });
    } catch (error) {
      console.error('Failed to show window menu:', error);
    }
  };

  const sessionSummary = activeTabs.size === 1 ? '1 session active' : `${activeTabs.size} sessions active`;
  const activeConnectionIds = useMemo(() => new Set(Array.from(activeTabs.values()).map((connection) => connection.id)), [activeTabs]);
  const titlebarIconSrc = 'app_icon.ico';
  const isMac = window.electron?.platform === 'darwin';

  return (
    <div className="app">
      {showLaunchSplash && (
        <div className="launch-splash" role="status" aria-live="polite" aria-label="Loading terX">
          <div className="launch-splash-card">
            <img className="launch-splash-icon" src={titlebarIconSrc} alt="" aria-hidden="true" />
            <div className="launch-splash-title">terX</div>
            <div className="launch-splash-subtitle">Preparing secure terminal environment...</div>
            <div className="launch-splash-loader" aria-hidden="true" />
          </div>
        </div>
      )}
      {shutdownOverlay.visible && (
        <div className="shutdown-overlay" role="status" aria-live="polite" aria-label="Closing SSH connections">
          <div className="shutdown-overlay-card">
            <div className="shutdown-overlay-title">Closing Application</div>
            <div className="shutdown-overlay-subtitle">{shutdownOverlay.message}</div>
          </div>
        </div>
      )}
      {showCloseAllConfirm && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Confirm close all tabs"
          onClick={() => setShowCloseAllConfirm(false)}
        >
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0, marginBottom: '10px', fontSize: '14px' }}>Close All Tabs?</h2>
            <p style={{ margin: 0, fontSize: '12px', color: 'var(--ui-text-muted)', lineHeight: 1.5 }}>
              You are about to close {activeTabs.size} open tab{activeTabs.size === 1 ? '' : 's'}. This will disconnect all active SSH sessions.
            </p>
            <div className="form-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowCloseAllConfirm(false)}
              >
                Cancel
              </button>
              <button type="button" onClick={() => { void handleDisconnectAll(); }}>
                Close All
              </button>
            </div>
          </div>
        </div>
      )}
      <header
        className={`app-titlebar${isMac ? ' app-titlebar--mac' : ''}`}
        onDoubleClick={() => {
          void handleToggleMaximizeWindow();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          void handleShowWindowMenu(event.clientX, event.clientY);
        }}
      >
        <div className="app-titlebar-left">
          <img className="app-titlebar-icon" src={titlebarIconSrc} alt="" aria-hidden="true" />
          <div className="app-titlebar-brand-wrap">
            <div className="app-titlebar-brand">terX</div>
            {!isMac && <div className="app-titlebar-subtitle">{sessionSummary}</div>}
          </div>
        </div>
        <div className="app-titlebar-controls">
          {isMac && (
            <div className="app-titlebar-session-mac">{sessionSummary}</div>
          )}
          <button
            className={`titlebar-btn${isMac ? ' titlebar-btn--mac' : ''}`}
            onClick={() => {
              handleRequestDisconnectAll();
            }}
            aria-label="Close all tabs"
            title="Close all tabs"
            disabled={activeTabs.size === 0}
            tabIndex={-1}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="titlebar-btn-icon"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
          <button
            className={`titlebar-btn${isMac ? ' titlebar-btn--mac' : ''}`}
            onClick={() => {
              void handleOpenSettingsWindow();
            }}
            aria-label="Open settings"
            title="Settings"
            tabIndex={-1}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="titlebar-btn-icon"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
          </button>
          {!isMac && (
            <>
              <button
                className="titlebar-btn"
                onClick={() => {
                  void handleMinimizeWindow();
                }}
                aria-label="Minimize window"
                title="Minimize"
                tabIndex={-1}
              >
                <span className="titlebar-btn-icon" aria-hidden="true">−</span>
              </button>
              <button
                className="titlebar-btn"
                onClick={() => {
                  void handleToggleMaximizeWindow();
                }}
                aria-label={isWindowMaximized ? 'Restore window' : 'Maximize window'}
                title={isWindowMaximized ? 'Restore' : 'Maximize'}
                tabIndex={-1}
              >
                <span className="titlebar-btn-icon" aria-hidden="true">{isWindowMaximized ? '❐' : '□'}</span>
              </button>
              <button
                className="titlebar-btn titlebar-btn-close"
                onClick={() => {
                  void handleCloseWindow();
                }}
                aria-label="Close window"
                title="Close"
                tabIndex={-1}
              >
                <span className="titlebar-btn-icon" aria-hidden="true">×</span>
              </button>
            </>
          )}
        </div>
      </header>
      {error && (
        <div className="error-banner">
          <div className="error-content">
            <div className="error-message">{error}</div>
            <button className="error-close" onClick={() => setError(null)}>×</button>
          </div>
        </div>
      )}
      <div className={`app-container ${isResizingSidebar ? 'resizing' : ''}`}>
        {!isSidebarHidden && (
          <>
            <div
              className="sidebar"
              style={{
                width: `${sidebarWidth}px`,
                minWidth: `${MIN_SIDEBAR_WIDTH}px`,
              }}
            >
              <ConnectionManager
                connections={connections}
                onConnect={handleConnect}
                onConnectionsUpdate={loadConnections}
                activeConnectionIds={activeConnectionIds}
                onError={showToast.bind(null, 'error')}
              />
            </div>
            <div
              className="sidebar-resizer"
              onMouseDown={() => setIsResizingSidebar(true)}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize connection manager"
              tabIndex={-1}
            >
              <button
                className="sidebar-toggle-handle"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsSidebarHidden(true);
                  setIsResizingSidebar(false);
                }}
                title="Hide Connection Manager"
                aria-label="Hide Connection Manager"
              >
                {'<'}
              </button>
            </div>
          </>
        )}
        <div className="main-content">
          {isSidebarHidden && (
            <button
              className="sidebar-restore-handle"
              onClick={() => setIsSidebarHidden(false)}
              title="Show Connection Manager"
              aria-label="Show Connection Manager"
            >
              {'>'}
            </button>
          )}
          <TerminalTabs
            tabs={activeTabs}
            selectedTab={selectedTab}
            onSelectTab={setSelectedTab}
            onCloseTab={handleDisconnect}
            onReorderTabs={handleReorderTabs}
            onDuplicateTab={handleConnectDuplicate}
            onReconnectTab={handleReconnectTab}
            getPreviewText={getPreviewText}
            getPreviewRaw={getPreviewRaw}
            scrollback={terminalScrollback}
            fontSize={terminalFontSize}
          />
        </div>
      </div>
      {toasts.length > 0 && (
        <div className="toast-container" aria-live="polite">
          {toasts.map((toast) => (
            <div key={toast.id} className={`toast toast-${toast.type}`} role="alert">
              <span className="toast-message">{toast.message}</span>
              <button className="toast-close" onClick={() => dismissToast(toast.id)} aria-label="Dismiss">×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default App;
