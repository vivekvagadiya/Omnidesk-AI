import React from 'react';
import { ShieldAlert, ArrowLeft, Home, Terminal, Lock } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useRouter } from '../../context/RouterContext';

export function NoRouteFound({ attemptedPath }) {
  const { isAuthenticated, user } = useAuth();
  const { navigate, path } = useRouter();

  const currentPath = attemptedPath || path || window.location.pathname || '/';

  return (
    <div className="min-h-screen w-screen bg-[#090a0f] text-zinc-100 flex flex-col justify-center items-center px-4 py-8 relative overflow-hidden select-none font-sans">
      {/* Background Ambient Glow */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[350px] bg-red-950/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[300px] bg-zinc-900/20 rounded-full blur-3xl pointer-events-none" />

      {/* Main Container Card */}
      <div className="w-full max-w-lg border border-zinc-800 bg-[#0d0f15]/90 backdrop-blur-md rounded-2xl p-8 relative shadow-2xl space-y-6 text-center">
        {/* Brand Header */}
        <div className="flex items-center justify-center gap-2 mb-2">
          <div className="w-6 h-6 rounded bg-zinc-800 border border-zinc-700 flex items-center justify-center font-mono font-bold text-xs text-zinc-200">
            OD
          </div>
          <span className="font-medium text-sm text-zinc-300 tracking-tight">OmniDesk AI</span>
        </div>

        {/* Status Badge & Icon */}
        <div className="flex flex-col items-center gap-3">
          <div className="w-14 h-14 rounded-2xl bg-red-950/30 border border-red-800/50 flex items-center justify-center text-red-400 shadow-inner">
            <ShieldAlert className="w-7 h-7" />
          </div>

          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-red-900/40 bg-red-950/20 text-red-400 font-mono text-xs">
            <Lock className="w-3 h-3" />
            <span>404 NOT_FOUND · UNAUTHORIZED</span>
          </div>

          <h1 className="text-2xl font-semibold tracking-tight text-white mt-1">
            No Route Found
          </h1>
          <p className="text-xs text-zinc-400 max-w-sm leading-relaxed">
            The requested destination does not exist or you do not have authorization to access this enterprise resource.
          </p>
        </div>

        {/* Security & Route Diagnostic Box */}
        <div className="p-3.5 bg-[#12151d] rounded-xl border border-zinc-800 text-left font-mono text-[11px] space-y-2">
          <div className="flex items-center justify-between text-zinc-500 border-b border-zinc-800/80 pb-2">
            <span className="flex items-center gap-1.5 text-zinc-400">
              <Terminal className="w-3.5 h-3.5 text-zinc-500" />
              Route Telemetry
            </span>
            <span className="text-[10px] text-zinc-500">{new Date().toISOString().substring(11, 19)} UTC</span>
          </div>

          <div className="grid grid-cols-3 gap-1 pt-1 text-[11px]">
            <span className="text-zinc-500">Attempted Path:</span>
            <span className="col-span-2 text-zinc-200 truncate font-semibold" title={currentPath}>
              {currentPath}
            </span>

            <span className="text-zinc-500">Access Status:</span>
            <span className="col-span-2 text-red-400 font-medium">FAIL_CLOSED (404)</span>

            <span className="text-zinc-500">Identity:</span>
            <span className="col-span-2 text-zinc-400 truncate">
              {isAuthenticated ? `${user?.name || user?.userId} (${user?.role})` : 'Anonymous (Unauthenticated)'}
            </span>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
          <button
            type="button"
            onClick={() => {
              if (window.history.length > 1) {
                window.history.back();
              } else {
                navigate('/');
              }
            }}
            className="w-full sm:w-auto px-4 py-2 rounded-xl border border-zinc-800 bg-[#141720] hover:bg-zinc-800 text-zinc-300 hover:text-white transition-colors text-xs font-medium flex items-center justify-center gap-2"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Go Back</span>
          </button>

          <button
            type="button"
            onClick={() => navigate('/')}
            className="w-full sm:w-auto px-4 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-lg shadow-blue-900/20 transition-all text-xs font-medium flex items-center justify-center gap-2"
          >
            <Home className="w-3.5 h-3.5" />
            <span>{isAuthenticated ? 'Return to Copilot' : 'Return to Login'}</span>
          </button>
        </div>

        {/* Security Policy Footer Notice */}
        <p className="text-[10px] text-zinc-600 font-mono tracking-tight pt-2">
          Enterprise Security Policy: Unauthorized routes fail closed to prevent endpoint discovery.
        </p>
      </div>
    </div>
  );
}

export default NoRouteFound;
