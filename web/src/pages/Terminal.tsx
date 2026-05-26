import { onMount, onCleanup, createSignal, For, Show } from 'solid-js';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { invoke } from '@tauri-apps/api/core';
import '@xterm/xterm/css/xterm.css';

interface Session {
  id: number;
  name: string;
  term: XTerm;
  fit: FitAddon;
  search: SearchAddon;
  container: HTMLDivElement;
  pid: number | null;
  active: boolean;
  dead: boolean;
}

let nextId = 1;
let suggestedRendererType: 'webgl' | 'dom' | undefined;
let audioCtx: AudioContext | null = null;

function getAudioCtx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

function playBell() {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 800;
    gain.gain.value = 0.08;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.1);
  } catch {
    // AudioContext may be suspended
  }
}

function createXTerm(container: HTMLElement) {
  const term = new XTerm({
    cursorBlink: false,
    cursorStyle: 'bar',
    cursorInactiveStyle: 'outline',
    fontFamily: '"GeistMono Variable", "JetBrains Mono", "Fira Code", monospace',
    fontSize: 15,
    fontWeight: 400,
    fontWeightBold: 600,
    scrollback: 10000,
    allowTransparency: false,
    rightClickSelectsWord: false,
    convertEol: true,
    macOptionIsMeta: false,
    screenReaderMode: false,
    allowProposedApi: true,
    scrollbar: { showScrollbar: false },
    bellStyle: 'sound',
    vtExtensions: { kittyKeyboard: true },
    theme: {
      background: '#242424',
      foreground: '#f0f0f0',
      cursor: '#f0f0f0',
      cursorAccent: '#242424',
      selectionBackground: 'rgba(99,102,241,0.25)',
      selectionForeground: '#f0f0f0',
      black: '#1c1c1c',
      red: '#ff5c5c',
      green: '#4ade80',
      yellow: '#fbbf24',
      blue: '#60a5fa',
      magenta: '#c084fc',
      cyan: '#22d3ee',
      white: '#a6a6a6',
      brightBlack: '#454545',
      brightRed: '#ff8080',
      brightGreen: '#86efac',
      brightYellow: '#fcd34d',
      brightBlue: '#93c5fd',
      brightMagenta: '#d8b4fe',
      brightCyan: '#67e8f9',
      brightWhite: '#f5f5f5',
    },
  });

  const fit = new FitAddon();
  const search = new SearchAddon();
  const clipboard = new ClipboardAddon();
  const unicode11 = new Unicode11Addon();

  let webgl: WebglAddon | null = null;
  let disposed = false;

  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(clipboard);
  term.loadAddon(unicode11);

  term.open(container);
  fit.fit();
  term.focus();
  term.unicode.activeVersion = '11';
  term.onBell(() => playBell());

  const rafId = requestAnimationFrame(() => {
    if (disposed || suggestedRendererType === 'dom') return;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl?.dispose();
        webgl = null;
        suggestedRendererType = 'dom';
        term.refresh(0, term.rows - 1);
      });
      term.loadAddon(webgl);
    } catch {
      suggestedRendererType = 'dom';
    }
  });

  const el = term.element;
  if (el) {
    const handleCopy = (event: ClipboardEvent) => {
      const selection = term.getSelection();
      if (!selection) return;
      const trimmed = selection.split('\n').map(l => l.trimEnd()).join('\n');
      if (event.clipboardData) {
        event.preventDefault();
        event.clipboardData.setData('text/plain', trimmed);
        return;
      }
      navigator.clipboard?.writeText(trimmed).catch(() => {});
    };
    el.addEventListener('copy', handleCopy);
    (term as any).__cleanupCopy = () => el.removeEventListener('copy', handleCopy);
  }

  (term as any).__cleanup = () => {
    disposed = true;
    cancelAnimationFrame(rafId);
    try { webgl?.dispose(); } catch {}
    (term as any).__cleanupCopy?.();
  };

  return { term, fit, search };
}

let userShell = '';

async function getUserShell(): Promise<string> {
  if (userShell) return userShell;
  userShell = await invoke('get_user_shell') as string;
  return userShell;
}

function shellName(path: string): string {
  return path.split('/').pop() || 'sh';
}

async function spawnShell(cols: number, rows: number, cwd?: string): Promise<number> {
  const shell = await getUserShell();
  return invoke('plugin:pty|spawn', {
    file: shell,
    args: [],
    termName: 'xterm-256color',
    cols,
    rows,
    cwd: cwd || null,
    env: {},
    encoding: null,
    handleFlowControl: null,
    flowControlPause: null,
    flowControlResume: null,
  }) as Promise<number>;
}

async function readPty(pid: number): Promise<Uint8Array | null> {
  try {
    const data = await invoke('plugin:pty|read', { pid });
    if (Array.isArray(data)) return new Uint8Array(data);
    if (data instanceof Uint8Array) return data;
    return null;
  } catch (e) {
    if (typeof e === 'string' && e.includes('EOF')) return null;
    console.error('PTY read error:', e);
    return null;
  }
}

