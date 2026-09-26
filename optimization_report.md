# terX Codebase Optimization Report

> [!NOTE]
> Overall the codebase is well-structured with good patterns already in place (ref-based preview data, rAF-debounced resizing, serialized PTY teardown, safeStorage encryption). The items below are **improvements on an already solid foundation**.

---

## 🔴 High Impact

### 1. `handleDisconnect` recreates closure on every render

[`handleDisconnect`](file:///Users/rahulthekkekara/projects/terX/src/App.tsx#L302-L321) depends on `activeTabs` and `selectedTab`, so it's recreated on every tab switch and every state change. Since it's passed to `TerminalTabs` as `onCloseTab`, every re-creation triggers a full re-render of the entire tab bar + all terminals.

**Fix:** Use functional updaters for `setActiveTabs` and `setSelectedTab` to remove the dependency on their current values:

```diff
- const handleDisconnect = useCallback((tabId: string) => {
-   const newTabs = new Map(activeTabs);
-   newTabs.delete(tabId);
-   setActiveTabs(newTabs);
+ const handleDisconnect = useCallback((tabId: string) => {
+   setActiveTabs((prev) => {
+     const newTabs = new Map(prev);
+     newTabs.delete(tabId);
+
+     setSelectedTab((prevSelected) =>
+       prevSelected === tabId
+         ? (newTabs.size > 0 ? Array.from(newTabs.keys())[0] : null)
+         : prevSelected
+     );
+
+     return newTabs;
+   });

    // Clean preview refs.
    const { [tabId]: _t, ...restText } = tabPreviewTextRef.current;
    tabPreviewTextRef.current = restText;
    const { [tabId]: _r, ...restRaw } = tabPreviewRawRef.current;
    tabPreviewRawRef.current = restRaw;

-   if (selectedTab === tabId) {
-     setSelectedTab(newTabs.size > 0 ? Array.from(newTabs.keys())[0] : null);
-   }

    window.electron?.ipcRenderer.invoke('ssh:disconnect', tabId).catch(...);
- }, [activeTabs, selectedTab]);
+ }, []);
```

### 2. `App.tsx` is a 670-line god component

All state, IPC handlers, window controls, sidebar resize, toasts, shutdown overlay, and close-all confirmation live in one component. This causes **every state change to re-evaluate the entire tree**.

**Recommended extraction:**
| Extract | What it holds |
|---|---|
| `useSidebarResize()` hook | `sidebarWidth`, `isResizingSidebar`, `isSidebarHidden`, mouse handlers |
| `useWindowControls()` hook | `isWindowMaximized`, minimize/maximize/close/settings handlers |
| `useToasts()` hook | `toasts`, `showToast`, `dismissToast` |
| `<ShutdownOverlay />` | shutdown state + IPC listener |
| `<CloseAllConfirmModal />` | the close-all dialog |

This won't change behavior but will reduce re-render blast radius and improve readability.

### 3. `ConnectionManager` has a stale-state footgun

[`localConnections`](file:///Users/rahulthekkekara/projects/terX/src/components/ConnectionManager.tsx#L66) is a local copy of `connections` synced via `useEffect`. This creates a **two-source-of-truth problem** — after a drag-reorder, `localConnections` diverges from `connections` until the IPC round-trip completes and the parent re-renders. Race conditions can lose edits.

**Fix:** Lift the reorder logic into `App.tsx` (or use a reducer) so there's a single source of truth. Pass an `onReorder` callback instead of persisting from within `ConnectionManager`.

---

## 🟡 Medium Impact

### 4. `TerminalTabs` re-renders all tabs on every tab switch

[`tabArray`](file:///Users/rahulthekkekara/projects/terX/src/components/TerminalTabs.tsx#L182) is recalculated via `Array.from(tabs.entries())` on every render — since `tabs` is a `Map` (reference changes on every mutation), this triggers a new array allocation each time. Combined with the inline `style` objects on each tab wrapper ([L409-L418](file:///Users/rahulthekkekara/projects/terX/src/components/TerminalTabs.tsx#L409-L418)), every tab switch causes all tab wrapper divs to re-render.

**Fix:** Memoize `tabArray` and extract the tab wrapper into a `React.memo` component.

### 5. Terminal theme config is duplicated

The xterm theme object is defined identically in both [`Terminal.tsx`](file:///Users/rahulthekkekara/projects/terX/src/components/Terminal.tsx#L80-L103) and [`TerminalTabs.tsx` (MiniTerminalGhost)](file:///Users/rahulthekkekara/projects/terX/src/components/TerminalTabs.tsx#L80-L99). Any color change needs updating in two places.

**Fix:** Extract to a shared constant:
```ts
// src/shared/terminal-theme.ts
export const TERMINAL_THEME: ITheme = { background: '#0C0C0C', ... };
```

### 6. `handleConnect` / `handleConnectDuplicate` are nearly identical

[`handleConnect`](file:///Users/rahulthekkekara/projects/terX/src/App.tsx#L244-L275) and [`handleConnectDuplicate`](file:///Users/rahulthekkekara/projects/terX/src/App.tsx#L277-L300) share ~90% of their code. The only difference is that `handleConnect` checks for an existing tab first.

**Fix:** Consolidate into a single function with an `allowDuplicate` parameter.

### 7. `findConnectionKeyByTabId` does a redundant lookup

```ts
function findConnectionKeyByTabId(tabId: string): string | undefined {
  return Array.from(activeConnections.keys()).find((key) => key === tabId);
}
```

This allocates an array of all keys and iterates it just to check if `tabId` exists. Since the key **is** the tabId, this is equivalent to:

```ts
function findConnectionKeyByTabId(tabId: string): string | undefined {
  return activeConnections.has(tabId) ? tabId : undefined;
}
```

### 8. `ConnectionForm` / `ConnectionManager` import from wrong path

Both import `ConnectionProfile` from `'../../utils/encryption'` — a main-process module that re-exports from `shared/types`. This works because Vite bundles the renderer separately, but the import path is misleading and could break if tree-shaking gets stricter.

**Fix:** Import directly from `'../shared/types'`.

---

## 🟢 Low Impact / Polish

### 9. TypeScript version is very old

[`package.json`](file:///Users/rahulthekkekara/projects/terX/package.json#L47) pins `typescript@^4.9.0`. Current is **5.x** with better inference, `satisfies`, `const` type parameters, etc. Since you're already on Vite 8 and Electron 42, there's no reason to stay on TS 4.

### 10. `isMac` is evaluated on every render

```ts
const isMac = window.electron?.platform === 'darwin';
```

This never changes at runtime. Make it a module-level constant or a `useMemo(() => ..., [])`.

### 11. Missing `React.memo` on `Terminal`

The `Terminal` component creates a full xterm instance. While the `useEffect` guards prevent re-initialization, wrapping it in `React.memo` would prevent React from even calling the render function when parent state changes with the same props.

### 12. `handleReorderTabs` is not memoized

[`handleReorderTabs`](file:///Users/rahulthekkekara/projects/terX/src/App.tsx#L373-L393) and several other handlers (`handleConnect`, `handleConnectDuplicate`, `handleDisconnectAll`) are plain functions, recreated on every render. They should be wrapped in `useCallback`.

### 13. IPC handler duplication in `registerSSHHandlers`

The `removeHandler`/`removeAllListeners` calls at the top of [`registerSSHHandlers`](file:///Users/rahulthekkekara/projects/terX/src/utils/ssh.ts#L147-L154) are a code smell — they exist because the function can be called twice (on `ready` and `activate`). Consider guarding with a `let registered = false` flag instead.

---

## Summary

| Priority | Item | Effort |
|---|---|---|
| 🔴 | Fix `handleDisconnect` deps | 10 min |
| 🔴 | Extract hooks from App.tsx | 1-2 hrs |
| 🔴 | Fix ConnectionManager dual state | 30 min |
| 🟡 | Memoize tabArray + tab wrappers | 20 min |
| 🟡 | Extract shared terminal theme | 10 min |
| 🟡 | Consolidate connect handlers | 15 min |
| 🟡 | Fix `findConnectionKeyByTabId` | 5 min |
| 🟡 | Fix import paths | 10 min |
| 🟢 | Upgrade TypeScript to 5.x | 15 min |
| 🟢 | Make `isMac` a constant | 2 min |
| 🟢 | Add `React.memo` to Terminal | 5 min |
| 🟢 | Memoize remaining handlers | 15 min |
| 🟢 | Guard double IPC registration | 5 min |

Want me to start implementing any of these?
