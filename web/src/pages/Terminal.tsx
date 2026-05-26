import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { invoke } from '@tauri-apps/api/core';
import '@xterm/xterm/css/xterm.css';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Globals                                                            */
/* ------------------------------------------------------------------ */

let nextId = 1;
let suggestedRendererType: 'webgl' | 'dom' | undefined;
let userShell = '';
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

/* ------------------------------------------------------------------ */
/*  xterm factory                                                      */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Terminal Manager (vanilla TS)                                      */
/* ------------------------------------------------------------------ */

export default class TerminalManager {
  private root: HTMLElement;
  private sessions: Session[] = [];
  private activeId: number | null = null;
  private searchOpen = false;
  private nextId = 1;

  /* DOM refs */
  private tabsBar: HTMLDivElement;
  private searchBar: HTMLDivElement | null = null;
  private sessionsContainer: HTMLDivElement;
  private contextMenuEl: HTMLElement | null = null;
  private backdropEl: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;

  /* Event handlers (stored for cleanup) */
  private _keydownHandler: (e: KeyboardEvent) => void;
  private _resizeHandler: () => void;

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.className = 'flex flex-col h-full w-full bg-background';

    this.tabsBar = document.createElement('div');
    this.tabsBar.className = 'flex items-center w-full border-b border-border px-1 shrink-0 h-7';

    this.sessionsContainer = document.createElement('div');
    this.sessionsContainer.className = 'flex-1 relative min-h-0 w-full';

    this.root.appendChild(this.tabsBar);
    this.root.appendChild(this.sessionsContainer);

    this._keydownHandler = (e: KeyboardEvent) => this.onKeyDown(e);
    this._resizeHandler = () => this.onWindowResize();
    window.addEventListener('keydown', this._keydownHandler, true);
    window.addEventListener('resize', this._resizeHandler);