export default function TerminalPage() {
  let sessionsContainerRef: HTMLDivElement | undefined;
  const [sessions, setSessions] = createSignal<Session[]>([]);
  const [activeId, setActiveId] = createSignal<number | null>(null);
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number; sessionId: number } | null>(null);

  async function createSession(name?: string, cwd?: string): Promise<Session> {
    const id = nextId++;
    const container = document.createElement('div');
    container.className = 'absolute inset-0';
    sessionsContainerRef?.appendChild(container);

    const { term, fit, search } = createXTerm(container);

    // Hide after opening so xterm.js computes proper dimensions while visible
    container.style.display = 'none';

    const session: Session = {
      id,
      name: name || `${shellName(userShell || '/bin/bash')}-${id}`,
      term,
      fit,
      search,
      container,
      pid: null,
      active: false,
      dead: false,
    };

    try {
      const pid = await spawnShell(term.cols, term.rows, cwd);
      session.pid = pid;

      term.onData((data: string) => {
        if (session.pid !== null && !session.dead) {
          invoke('plugin:pty|write', { pid: session.pid, data }).catch(console.error);
        }
      });

      let running = true;
      (async () => {
        while (running && session.pid !== null && !session.dead) {
          const data = await readPty(session.pid);
          if (data === null) {
            session.dead = true;
            closeSession(session.id);
            break;
          }
          if (data.length > 0) {
            term.write(data);
          } else {
            // Throttle to avoid busy-wait when PTY returns empty
            await new Promise(r => setTimeout(r, 16));
          }
        }
      })();

      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      const resize = () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (session.pid !== null && !session.dead) {
            fit.fit();
            invoke('plugin:pty|resize', { pid: session.pid, cols: term.cols, rows: term.rows }).catch(() => {});
          }
        }, 100);
      };
      window.addEventListener('resize', resize);
      (session as any).__cleanupResize = () => {
        window.removeEventListener('resize', resize);
        if (resizeTimer) clearTimeout(resizeTimer);
      };

      container.addEventListener('click', () => {
        setActiveId(session.id);
        term.focus();
      });

    } catch (e) {
      console.error('Failed to spawn shell:', e);
      term.writeln('\r\n\x1b[31mFailed to spawn shell\x1b[0m');
    }

    return session;
  }

  function closeSession(id: number) {
    const all = sessions();
    const target = all.find(s => s.id === id);
    if (!target) return;

    if (target.pid !== null) invoke('plugin:pty|kill', { pid: target.pid }).catch(() => {});
    target.dead = true;
    (target.term as any).__cleanup?.();
    (target as any).__cleanupResize?.();
    target.term.dispose();
    target.container.remove();

    const idx = all.findIndex(s => s.id === id);
    const remaining = all.filter(s => s.id !== id);
    setSessions(remaining);

    if (activeId() === id && remaining.length > 0) {
      // activate tab to the left, or rightmost if it was the first tab
      const nextIdx = Math.max(0, idx - 1);
      const nextId = remaining[nextIdx].id;
      setActiveId(nextId);
      activateSession(nextId);
    } else if (remaining.length === 0) {
      createSession().then(s2 => {
        setSessions([s2]);
        activateSession(s2.id);
      });
    }
  }

  function activateSession(id: number) {
    const all = sessions();
    for (const s of all) {
      const isActive = s.id === id;
      s.container.style.display = isActive ? 'block' : 'none';
      s.active = isActive;
    }
    setActiveId(id);
    const s = all.find(x => x.id === id);
    if (s) {
      requestAnimationFrame(() => { s.fit.fit(); s.term.focus(); });
    }
  }

  onMount(async () => {
    const shell = await getUserShell();
    const s = await createSession(shellName(shell));
    setSessions([s]);
    activateSession(s.id);

    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const current = sessions().find(s => s.id === activeId());
      const all = sessions();
      const idx = all.findIndex(s => s.id === activeId());

      // Ctrl+Tab — next tab
      if (ctrl && e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        if (all.length > 1) {
          const nextIdx = (idx + 1 + all.length) % all.length;
          activateSession(all[nextIdx].id);
        }
        return;
      }

      // Ctrl+Shift+Tab — previous tab
      if (ctrl && e.shiftKey && e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        if (all.length > 1) {
          const prevIdx = (idx - 1 + all.length) % all.length;
          activateSession(all[prevIdx].id);
        }
        return;
      }

      // Ctrl+T — new tab
      if (ctrl && e.key.toLowerCase() === 't' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        createSession().then(s2 => { setSessions(prev => [...prev, s2]); activateSession(s2.id); });
        return;
      }

      if (!current) return;

      if (ctrl && e.shiftKey && e.key === 'C') {
        e.preventDefault();
        e.stopPropagation();
        const sel = current.term.getSelection();
        if (sel) navigator.clipboard.writeText(sel);
        return;
      }
      if (ctrl && e.shiftKey && e.key === 'V') {
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard.readText().then(text => {
          if (current.pid !== null) invoke('plugin:pty|write', { pid: current.pid, data: text }).catch(() => {});
        });
        return;
      }
      if (ctrl && e.key === 'f') {
        e.preventDefault();
        e.stopPropagation();
        setSearchOpen(prev => { if (!prev) current.search.findPrevious(''); return !prev; });
        return;
      }
      if (ctrl && e.key === 'w') {
        e.preventDefault();
        e.stopPropagation();
        closeSession(current.id);
        return;
      }
    };

    // Use window capture phase so we intercept before xterm's textarea handler
    window.addEventListener('keydown', onKey, true);

    onCleanup(() => {
      window.removeEventListener('keydown', onKey, true);
      for (const s of sessions()) {
        if (s.pid !== null) invoke('plugin:pty|kill', { pid: s.pid }).catch(() => {});
        (s.term as any).__cleanup?.();
        s.term.dispose();
      }
    });
  });

  return (
    <div class="flex flex-col h-full w-full bg-background">
      {/* Tabs */}
      <div class="flex items-center w-full border-b border-border px-1 shrink-0 h-7">
        <For each={sessions()}>
          {(s) => (
            <button
              onClick={() => activateSession(s.id)}
              onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, sessionId: s.id }); }}
              class={`group flex items-center gap-1.5 px-2.5 h-full text-[11px] transition-colors border-t-2 ${
                activeId() === s.id
                  ? 'bg-background text-foreground border-primary'
                  : s.dead
                    ? 'text-destructive/60 hover:text-destructive border-transparent'
                    : 'text-muted-foreground hover:text-foreground border-transparent'
              }`}
            >
              <span class="truncate max-w-[100px]">{s.name}</span>
              <span
                onClick={(e) => { e.stopPropagation(); closeSession(s.id); }}
                class="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M18 6 6 18M6 6l12 12"/>
                </svg>
              </span>
            </button>
          )}
        </For>

        <button
          onClick={() => createSession().then(s2 => { setSessions(prev => [...prev, s2]); activateSession(s2.id); })}
          class="flex items-center justify-center size-5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors mx-1"
          title="New Tab (Ctrl+T)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 5v14M5 12h14"/>
          </svg>
        </button>

        <div class="flex-1" />

        <button
          onClick={() => {
            const current = sessions().find(s => s.id === activeId());
            if (current) { current.search.findPrevious(''); setSearchOpen(o => !o); }
          }}
          class={`flex items-center justify-center size-5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors ${searchOpen() ? 'bg-muted text-foreground' : ''}`}
          title="Search (Ctrl+F)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
          </svg>
        </button>
      </div>

      {/* Search */}
      <Show when={searchOpen()}>
        <div class="flex items-center gap-2 border-b border-border bg-muted px-3 py-1 shrink-0">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
          </svg>
          <input
            type="text"
            placeholder="Search..."
            class="bg-transparent text-[12px] text-foreground outline-none flex-1 placeholder:text-muted-foreground"
            onInput={(e) => {
              const current = sessions().find(s => s.id === activeId());
              if (current) current.search.findNext(e.currentTarget.value, { caseSensitive: false });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const current = sessions().find(s => s.id === activeId());
                if (current) e.shiftKey ? current.search.findPrevious((e.target as HTMLInputElement).value) : current.search.findNext((e.target as HTMLInputElement).value);
              }
              if (e.key === 'Escape') setSearchOpen(false);
            }}
          />
          <div class="flex items-center gap-1 text-[10px] text-muted-foreground">
            <kbd class="rounded bg-background px-1 border border-border">↵</kbd>
            <kbd class="rounded bg-background px-1 border border-border">Shift+↵</kbd>
          </div>
          <button onClick={() => setSearchOpen(false)} class="text-muted-foreground hover:text-foreground">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </Show>

      {/* Terminal fills everything */}
      <div ref={sessionsContainerRef} class="flex-1 relative min-h-0 w-full" />

      {/* Context menu */}
      <Show when={contextMenu()}>
        <>
          <div class="fixed inset-0 z-40" onClick={() => setContextMenu(null)} />
          <div
            class="fixed z-50 rounded border border-border bg-popover py-0.5 shadow-xl"
            style={{ left: `${contextMenu()!.x}px`, top: `${contextMenu()!.y}px` }}
          >
            <button
              onClick={() => {
                const s = sessions().find(x => x.id === contextMenu()!.sessionId);
                if (s) { const sel = s.term.getSelection(); if (sel) navigator.clipboard.writeText(sel); }
                setContextMenu(null);
              }}
              class="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
              Copy
            </button>
            <button
              onClick={() => {
                const s = sessions().find(x => x.id === contextMenu()!.sessionId);
                if (s && s.pid !== null) navigator.clipboard.readText().then(text => invoke('plugin:pty|write', { pid: s.pid, data: text }).catch(() => {}));
                setContextMenu(null);
              }}
              class="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
              Paste
            </button>
            <div class="my-0.5 border-t border-border" />
            <button
              onClick={() => { closeSession(contextMenu()!.sessionId); setContextMenu(null); }}
              class="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-destructive hover:bg-destructive/10 transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
              Close
            </button>
          </div>
        </>
      </Show>
    </div>
  );
}
