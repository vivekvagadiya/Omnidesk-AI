import React from 'react';
import { useAuth } from '../../context/AuthContext';
import { useCopilot } from '../../context/CopilotContext';
import { LogOut, ChevronRight, ShieldCheck } from 'lucide-react';
import { NotificationBell } from './NotificationBell';

export function Header({ onToggleAudit, isAuditOpen }) {
  const { user, logout } = useAuth();
  const { sessionId } = useCopilot();

  const getRoleBadge = (role) => {
    switch (role) {
      case 'org_admin':
      case 'super_admin':
        return 'border-purple-800/60 text-purple-300 bg-purple-950/20';
      case 'it_admin':
        return 'border-blue-800/60 text-blue-300 bg-blue-950/20';
      case 'hr_admin':
        return 'border-emerald-800/60 text-emerald-300 bg-emerald-950/20';
      case 'manager':
        return 'border-amber-800/60 text-amber-300 bg-amber-950/20';
      default:
        return 'border-zinc-800 text-zinc-400 bg-zinc-900';
    }
  };

  return (
    <header className="h-12 border-b border-zinc-800/90 bg-[#0d0f14] px-4 flex items-center justify-between select-none">
      {/* Brand & Workspace Name */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded bg-zinc-800 border border-zinc-700 flex items-center justify-center font-mono font-bold text-xs text-zinc-200">
            OD
          </div>
          <span className="font-medium text-sm text-zinc-100 tracking-tight">OmniDesk AI</span>
        </div>

        <ChevronRight className="w-3.5 h-3.5 text-zinc-600" />

        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-zinc-400 uppercase tracking-wider">
            {user?.orgId || 'abctech'}
          </span>
          <span className="text-zinc-600 text-xs">/</span>
          <span className="text-xs font-medium text-zinc-300">{user?.department}</span>
        </div>
      </div>

      {/* Center: Active LLM Engine Status */}
      <div className="hidden md:flex items-center gap-2 bg-[#12151c] px-2.5 py-1 rounded-full border border-zinc-800 text-[11px] text-zinc-400">
        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
        <span className="font-mono text-zinc-300">Gemini 3.8 Flash</span>
        <span className="text-zinc-600">|</span>
        <span className="text-zinc-400 font-mono text-[10px]">{sessionId.substring(0, 16)}...</span>
      </div>

      {/* Right Controls: Audit & Telemetry, Notification Bell, User Card & Logout */}
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={onToggleAudit}
          title="Cryptographic Audit Ledger & Live Telemetry"
          className={`px-2.5 py-1 rounded-lg border text-[11px] font-mono transition-colors flex items-center gap-1.5 ${
            isAuditOpen
              ? 'bg-zinc-800 text-emerald-400 border-zinc-700'
              : 'bg-[#12151c] text-zinc-300 hover:text-white hover:bg-zinc-800 border-zinc-800'
          }`}
        >
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
          <span className="hidden lg:inline">Audit & Telemetry</span>
        </button>

        <NotificationBell />

        {/* User Identity Chip */}
        <div className="flex items-center gap-2 pl-2 border-l border-zinc-800">
          <div className="w-7 h-7 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-xs font-medium text-zinc-200">
            {user?.name
              ? user.name
                  .split(' ')
                  .map((n) => n[0])
                  .join('')
                  .toUpperCase()
              : 'U'}
          </div>

          <div className="hidden sm:block text-left">
            <div className="text-xs font-medium text-zinc-200 leading-tight">{user?.name}</div>
            <div className="flex items-center gap-1 mt-0.5">
              <span
                className={`text-[9px] font-mono uppercase px-1 py-0.2 rounded border ${getRoleBadge(
                  user?.role
                )}`}
              >
                {user?.role?.replace('_', ' ')}
              </span>
            </div>
          </div>

          <button
            onClick={logout}
            title="Sign out"
            className="p-1.5 ml-1 text-zinc-400 hover:text-red-400 hover:bg-red-950/20 rounded-lg transition-colors border border-transparent hover:border-red-900/40"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </header>
  );
}
