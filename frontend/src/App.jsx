import React from 'react';
import { Toaster } from 'sonner';
import { useAuth } from './context/AuthContext';
import { LoginView } from './components/auth/LoginView';
import { Header } from './components/layout/Header';
import { LeftOpsPanel } from './components/layout/LeftOpsPanel';
import { ChatContainer } from './components/chat/ChatContainer';
import { RightCitationDrawer } from './components/drawer/RightCitationDrawer';

export function App() {
  const { isAuthenticated } = useAuth();

  return (
    <>
      {/* Enterprise-grade Sonner Toaster matching OmniDesk deep matte zinc aesthetic */}
      <Toaster
        position="bottom-right"
        theme="dark"
        closeButton
        richColors
        toastOptions={{
          style: {
            background: '#11131a',
            border: '1px solid #27272a',
            color: '#f4f4f5',
            fontSize: '12px',
          },
        }}
      />

      {!isAuthenticated ? (
        <LoginView />
      ) : (
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
      )}
    </>
  );
}

export default App;
