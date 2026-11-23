import React, { useState } from "react";
import { Toaster } from "sonner";
import { useAuth } from "./context/AuthContext";
import { useRouter } from "./context/RouterContext";
import { CopilotProvider } from "./context/CopilotContext";
import { LoginView } from "./components/auth/LoginView";
import { Header } from "./components/layout/Header";
import { LeftOpsPanel } from "./components/layout/LeftOpsPanel";
import { ChatContainer } from "./components/chat/ChatContainer";
import { RightCitationDrawer } from "./components/drawer/RightCitationDrawer";
import { AuditTelemetryDrawer } from "./components/drawer/AuditTelemetryDrawer";
import { NoRouteFound } from "./components/common/NoRouteFound";

export function App() {
  const { isAuthenticated, user } = useAuth();
  const { path } = useRouter();
  const [isAuditDrawerOpen, setIsAuditDrawerOpen] = useState(false);

  // Normalize path by stripping query strings, hash, and trailing slashes
  const normalizedPath = (path.split("?")[0].split("#")[0].replace(/\/+$/, "") || "/").toLowerCase();

  // Route evaluation and access control
  const renderRouteContent = () => {
    // 1. Root and Login entry points
    if (normalizedPath === "/" || normalizedPath === "/login") {
      if (!isAuthenticated) {
        return <LoginView />;
      }
      return renderCopilotApp();
    }

    // 2. Protected Copilot Workspace routes
    if (["/dashboard", "/chat", "/copilot"].includes(normalizedPath)) {
      if (!isAuthenticated) {
        // Unauthorized route for unauthenticated user: fail closed to No Route Found
        return <NoRouteFound attemptedPath={path} />;
      }
      return renderCopilotApp();
    }

    // 3. Admin / Audit telemetry routes
    if (["/audit", "/telemetry", "/admin"].includes(normalizedPath)) {
      const isSuperOrOrgAdmin = isAuthenticated && ["super_admin", "org_admin"].includes(user?.role);
      if (!isSuperOrOrgAdmin) {
        // Unauthorized route for non-admin user: fail closed to No Route Found
        return <NoRouteFound attemptedPath={path} />;
      }
      return renderCopilotApp({ initialAuditOpen: true });
    }

    // 4. Any other unrecognized or unauthorized route: fail closed to No Route Found
    return <NoRouteFound attemptedPath={path} />;
  };

  const renderCopilotApp = (options = {}) => (
    // Keyed by user: switching accounts remounts the chat with a fresh session,
    // so one user's conversation is never shown to the next
    <CopilotProvider key={user?.userId || "copilot"}>
      <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#090a0f] text-zinc-100 font-sans antialiased">
        {/* Top Application Header */}
        <Header
          onToggleAudit={() => setIsAuditDrawerOpen((prev) => !prev)}
          isAuditOpen={isAuditDrawerOpen || options.initialAuditOpen}
        />

        {/* 3-Panel Enterprise Layout */}
        <div className="flex flex-1 overflow-hidden relative">
          {/* Left Panel: Operations & Live Quotas */}
          <LeftOpsPanel />

          {/* Center Panel: Interactive Chat Stream & Action Cards */}
          <ChatContainer />

          {/* Right Panel: Citation Evidence Drawer (Collapsible) */}
          <RightCitationDrawer />

          {/* Collapsible Cryptographic Audit & Telemetry Drawer */}
          <AuditTelemetryDrawer
            isOpen={isAuditDrawerOpen || options.initialAuditOpen}
            onClose={() => setIsAuditDrawerOpen(false)}
          />
        </div>
      </div>
    </CopilotProvider>
  );

  return (
    <>
      {/* Enterprise-grade Sonner Toaster strictly positioned at the top right */}
      <Toaster
        position="top-right"
        theme="dark"
        closeButton
        richColors
        toastOptions={{
          style: {
            background: "#11131a",
            border: "1px solid #27272a",
            color: "#f4f4f5",
            fontSize: "12px",
          },
        }}
      />

      {renderRouteContent()}
    </>
  );
}

export default App;
