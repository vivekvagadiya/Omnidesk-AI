import React from 'react';
import { useAuth } from './context/AuthContext';
import { LoginView } from './components/auth/LoginView';
import { Header } from './components/layout/Header';
import { LeftOpsPanel } from './components/layout/LeftOpsPanel';
import { ChatContainer } from './components/chat/ChatContainer';
import { RightCitationDrawer } from './components/drawer/RightCitationDrawer';

export function App() {
  const { isAuthenticated, isLoading } = useAuth();

  if (!isAuthenticated) {
    return <LoginView />;
  }

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#090a0f] text-zinc-100 font-sans antialiased">
      {/* Top Application Header */}
      <Header />

      {/* 3-Panel Enterprise Layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Panel: Operations & Live Quotas */}
        <LeftOpsPanel />

        {/* Center Panel: Interactive Chat Stream & Action Cards */}
        <ChatContainer />

        {/* Right Panel: Citation Evidence Drawer (Collapsible) */}
        <RightCitationDrawer />
      </div>
    </div>
  );
}

export default App;
