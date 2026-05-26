import { createSignal, onMount, onCleanup, Show } from 'solid-js';
import { getCurrentWindow } from '@tauri-apps/api/window';

export default function TitleBar() {
  const [isMaximized, setIsMaximized] = createSignal(false);

  onMount(() => {
    const appWindow = getCurrentWindow();
    let unlistenResize: (() => void) | undefined;
    let unlistenFocus: (() => void) | undefined;

    const sync = async () => {
      try { setIsMaximized(await appWindow.isMaximized()); } catch {}
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
    if (e.buttons !== 1) return;
    const appWindow = getCurrentWindow();
    if (e.detail === 2) {
      e.preventDefault();
      const maximized = await appWindow.isMaximized();
      maximized ? (await appWindow.unmaximize(), setIsMaximized(false)) : (await appWindow.maximize(), setIsMaximized(true));
      return;
    }
    await appWindow.startDragging();
  };

  const handleMinimize = () => getCurrentWindow().minimize();
  const handleMaximize = async () => {
    const w = getCurrentWindow();
    const m = await w.isMaximized();
    m ? (await w.unmaximize(), setIsMaximized(false)) : (await w.maximize(), setIsMaximized(true));
  };
  const handleClose = () => getCurrentWindow().close();

  return (
    <div class="flex items-center h-9 shrink-0 select-none">
      {/* Left: drag region with centered title */}
      <div
        class="flex flex-1 items-center justify-center h-full cursor-default"
        onMouseDown={handleMouseDown}
      >
        <span class="text-[12px] font-medium text-muted-foreground/50 tracking-wide pointer-events-none">OpenCode</span>
      </div>

      {/* Right: window controls (fixed, outside drag region) */}
      <div class="flex items-center h-full pr-3 gap-1">
        <button
          onClick={handleMinimize}
          class="flex items-center justify-center size-6 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-[#fbbf24]/15 active:scale-[0.96] transition-all"
          title="Minimize"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>

        <button
          onClick={handleMaximize}
          class="flex items-center justify-center size-6 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-[#4ade80]/15 active:scale-[0.96] transition-all"
          title={isMaximized() ? 'Restore' : 'Maximize'}
        >
          <Show when={!isMaximized()} fallback={
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="3" width="12" height="12" rx="1" />
              <rect x="3" y="9" width="12" height="12" rx="1" />
            </svg>
          }>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="4" y="4" width="16" height="16" rx="1" />
            </svg>
          </Show>
        </button>

        <button
          onClick={handleClose}
          class="flex items-center justify-center size-6 rounded-md text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 active:scale-[0.96] transition-all"
          title="Close"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
