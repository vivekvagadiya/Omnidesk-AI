import React from 'react';
import {
  X,
  ShieldCheck,
  Cpu,
  Clock,
  Activity,
  RefreshCw,
  Zap,
} from 'lucide-react';
import { useAuditLogsQuery } from '../../queries';

export function AuditTelemetryDrawer({ isOpen, onClose }) {
  const auditLogsQuery = useAuditLogsQuery({ enabled: isOpen, limit: 50 });

  if (!isOpen) return null;

  const logs = auditLogsQuery.data?.logs || [];

  // Calculate live telemetry aggregates
  const avgLatency =
    logs.length > 0
      ? Math.round(
          logs.reduce((acc, l) => acc + (l.telemetry?.latencyMs || 200), 0) /
            logs.length
        )
      : 0;

  const totalTokens = logs.reduce(
    (acc, l) => acc + (l.telemetry?.tokensUsed?.total || 0),
    0
  );

  return (
    <aside className="w-96 md:w-[28rem] border-l border-zinc-800 bg-[#0c0e14] flex flex-col h-[calc(100vh-3rem)] select-none fixed right-0 top-12 z-40 shadow-2xl animate-in slide-in-from-right duration-200">
      {/* Header */}
      <div className="h-12 border-b border-zinc-800 px-4 flex items-center justify-between bg-[#10131b]">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          <span className="text-xs font-semibold text-zinc-100">
            Audit Logs & Live Telemetry
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => auditLogsQuery.refetch()}
            className="p-1 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 transition-colors"
            title="Refresh Audit Logs"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${auditLogsQuery.isFetching ? 'animate-spin text-emerald-400' : ''}`}
            />
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
        {/* Real-Time Telemetry Metrics Bar */}
        <div className="grid grid-cols-3 gap-2 text-[10px] font-mono">
          <div className="p-2.5 rounded-xl border border-zinc-800 bg-[#12151d] space-y-1">
            <div className="text-zinc-500 flex items-center gap-1">
              <Clock className="w-3 h-3 text-blue-400" /> Latency
            </div>
            <div className="text-xs font-bold text-zinc-100 font-mono">
              {avgLatency > 0 ? `${avgLatency} ms` : '—'}
            </div>
            <div className="text-[9px] text-zinc-500">Avg Turn Time</div>
          </div>

          <div className="p-2.5 rounded-xl border border-zinc-800 bg-[#12151d] space-y-1">
            <div className="text-zinc-500 flex items-center gap-1">
              <Zap className="w-3 h-3 text-amber-400" /> Tokens
            </div>
            <div className="text-xs font-bold text-zinc-100 font-mono">
              {totalTokens > 0 ? totalTokens.toLocaleString() : '—'}
            </div>
            <div className="text-[9px] text-zinc-500">Session Usage</div>
          </div>

          <div className="p-2.5 rounded-xl border border-zinc-800 bg-[#12151d] space-y-1">
            <div className="text-zinc-500 flex items-center gap-1">
              <Cpu className="w-3 h-3 text-emerald-400" /> Model
            </div>
            <div className="text-xs font-bold text-zinc-100 font-mono truncate">
              Gemini 3.8
            </div>
            <div className="text-[9px] text-emerald-400">Flash Engine</div>
          </div>
        </div>

        {/* Audit Log Timeline */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-[11px] font-mono text-zinc-400 uppercase tracking-wider">
            <span className="flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-zinc-400" /> Audit Ledger
            </span>
            <span className="text-zinc-400">{logs.length} Operations</span>
          </div>

          {auditLogsQuery.isPending ? (
            <div className="py-8 text-center text-zinc-500 font-mono text-xs">
              Loading audit logs…
            </div>
          ) : logs.length === 0 ? (
            <div className="p-6 rounded-xl border border-dashed border-zinc-800 text-center text-zinc-500 text-xs space-y-1">
              <p>No audit records logged yet.</p>
              <p className="text-[10px] text-zinc-600">Actions like creating tickets, resolving, or chatting with Copilot will appear here in real-time.</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
              {logs.map((log) => (
                <div
                  key={log.logId}
                  className="p-3 bg-[#11131a] rounded-xl border border-zinc-800/80 hover:border-zinc-700 transition-colors space-y-1.5"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[10px] font-bold text-zinc-200 bg-zinc-900 border border-zinc-800 px-1.5 py-0.5 rounded">
                      {log.action?.replace(/_/g, ' ')}
                    </span>
                    <span className="text-[10px] font-mono text-zinc-500">
                      {new Date(
                        log.timestamp || log.createdAt
                      ).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </span>
                  </div>

                  <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400">
                    <span>
                      Actor:{' '}
                      <strong className="text-zinc-300 font-normal">
                        {log.actorName || log.actorId}
                      </strong>{' '}
                      <span className="text-zinc-500">({log.actorRole})</span>
                    </span>
                    {log.telemetry?.latencyMs && (
                      <span className="text-zinc-500 font-mono">
                        {log.telemetry.latencyMs}ms
                      </span>
                    )}
                  </div>

                  {log.entityId && (
                    <div className="text-[10px] font-mono text-zinc-500 truncate">
                      Entity: <span className="text-zinc-400">{log.entityId}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