    getUserShell().then(shell => this.createSession(shellName(shell)));
  }

  destroy() {
    window.removeEventListener('keydown', this._keydownHandler, true);
    window.removeEventListener('resize', this._resizeHandler);
    for (const s of this.sessions) {
      if (s.pid !== null) invoke('plugin:pty|kill', { pid: s.pid }).catch(() => {});
      (s.term as any).__cleanup?.();
      s.term.dispose();
    }
    this.sessions = [];
    this.root.innerHTML = '';
  }

  /* ================================================================ */
  /*  Session lifecycle                                               */
  /* ================================================================ */

  private async createSession(name?: string, cwd?: string): Promise<Session> {
    const id = this.nextId++;
    const container = document.createElement('div');
    container.className = 'absolute inset-0';
    container.style.display = 'none';
    this.sessionsContainer.appendChild(container);

    const { term, fit, search } = createXTerm(container);

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

    this.sessions.push(session);
    this.renderTabs();

    try {
      const pid = await spawnShell(term.cols, term.rows, cwd);
      session.pid = pid;

      term.onData((data: string) => {
        if (session.pid !== null && !session.dead) {
          invoke('plugin:pty|write', { pid: session.pid, data }).catch(console.error);
        }
      });

      container.addEventListener('click', () => {
        this.activateSession(session.id);
        term.focus();
      });

      /* PTY read loop */
      let running = true;
      (async () => {
        while (running && session.pid !== null && !session.dead) {
          const data = await readPty(session.pid);
          if (data === null) {
            session.dead = true;
            this.closeSession(session.id);
            break;
          }
          if (data.length > 0) {
            term.write(data);
          } else {
            await new Promise(r => setTimeout(r, 16));
          }
        }
      })();

      /* Resize */
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      const onResize = () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (session.pid !== null && !session.dead) {
            fit.fit();
            invoke('plugin:pty|resize', { pid: session.pid, cols: term.cols, rows: term.rows }).catch(() => {});
          }
        }, 100);
      };
      window.addEventListener('resize', onResize);
      (session as any).__cleanupResize = () => {
        window.removeEventListener('resize', onResize);
        if (resizeTimer) clearTimeout(resizeTimer);
      };

      if (!this.activeId) {
        this.activateSession(id);
      }
    } catch (e) {
      console.error('Failed to spawn shell:', e);
      term.writeln('\r\n\x1b[31mFailed to spawn shell\x1b[0m');
    }

    return session;
  }

  private closeSession(id: number) {
    const idx = this.sessions.findIndex(s => s.id === id);
    if (idx === -1) return;

    const target = this.sessions[idx];
    if (target.pid !== null) invoke('plugin:pty|kill', { pid: target.pid }).catch(() => {});
    target.dead = true;
    (target.term as any).__cleanup?.();
    (target as any).__cleanupResize?.();
    target.term.dispose();
    target.container.remove();

    this.sessions.splice(idx, 1);
    this.renderTabs();

    if (this.activeId === id && this.sessions.length > 0) {
      const nextIdx = Math.max(0, idx - 1);
      this.activateSession(this.sessions[nextIdx].id);
    } else if (this.sessions.length === 0) {
      this.createSession().then(s => {
        this.activateSession(s.id);
      });
    } else if (this.activeId === id) {
      this.activeId = null;
    }
  }

  private activateSession(id: number) {
    for (const s of this.sessions) {
      const isActive = s.id === id;
      s.container.style.display = isActive ? 'block' : 'none';
      s.active = isActive;
    }
    this.activeId = id;
    const s = this.sessions.find(x => x.id === id);
    if (s) {
      requestAnimationFrame(() => { s.fit.fit(); s.term.focus(); });
    }
    this.renderTabs();
  }

  /* ================================================================ */
  /*  Tabs rendering                                                  */
  /* ================================================================ */

  private renderTabs() {
    this.tabsBar.innerHTML = '';

    for (const s of this.sessions) {
      const btn = document.createElement('button');
      const isActive = s.id === this.activeId;
      btn.className = `group flex items-center gap-1.5 px-2.5 h-full text-[11px] transition-colors border-t-2 ${
        isActive
          ? 'bg-background text-foreground border-primary'
          : s.dead
            ? 'text-destructive/60 hover:text-destructive border-transparent'
            : 'text-muted-foreground hover:text-foreground border-transparent'
      }`;

      const label = document.createElement('span');
      label.className = 'truncate max-w-[100px]';
      label.textContent = s.name;
      btn.appendChild(label);

      const close = document.createElement('span');
      close.className = 'rounded p-0.5 opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity';
      close.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
      close.addEventListener('click', (e) => { e.stopPropagation(); this.closeSession(s.id); });
      btn.appendChild(close);

      btn.addEventListener('click', () => this.activateSession(s.id));
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.showContextMenu(e.clientX, e.clientY, s.id);
      });

      this.tabsBar.appendChild(btn);
    }

    /* New tab button */
    const addBtn = document.createElement('button');
    addBtn.className = 'flex items-center justify-center size-5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors mx-1';
    addBtn.title = 'New Tab (Ctrl+T)';
    addBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>`;
    addBtn.addEventListener('click', () => {
      this.createSession().then(s => this.activateSession(s.id));
    });
    this.tabsBar.appendChild(addBtn);

    /* Spacer */
    const spacer = document.createElement('div');
    spacer.className = 'flex-1';
    this.tabsBar.appendChild(spacer);

    /* Search toggle */
    const searchBtn = document.createElement('button');
    searchBtn.className = `flex items-center justify-center size-5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors ${this.searchOpen ? 'bg-muted text-foreground' : ''}`;
    searchBtn.title = 'Search (Ctrl+F)';
    searchBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`;
    searchBtn.addEventListener('click', () => this.toggleSearch());
    this.tabsBar.appendChild(searchBtn);
  }

  /* ================================================================ */
  /*  Search                                                          */
  /* ================================================================ */

  private toggleSearch() {
    this.searchOpen = !this.searchOpen;
    if (this.searchOpen) {
      this.buildSearchBar();
      const current = this.sessions.find(s => s.id === this.activeId);
      if (current) current.search.findPrevious('');
      setTimeout(() => this.searchInput?.focus(), 0);
    } else {
      this.searchBar?.remove();
      this.searchBar = null;
      this.searchInput = null;
    }
    this.renderTabs();
  }

  private buildSearchBar() {
    if (this.searchBar) return;
    const bar = document.createElement('div');
    bar.className = 'flex items-center gap-2 border-b border-border bg-muted px-3 py-1 shrink-0';
    bar.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      <input type="text" placeholder="Search..." class="bg-transparent text-[12px] text-foreground outline-none flex-1 placeholder:text-muted-foreground" />
      <div class="flex items-center gap-1 text-[10px] text-muted-foreground">
        <kbd class="rounded bg-background px-1 border border-border">↵</kbd>
        <kbd class="rounded bg-background px-1 border border-border">Shift+↵</kbd>
      </div>
      <button class="text-muted-foreground hover:text-foreground">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    `;

    const input = bar.querySelector('input') as HTMLInputElement;
    this.searchInput = input;
    input.addEventListener('input', () => {
      const current = this.sessions.find(s => s.id === this.activeId);
      if (current) current.search.findNext(input.value, { caseSensitive: false });
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const current = this.sessions.find(s => s.id === this.activeId);
        if (current) {
          e.shiftKey ? current.search.findPrevious(input.value) : current.search.findNext(input.value);
        }
      }
      if (e.key === 'Escape') this.toggleSearch();
    });

    const closeBtn = bar.querySelector('button')!;
    closeBtn.addEventListener('click', () => this.toggleSearch());

    this.root.insertBefore(bar, this.sessionsContainer);
    this.searchBar = bar;
  }

  /* ================================================================ */
  /*  Context menu                                                    */
  /* ================================================================ */

  private showContextMenu(x: number, y: number, sessionId: number) {
    this.hideContextMenu();

    const backdrop = document.createElement('div');
    backdrop.className = 'fixed inset-0 z-40';
    backdrop.addEventListener('click', () => this.hideContextMenu());
    document.body.appendChild(backdrop);
    this.backdropEl = backdrop;

    const menu = document.createElement('div');
    menu.className = 'fixed z-50 rounded border border-border bg-popover py-0.5 shadow-xl';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    menu.innerHTML = `
      <button class="ctx-copy w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
        Copy
      </button>
      <button class="ctx-paste w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
        Paste
      </button>
      <div class="my-0.5 border-t border-border"></div>
      <button class="ctx-close w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-destructive hover:bg-destructive/10 transition-colors">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        Close
      </button>
    `;

    menu.querySelector('.ctx-copy')!.addEventListener('click', () => {
      const s = this.sessions.find(x => x.id === sessionId);
      if (s) {
        const sel = s.term.getSelection();
        if (sel) navigator.clipboard.writeText(sel);
      }
      this.hideContextMenu();
    });

    menu.querySelector('.ctx-paste')!.addEventListener('click', () => {
      const s = this.sessions.find(x => x.id === sessionId);
      if (s && s.pid !== null) {
        navigator.clipboard.readText().then(text => {
          invoke('plugin:pty|write', { pid: s.pid!, data: text }).catch(() => {});
        });
      }
      this.hideContextMenu();
    });

    menu.querySelector('.ctx-close')!.addEventListener('click', () => {
      this.closeSession(sessionId);
      this.hideContextMenu();
    });

    document.body.appendChild(menu);
    this.contextMenuEl = menu;
  }

  private hideContextMenu() {
    this.backdropEl?.remove();
    this.backdropEl = null;
    this.contextMenuEl?.remove();
    this.contextMenuEl = null;
  }

  /* ================================================================ */
  /*  Keyboard shortcuts                                              */
  /* ================================================================ */

  private onKeyDown(e: KeyboardEvent) {
    const ctrl = e.ctrlKey || e.metaKey;
    const all = this.sessions;
    const idx = all.findIndex(s => s.id === this.activeId);
    const current = all.find(s => s.id === this.activeId);

    // Ctrl+Tab — next tab
    if (ctrl && e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (all.length > 1) {
        const nextIdx = (idx + 1 + all.length) % all.length;
        this.activateSession(all[nextIdx].id);
      }
      return;
    }

    // Ctrl+Shift+Tab — previous tab
    if (ctrl && e.shiftKey && e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      if (all.length > 1) {
        const prevIdx = (idx - 1 + all.length) % all.length;
        this.activateSession(all[prevIdx].id);
      }
      return;
    }

    // Ctrl+T — new tab
    if (ctrl && e.key.toLowerCase() === 't' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      this.createSession().then(s => this.activateSession(s.id));
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
        if (current.pid !== null) {
          invoke('plugin:pty|write', { pid: current.pid, data: text }).catch(() => {});
        }
      });
      return;
    }

    if (ctrl && e.key === 'f') {
      e.preventDefault();
      e.stopPropagation();
      this.toggleSearch();
      return;
    }

    if (ctrl && e.key === 'w') {
      e.preventDefault();
      e.stopPropagation();
      this.closeSession(current.id);
      return;
    }
  }

  private onWindowResize() {
    for (const s of this.sessions) {
      if (s.active) {
        s.fit.fit();
        if (s.pid !== null && !s.dead) {
          invoke('plugin:pty|resize', { pid: s.pid, cols: s.term.cols, rows: s.term.rows }).catch(() => {});
        }
      }
    }
  }
}
