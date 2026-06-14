import React, { useEffect, useRef, useState } from 'react';
import { ConnectionProfile } from '../utils/encryption';
import Terminal from './Terminal';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

interface TabDragOverState {
  tabId: string;
  position: 'before' | 'after';
}

interface TerminalTabsProps {
  tabs: Map<string, ConnectionProfile>;
  selectedTab: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onReorderTabs: (orderedTabIds: string[]) => void;
  onDuplicateTab: (connection: ConnectionProfile) => void;
  onReconnectTab: (tabId: string) => void;
  getPreviewText: (tabId: string) => string;
  getPreviewRaw: (tabId: string) => string;
  scrollback: number;
  fontSize: number;
}

interface TabContextMenuState {
  tabId: string;
  x: number;
  y: number;
}

interface TabGhostPreviewState {
  tabId: string;
  x: number;
  y: number;
}

function getPreviewLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function getLastCommandLikeLine(text: string): string {
  const lines = getPreviewLines(text);
  if (lines.length === 0) {
    return 'No command detected yet.';
  }

  // Prefer a prompt-like line first (common shells).
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (/[#$>]\s*\S+/.test(line) || /:\s*~?\/?/.test(line)) {
      return line;
    }
  }

  // Fallback to the latest meaningful line.
  return lines[lines.length - 1];
}

interface MiniTerminalGhostProps {
  tabId: string;
  rawContent: string;
}

const MiniTerminalGhost: React.FC<MiniTerminalGhostProps> = ({ tabId, rawContent }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const prevRawRef = useRef<string>('');

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const term = new XTerm({
      theme: {
        background: '#0C0C0C',
        foreground: '#CCCCCC',
        cursor: '#FFFFFF',
        black: '#0C0C0C',
        red: '#C50F1F',
        green: '#13A10E',
        yellow: '#C19C00',
        blue: '#0037DA',
        magenta: '#881798',
        cyan: '#3A96DD',
        white: '#CCCCCC',
        brightBlack: '#767676',
        brightRed: '#E74856',
        brightGreen: '#16C60C',
        brightYellow: '#F9F1A5',
        brightBlue: '#3B78FF',
        brightMagenta: '#B4009E',
        brightCyan: '#61D6D6',
        brightWhite: '#F2F2F2',
      },
      fontFamily: 'Consolas, "Lucida Console", monospace',
      fontSize: 10,
      lineHeight: 1.15,
      disableStdin: true,
      convertEol: true,
      scrollback: 2000,
      cursorBlink: false,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    try {
      fitAddon.fit();
    } catch (e) {
      // Ignore initial fit errors on hidden or zero-size elements
    }

    termRef.current = term;
    fitRef.current = fitAddon;
    prevRawRef.current = '';

    return () => {
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      prevRawRef.current = '';
    };
  }, [tabId]);

  useEffect(() => {
    const term = termRef.current;
    const fitAddon = fitRef.current;
    if (!term || !fitAddon) {
      return;
    }

    try {
      fitAddon.fit();
    } catch (e) {
      // Ignore
    }
    const previous = prevRawRef.current;

    if (rawContent.startsWith(previous)) {
      const delta = rawContent.slice(previous.length);
      if (delta.length > 0) {
        term.write(delta);
      }
    } else {
      term.clear();
      term.write(rawContent);
    }

    prevRawRef.current = rawContent;
  }, [rawContent]);

  return <div ref={containerRef} className="tab-ghost-terminal" />;
};

