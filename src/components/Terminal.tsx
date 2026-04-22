import React, { useCallback, useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface TerminalProps {
  tabId: string;
  connectionName: string;
  isActive: boolean;
  scrollback: number;
  fontSize: number;
}

const Terminal: React.FC<TerminalProps> = ({ tabId, connectionName, isActive, scrollback, fontSize }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const isActiveRef = useRef<boolean>(isActive);
  const resizeRafRef = useRef<number | null>(null);
  const lastCopiedSelectionRef = useRef<string>('');

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  const focusTerminal = useCallback(() => {
    if (terminalRef.current) {
      terminalRef.current.focus();
    }
  }, []);

  const fitAndResizeTerminal = useCallback(async () => {
    if (!isActiveRef.current || !fitAddonRef.current || !terminalRef.current) {
      return;
    }

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return;
    }

    try {
      fitAddonRef.current.fit();
      await window.electron?.ipcRenderer.invoke('terminal:resize', {
        tabId,
        cols: terminalRef.current.cols,
        rows: terminalRef.current.rows,
      });
    } catch (error) {
      console.error('Failed to fit/resize terminal:', error);
    }
  }, [tabId]);

  const scheduleFitAndResize = useCallback(() => {
    if (resizeRafRef.current !== null) {
      cancelAnimationFrame(resizeRafRef.current);
    }

    resizeRafRef.current = requestAnimationFrame(() => {
      resizeRafRef.current = null;
      void fitAndResizeTerminal();
    });
  }, [fitAndResizeTerminal]);

  useEffect(() => {
    if (!containerRef.current) return;

    // Initialize xterm
    const term = new XTerm({
      theme: {
        background: '#0C0C0C',
        foreground: '#CCCCCC',
        cursor: '#FFFFFF',
        cursorAccent: '#0C0C0C',
        selectionBackground: '#FFFFFF',
        selectionForeground: '#000000',
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
      fontSize: Math.max(8, Math.min(32, fontSize || 12)),
      lineHeight: 1.2,
      scrollback: Math.max(500, Math.min(200000, scrollback || 10000)),
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    term.open(containerRef.current);
    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Delay initial fit so layout is ready.
    const initialFitTimer = window.setTimeout(() => {
      scheduleFitAndResize();
      if (isActiveRef.current) {
        term.focus();
      }
    }, 100);

    // Handle terminal input
    const inputDisposable = term.onData((input: string) => {
      window.electron?.ipcRenderer.send('terminal:input', { tabId, input });
    });

    const selectionDisposable = term.onSelectionChange(() => {
      const selection = term.getSelection();
      const trimmed = selection?.trim();
      if (!trimmed) {
        return;
      }

      if (trimmed === lastCopiedSelectionRef.current) {
        return;
      }

      lastCopiedSelectionRef.current = trimmed;
      void window.electron?.ipcRenderer.invoke('clipboard:write-text', selection);
    });

    // Listen for terminal data from main process
    const handleTerminalData = (_event: any, data: any) => {
      if (data.tabId === tabId && terminalRef.current) {
        terminalRef.current.write(data.data);
      }
    };

    // Listen for terminal close
    const handleTerminalClosed = (_event: any, data: any) => {
      if (data.tabId === tabId && terminalRef.current) {
        terminalRef.current.write('\n\n[Connection closed]\n');
      }
    };

    const handleTerminalReset = (_event: any, data: any) => {
      if (data.tabId === tabId && terminalRef.current) {
        terminalRef.current.clear();
        terminalRef.current.write('[Reconnecting...]\n');
      }
    };

    const cleanupData = window.electron?.ipcRenderer.on('terminal:data', handleTerminalData);
    const cleanupClosed = window.electron?.ipcRenderer.on('terminal:closed', handleTerminalClosed);
    const cleanupReset = window.electron?.ipcRenderer.on('terminal:reset', handleTerminalReset);

    // Handle window resize
    const handleResize = () => {
      scheduleFitAndResize();
    };

    window.addEventListener('resize', handleResize);

    const observer = new ResizeObserver(() => {
      scheduleFitAndResize();
    });

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => {
      window.clearTimeout(initialFitTimer);
      if (resizeRafRef.current !== null) {
        cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
      }
      inputDisposable.dispose();
      selectionDisposable.dispose();
      window.removeEventListener('resize', handleResize);
      observer.disconnect();
      cleanupData?.();
      cleanupClosed?.();
      cleanupReset?.();
      try {
        term.dispose();
      } catch (e) {
        // Ignore xterm.js dispose errors
      }
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [scheduleFitAndResize, tabId]); // Removed fontSize and scrollback to prevent buffer clearing

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.fontSize = Math.max(8, Math.min(32, fontSize || 12));
      terminalRef.current.options.scrollback = Math.max(500, Math.min(200000, scrollback || 10000));
      scheduleFitAndResize();
    }
  }, [fontSize, scrollback, scheduleFitAndResize]);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    scheduleFitAndResize();
    focusTerminal();
  }, [focusTerminal, isActive, scheduleFitAndResize]);

  return (
    <div
      ref={containerRef}
      onClick={focusTerminal}
      onContextMenu={async (e) => {
        e.preventDefault();
        focusTerminal();

        try {
          const result = await window.electron?.ipcRenderer.invoke('clipboard:read-text');
          const text = result?.text;
          if (typeof text === 'string' && text.length > 0) {
            window.electron?.ipcRenderer.send('terminal:input', { tabId, input: text });
          }
        } catch (error) {
          console.error('Failed to paste clipboard text:', error);
        }
      }}
      tabIndex={0}
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
      }}
    />
  );
};

export default Terminal;
