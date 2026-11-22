import React, { useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '../../context/AuthContext';
import { useLeaveBalanceQuery, useTicketsQuery, useUploadDocumentMutation } from '../../queries';
import { CreateTicketModal } from '../ops/CreateTicketModal';
import { TicketDetailModal } from '../ops/TicketDetailModal';
import { AssetInventoryModal } from '../ops/AssetInventoryModal';
import { PolicyLibraryModal } from '../ops/PolicyLibraryModal';
import {
  Calendar,
  Ticket,
  UploadCloud,
  Plus,
  Building,
  Briefcase,
  AlertCircle,
  FileCheck2,
  FileText,
  Laptop,
  Layers,
  ChevronRight,
} from 'lucide-react';

export function LeftOpsPanel() {
  const { user } = useAuth();
  const [ticketScope, setTicketScope] = useState('mine'); // 'mine' | 'all'
  const [isTicketModalOpen, setIsTicketModalOpen] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [isAssetModalOpen, setIsAssetModalOpen] = useState(false);
  const [isPolicyModalOpen, setIsPolicyModalOpen] = useState(false);

  const balanceQuery = useLeaveBalanceQuery();
  const leaveBalance = balanceQuery.data;
  const ticketsQuery = useTicketsQuery({ scope: ticketScope });
  const tickets = ticketsQuery.data?.tickets ?? [];
  const uploadMutation = useUploadDocumentMutation();

  // Show a dash until the real balance arrives (never fake default numbers)
  const formatDays = (value) => (value ?? '—');
  const quotaPercent = (value, total) => (value == null ? 0 : Math.min(100, (value / total) * 100));

  // Document upload state
  const [uploadStatus, setUploadStatus] = useState(null); // 'uploading' | 'success' | 'error'
  const [uploadMessage, setUploadMessage] = useState('');

  const canUploadPolicy = ['org_admin', 'super_admin', 'hr_admin', 'it_admin', 'manager'].includes(
    user?.role
  );

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadStatus('uploading');
    setUploadMessage('Validating & chunking document into Qdrant...');

    const uploadPromise = uploadMutation.mutateAsync({ file, department: user?.department });
    e.target.value = ''; // allow re-uploading the same file

    toast.promise(uploadPromise, {
      loading: `Vectorizing & indexing ${file.name}...`,
      success: (res) => {
        setUploadStatus('success');
        const count = res.data?.totalChunks || 1;
        const msg = `Indexed ${count} chunk(s) into Qdrant (${res.data?.department || user?.department}).`;
        setUploadMessage(msg);
        setTimeout(() => {
          setUploadStatus(null);
          setUploadMessage('');
        }, 5000);
        return `Successfully indexed ${file.name} into Qdrant`;
      },
      error: (err) => {
        setUploadStatus('error');
        const msg = err.message || 'Upload failed';
        setUploadMessage(msg);
        return msg;
      },
    });
  };

  const getPriorityBadge = (priority) => {
    switch (priority) {
      case 'CRITICAL':
        return 'border-red-800/80 text-red-300 bg-red-950/30';
      case 'HIGH':
        return 'border-orange-800/80 text-orange-300 bg-orange-950/30';
      case 'MEDIUM':
        return 'border-blue-800/80 text-blue-300 bg-blue-950/30';
      default:
        return 'border-zinc-800 text-zinc-400 bg-zinc-900';
    }
  };

  return (
    <aside className="w-64 md:w-72 border-r border-zinc-800/90 bg-[#0c0e14] flex flex-col h-[calc(100vh-3rem)] select-none">
      <div className="flex-1 overflow-y-auto p-3.5 space-y-4 text-xs">
        
        {/* User Identity Card */}
        <div className="p-3 bg-[#11131a] rounded-xl border border-zinc-800 space-y-2">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-zinc-800 border border-zinc-700 flex items-center justify-center font-bold text-xs text-zinc-200">
              {user?.name
                ? user.name
                    .split(' ')
                    .map((n) => n[0])
                    .join('')
                : 'U'}
            </div>
            <div>
              <div className="font-medium text-zinc-100 text-xs leading-tight">{user?.name}</div>
              <div className="text-[11px] text-zinc-400 font-mono mt-0.5">{user?.email}</div>
            </div>
          </div>

          <div className="pt-2 border-t border-zinc-800/60 flex items-center justify-between text-[10px] font-mono text-zinc-400">
            <span className="flex items-center gap-1">
              <Briefcase className="w-3 h-3 text-zinc-400" />
              {user?.department}
            </span>
            <span className="flex items-center gap-1">
              <Building className="w-3 h-3 text-zinc-400" />
              {user?.orgId}
            </span>
          </div>
        </div>

        {/* Live Leave Quota Card */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-mono uppercase text-zinc-400 tracking-wider flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5 text-zinc-400" /> Leave Balances
            </span>
            <span className="text-[10px] font-mono text-zinc-400">
              {balanceQuery.isError ? (
                <button type="button" onClick={() => balanceQuery.refetch()} className="text-red-400 hover:text-red-300">
                  Retry
                </button>
              ) : balanceQuery.isFetching ? (
                'Syncing…'
              ) : (
                `${new Date().getFullYear()} Quota`
              )}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {/* Casual Leave */}
            <div className="p-2.5 bg-[#11131a] rounded-xl border border-zinc-800">
              <div className="flex justify-between items-baseline mb-1">
                <span className="text-[11px] text-zinc-400">Casual</span>
                <span className="font-mono font-bold text-sm text-zinc-100">
                  {formatDays(leaveBalance?.casual)}
                  <span className="text-[10px] text-zinc-400 font-normal">/12d</span>
                </span>
              </div>
              <div className="w-full h-1 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500 rounded-full transition-all duration-300"
                  style={{ width: `${quotaPercent(leaveBalance?.casual, 12)}%` }}
                />
              </div>
            </div>

            {/* Sick Leave */}
            <div className="p-2.5 bg-[#11131a] rounded-xl border border-zinc-800">
              <div className="flex justify-between items-baseline mb-1">
                <span className="text-[11px] text-zinc-400">Sick</span>
                <span className="font-mono font-bold text-sm text-zinc-100">
                  {formatDays(leaveBalance?.sick)}
                  <span className="text-[10px] text-zinc-400 font-normal">/7d</span>
                </span>
              </div>
              <div className="w-full h-1 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-300"
                  style={{ width: `${quotaPercent(leaveBalance?.sick, 7)}%` }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Hardware Assets Hub Shortcut */}
        <div className="p-2.5 bg-[#11131a] rounded-xl border border-zinc-800 flex items-center justify-between hover:border-zinc-700 transition-colors">
          <div className="flex items-center gap-2">
            <Laptop className="w-3.5 h-3.5 text-blue-400" />
            <div>
              <div className="text-xs font-medium text-zinc-200">Hardware Assets</div>
              <div className="text-[10px] text-zinc-500 font-mono">
                {user?.role === 'it_admin' ? 'Inventory & Requisitions' : 'Assigned Devices'}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setIsAssetModalOpen(true)}
            className="px-2 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-[10px] font-mono text-zinc-300 border border-zinc-800 transition-colors flex items-center gap-0.5"
          >
            <span>View</span>
            <ChevronRight className="w-3 h-3 text-zinc-500" />
          </button>
        </div>

        {/* Tickets Hub */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-mono uppercase text-zinc-400 tracking-wider flex items-center gap-1.5">
              <Ticket className="w-3.5 h-3.5 text-zinc-400" /> Active Tickets
            </span>
            <button
              onClick={() => setIsTicketModalOpen(true)}
              className="p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors flex items-center gap-0.5 text-[10px] font-mono"
            >
              <Plus className="w-3 h-3" /> New
            </button>
          </div>

          {/* Manager / Admin Scope Toggle */}
          {user?.role && user.role !== 'employee' && (
            <div className="flex rounded-lg bg-zinc-900/90 p-0.5 border border-zinc-800 text-[10px] font-mono">
              <button
                type="button"
                onClick={() => setTicketScope('mine')}
                className={`flex-1 py-1 rounded text-center transition-colors ${
                  ticketScope === 'mine'
                    ? 'bg-zinc-800 text-zinc-100 font-medium'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                My Tickets
              </button>
              <button
                type="button"
                onClick={() => setTicketScope('all')}
                className={`flex-1 py-1 rounded text-center transition-colors ${
                  ticketScope === 'all'
                    ? 'bg-zinc-800 text-zinc-100 font-medium'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                Team / Org
              </button>
            </div>
          )}

          <div
            className={`space-y-1.5 max-h-48 overflow-y-auto pr-0.5 transition-opacity ${
              ticketsQuery.isPlaceholderData ? 'opacity-60' : ''
            }`}
          >
            {ticketsQuery.isPending ? (
              <div className="p-4 rounded-lg border border-dashed border-zinc-800 text-center text-[11px] text-zinc-500">
                Loading tickets…
              </div>
            ) : ticketsQuery.isError && tickets.length === 0 ? (
              <div className="p-3 rounded-lg border border-red-900/60 bg-red-950/20 text-center text-[11px] text-red-300 space-y-1.5">
                <div>{ticketsQuery.error.message}</div>
                <button
                  type="button"
                  onClick={() => ticketsQuery.refetch()}
                  className="font-mono text-[10px] underline hover:text-red-200"
                >
                  Try again
                </button>
              </div>
            ) : tickets.length > 0 ? (
              tickets.map((t) => (
                <div
                  key={t.ticketId || t._id}
                  onClick={() => setSelectedTicket(t)}
                  role="button"
                  tabIndex={0}
                  className="p-2 bg-[#11131a] rounded-lg border border-zinc-800 hover:border-zinc-600 hover:bg-zinc-850 cursor-pointer transition-all active:scale-[0.99]"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-mono text-[10px] text-zinc-400">{t.ticketId}</span>
                    <span
                      className={`text-[9px] font-mono font-bold uppercase px-1 py-0.2 rounded border ${getPriorityBadge(
                        t.priority
                      )}`}
                    >
                      {t.priority}
                    </span>
                  </div>
                  <div className="text-xs font-medium text-zinc-200 truncate">{t.title}</div>
                  <div className="flex items-center justify-between mt-1 text-[10px] text-zinc-400">
                    <span>{t.category?.replace('_', ' ')}</span>
                    <span className="font-mono text-emerald-400">{t.status}</span>
                  </div>
                </div>
              ))
            ) : (
              <div className="p-4 rounded-lg border border-dashed border-zinc-800 text-center text-[11px] text-zinc-400">
                No active tickets
              </div>
            )}
          </div>
        </div>

        {/* Policy Ingestion Dropzone (Admins & Managers) */}
        {canUploadPolicy && (
          <div className="space-y-2 pt-2 border-t border-zinc-800/80">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-mono uppercase text-zinc-400 tracking-wider flex items-center gap-1.5">
                <UploadCloud className="w-3.5 h-3.5 text-zinc-400" /> Policy Ingestion
              </span>
              <button
                type="button"
                onClick={() => setIsPolicyModalOpen(true)}
                className="text-[10px] font-mono text-zinc-400 hover:text-emerald-400 underline transition-colors"
              >
                View Library
              </button>
            </div>

            <label className="block p-3 rounded-xl border border-dashed border-zinc-800 hover:border-zinc-700 bg-[#11131a] cursor-pointer text-center transition-colors group">
              <input
                type="file"
                accept=".pdf,.md,.txt"
                onChange={handleFileUpload}
                disabled={uploadStatus === 'uploading'}
                className="hidden"
              />
              <FileText className="w-5 h-5 text-zinc-400 group-hover:text-zinc-300 mx-auto mb-1.5 transition-colors" />
              <div className="text-xs font-medium text-zinc-300">Upload Policy File</div>
              <div className="text-[10px] text-zinc-400 mt-0.5">.pdf, .md, or .txt (Max 10MB)</div>
            </label>

            {uploadStatus && (
              <div
                className={`p-2 rounded text-[11px] flex items-center gap-1.5 ${
                  uploadStatus === 'success'
                    ? 'bg-emerald-950/40 text-emerald-300 border border-emerald-900/60'
                    : uploadStatus === 'error'
                    ? 'bg-red-950/40 text-red-300 border border-red-900/60'
                    : 'bg-zinc-900 text-zinc-300 border border-zinc-800'
                }`}
              >
                {uploadStatus === 'success' ? (
                  <FileCheck2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                ) : (
                  <AlertCircle className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
                )}
                <span className="truncate">{uploadMessage}</span>
              </div>
            )}
          </div>
        )}

      </div>

      <CreateTicketModal
        isOpen={isTicketModalOpen}
        onClose={() => setIsTicketModalOpen(false)}
      />

      <TicketDetailModal
        isOpen={Boolean(selectedTicket)}
        ticket={selectedTicket}
        onClose={() => setSelectedTicket(null)}
      />

      <AssetInventoryModal
        isOpen={isAssetModalOpen}
        onClose={() => setIsAssetModalOpen(false)}
      />

      <PolicyLibraryModal
        isOpen={isPolicyModalOpen}
        onClose={() => setIsPolicyModalOpen(false)}
      />
    </aside>
  );
}
