import { createSignal, onMount, onCleanup, Show } from 'solid-js';
import { getCurrentWindow } from '@tauri-apps/api/window';

const appWindow = getCurrentWindow();

export default function TitleBar() {
  const [isMaximized, setIsMaximized] = createSignal(false);

  onMount(async () => {
    setIsMaximized(await appWindow.isMaximized());

    const unlisten = await appWindow.listen('tauri://resize', async () => {
      setIsMaximized(await appWindow.isMaximized());
    });

    onCleanup(() => {
      unlisten();
    });
  });

  return (
    <div class="flex items-center h-9 shrink-0 select-none border-b border-border">
      {/* Draggable region: title + center spacer, double-click to toggle maximize */}
      <div
        class="flex flex-1 items-center h-full"
        data-tauri-drag-region
        onDblClick={() => appWindow.toggleMaximize()}
      >
        <div class="flex items-center gap-2 px-3">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-foreground">
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
          <span class="text-[11px] font-medium text-foreground tracking-wide">OpenCode</span>
        </div>
      </div>

      {/* Window controls — completely outside the drag region */}
      <div class="flex items-center h-full">
        <button
          onClick={() => appWindow.minimize()}
          class="flex items-center justify-center size-9 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title="Minimize"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>

        <button
          onClick={() => appWindow.toggleMaximize()}
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
          onClick={() => appWindow.close()}
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
