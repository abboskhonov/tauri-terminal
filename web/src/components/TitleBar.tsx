import { createSignal, onMount, onCleanup, Show } from 'solid-js';
import { getCurrentWindow } from '@tauri-apps/api/window';

export default function TitleBar() {
  const [isMaximized, setIsMaximized] = createSignal(false);
  let dragRegionRef: HTMLDivElement | undefined;

  onMount(() => {
    const appWindow = getCurrentWindow();
    let unlistenResize: (() => void) | undefined;
    let unlistenFocus: (() => void) | undefined;

    const sync = async () => {
      try {
        setIsMaximized(await appWindow.isMaximized());
      } catch {
        // window closing
      }
    };
    sync();

    appWindow.onResized(() => sync()).then((fn) => { unlistenResize = fn; });
    appWindow.onFocusChanged(() => sync()).then((fn) => { unlistenFocus = fn; });

    onCleanup(() => {
      unlistenResize?.();
      unlistenFocus?.();
    });
  });

  const handleMouseDown = async (e: MouseEvent) => {
    if (e.buttons !== 1) return; // only left button
    const appWindow = getCurrentWindow();

    if (e.detail === 2) {
      // Double-click: toggle maximize explicitly (not toggleMaximize to avoid sync bugs)
      e.preventDefault();
      const maximized = await appWindow.isMaximized();
      if (maximized) {
        await appWindow.unmaximize();
        setIsMaximized(false);
      } else {
        await appWindow.maximize();
        setIsMaximized(true);
      }
      return;
    }

    // Single click: start dragging the window
    await appWindow.startDragging();
  };

  const handleMinimize = () => getCurrentWindow().minimize();

  const handleMaximize = async () => {
    const appWindow = getCurrentWindow();
    const maximized = await appWindow.isMaximized();
    if (maximized) {
      await appWindow.unmaximize();
      setIsMaximized(false);
    } else {
      await appWindow.maximize();
      setIsMaximized(true);
    }
  };

  const handleClose = () => getCurrentWindow().close();

  return (
    <div class="flex items-center h-9 shrink-0 select-none">
      {/* Drag region — NO data-tauri-drag-region. We handle drag + dbl-click manually. */}
      <div
        ref={dragRegionRef}
        class="flex flex-1 items-center h-full cursor-default"
        onMouseDown={handleMouseDown}
      >
        <div class="flex items-center gap-2 px-3">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-foreground">
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
          <span class="text-[11px] font-medium text-foreground tracking-wide">OpenCode</span>
        </div>
      </div>

      {/* Window controls */}
      <div class="flex items-center h-full">
        <button
          onClick={handleMinimize}
          class="flex items-center justify-center size-9 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title="Minimize"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>

        <button
          onClick={handleMaximize}
          class="flex items-center justify-center size-9 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title={isMaximized() ? 'Restore' : 'Maximize'}
        >
          <Show when={!isMaximized()} fallback={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="3" width="12" height="12" />
              <rect x="3" y="9" width="12" height="12" />
            </svg>
          }>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="4" y="4" width="16" height="16" />
            </svg>
          </Show>
        </button>

        <button
          onClick={handleClose}
          class="flex items-center justify-center size-9 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
          title="Close"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
