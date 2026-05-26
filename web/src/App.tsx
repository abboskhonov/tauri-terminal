import TitleBar from './components/TitleBar';
import TerminalPage from './pages/Terminal';

export default function App() {
  return (
    <div class="flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground font-sans text-sm">
      <TitleBar />
      <TerminalPage />
    </div>
  );
}
