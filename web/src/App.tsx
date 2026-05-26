import { onMount, onCleanup } from 'solid-js';
import TitleBar from './components/TitleBar';
import TerminalManager from './pages/Terminal';

export default function App() {
  let terminalRef: HTMLDivElement | undefined;

  onMount(() => {
    if (!terminalRef) return;
    const tm = new TerminalManager(terminalRef);
    onCleanup(() => tm.destroy());
  });

  return (
    <div class="flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground font-sans text-sm">
      <TitleBar />
      <div ref={terminalRef} class="flex-1 min-h-0" />
    </div>
  );
}
