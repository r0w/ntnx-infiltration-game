import { Route, Routes } from 'react-router-dom';
import { AdminPage } from './AdminPage';
import { GameApp } from './GameApp';
import { Scoreboard } from './Scoreboard';
import { SshConsole } from './SshConsole';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<GameApp />} />
      <Route path="/scoreboard" element={<Scoreboard />} />
      <Route path="/ssh" element={<SshConsole />} />
      <Route path="/admin" element={<AdminPage />} />
      <Route path="/admin/:tab" element={<AdminPage />} />
      <Route path="*" element={<GameApp />} />
    </Routes>
  );
}