const TerminalTabs: React.FC<TerminalTabsProps> = ({
  tabs,
  selectedTab,
  onSelectTab,
  onCloseTab,
  onReorderTabs,
  onDuplicateTab,
  onReconnectTab,
  getPreviewText,
  getPreviewRaw,
  scrollback,
  fontSize,
}) => {
  const HOVER_PREVIEW_DELAY_MS = 200;

  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dragOverState, setDragOverState] = useState<TabDragOverState | null>(null);
  const [contextMenu, setContextMenu] = useState<TabContextMenuState | null>(null);
  const [ghostPreview, setGhostPreview] = useState<TabGhostPreviewState | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const tabElementRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const tabArray = Array.from(tabs.entries());

  useEffect(() => {
    if (!selectedTab) {
      return;
    }

    const activeTabElement = tabElementRefs.current[selectedTab];
    if (!activeTabElement) {
      return;
    }

    activeTabElement.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest',
    });
  }, [selectedTab, tabArray.length]);

  const closeContextMenu = () => {
    setContextMenu(null);
  };

  const hideGhostPreview = () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setGhostPreview(null);
  };

  const scheduleGhostPreview = (tabId: string, x: number, y: number) => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }

    hoverTimerRef.current = window.setTimeout(() => {
      setGhostPreview({ tabId, x, y });
      hoverTimerRef.current = null;
    }, HOVER_PREVIEW_DELAY_MS);
  };

  const reorderTabs = (draggedId: string, targetId: string, position: 'before' | 'after') => {
    const tabIds = tabArray.map(([id]) => id);
    const draggedIndex = tabIds.indexOf(draggedId);
    const targetIndex = tabIds.indexOf(targetId);

    if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) {
      return;
    }

    const reordered = [...tabIds];
    reordered.splice(draggedIndex, 1);

    let insertionIndex = targetIndex;
    if (position === 'after') {
      insertionIndex += 1;
    }
    if (draggedIndex < insertionIndex) {
      insertionIndex -= 1;
    }

    reordered.splice(insertionIndex, 0, draggedId);
    onReorderTabs(reordered);
  };

  return (
    <div
      className="terminal-tabs"
      onClick={() => {
        closeContextMenu();
        hideGhostPreview();
      }}
      onContextMenu={(e) => {
        if (!(e.target as HTMLElement).closest('.tab')) {
          closeContextMenu();
        }
      }}
    >
      <div className="tabs-header">
        {tabArray.map(([tabId, connection]) => (
          <div
            key={tabId}
            ref={(element) => {
              tabElementRefs.current[tabId] = element;
            }}
            className={`tab ${selectedTab === tabId ? 'active' : ''} ${draggingTabId === tabId ? 'dragging' : ''} ${dragOverState?.tabId === tabId ? `drag-over-${dragOverState.position}` : ''}`}
            onClick={() => onSelectTab(tabId)}
            onMouseEnter={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              scheduleGhostPreview(tabId, rect.left, rect.bottom + 6);
            }}
            onMouseLeave={() => {
              if (hoverTimerRef.current !== null) {
                window.clearTimeout(hoverTimerRef.current);
                hoverTimerRef.current = null;
              }
              setGhostPreview(null);
            }}
            draggable={true}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', tabId);
              setDraggingTabId(tabId);
            }}
            onDragEnd={() => {
              setDraggingTabId(null);
              setDragOverState(null);
            }}
            onDragOver={(e) => {
              if (!draggingTabId || draggingTabId === tabId) {
                return;
              }
              e.preventDefault();
              const rect = e.currentTarget.getBoundingClientRect();
              const position = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
              setDragOverState({ tabId, position });
            }}
            onDragLeave={() => {
              if (dragOverState?.tabId === tabId) {
                setDragOverState(null);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (!draggingTabId || draggingTabId === tabId) {
                return;
              }
              const rect = e.currentTarget.getBoundingClientRect();
              const position = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
              reorderTabs(draggingTabId, tabId, position);
              setDragOverState(null);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              onSelectTab(tabId);
              setContextMenu({ tabId, x: e.clientX, y: e.clientY });
            }}
          >
            <span>{connection.name}</span>
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tabId);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {contextMenu && tabs.get(contextMenu.tabId) && (
        <div
          className="tab-context-menu"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="tab-context-item"
            onClick={() => {
              const conn = tabs.get(contextMenu.tabId);
              if (conn) {
                onDuplicateTab(conn);
              }
              closeContextMenu();
            }}
          >
            Duplicate
          </button>
          <button
            className="tab-context-item"
            onClick={() => {
              onReconnectTab(contextMenu.tabId);
              closeContextMenu();
            }}
          >
            Reconnect
          </button>
          <button
            className="tab-context-item"
            onClick={() => {
              onCloseTab(contextMenu.tabId);
              closeContextMenu();
            }}
          >
            Close
          </button>
        </div>
      )}

      {ghostPreview && tabs.get(ghostPreview.tabId) && (
        <div
          className="tab-ghost-preview"
          style={{ left: `${ghostPreview.x}px`, top: `${ghostPreview.y}px` }}
          onMouseEnter={() => {
            if (hoverTimerRef.current !== null) {
              window.clearTimeout(hoverTimerRef.current);
              hoverTimerRef.current = null;
            }
          }}
        >
          <div className="tab-ghost-title-wrap">
            <div className="tab-ghost-title">{tabs.get(ghostPreview.tabId)?.name}</div>
            {tabs.get(ghostPreview.tabId)?.description && (
              <div className="tab-ghost-description">{tabs.get(ghostPreview.tabId)?.description}</div>
            )}
          </div>
          <div className="tab-ghost-command">
            {getLastCommandLikeLine(getPreviewText(ghostPreview.tabId))}
          </div>
          <div className="tab-ghost-body">
            <MiniTerminalGhost
              tabId={ghostPreview.tabId}
              rawContent={getPreviewRaw(ghostPreview.tabId)}
            />
          </div>
        </div>
      )}

      <div className="tab-content">
        {selectedTab ? (
          tabArray.map(([tabId, connection]) => (
            <div
              key={tabId}
              style={{
                display: selectedTab === tabId ? 'block' : 'none',
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                width: '100%',
                height: '100%',
              }}
            >
              <Terminal
                tabId={tabId}
                connectionName={connection.name}
                isActive={selectedTab === tabId}
                scrollback={scrollback}
                fontSize={fontSize}
              />
            </div>
          ))
        ) : (
          <div style={{ textAlign: 'center' }}>
            <p>No active connections</p>
            <p style={{ fontSize: '12px', color: 'var(--ui-text-muted)' }}>
              Double-click or click Connect on a server to start a session
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default TerminalTabs;
