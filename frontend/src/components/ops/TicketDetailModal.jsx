import React, { useState } from 'react';
import { X, Ticket, Clock, CheckCircle2, User, AlertCircle, Shield, ArrowRight, Loader2 } from 'lucide-react';
import { useUpdateTicketMutation, TICKET_SCOPE_ROLES } from '../../queries';
import { useAuth } from '../../context/AuthContext';

export function TicketDetailModal({ isOpen, ticket, onClose }) {
  const { user } = useAuth();
  const updateMutation = useUpdateTicketMutation();
  const [resolutionNotes, setResolutionNotes] = useState('');

  if (!isOpen || !ticket) return null;

  const canManage = TICKET_SCOPE_ROLES.includes(user?.role);
  const isOwner = ticket.userId === user?.userId;

  const handleStatusChange = async (newStatus) => {
    try {
      await updateMutation.mutateAsync({
        ticketId: ticket.ticketId,
        updates: {
          status: newStatus,
          resolutionNotes: newStatus === 'RESOLVED' ? resolutionNotes || 'Resolved by operator' : undefined,
        },
      });
      onClose();
    } catch {
      // Handled in mutation toast
    }
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

  const getStatusBadge = (status) => {
    switch (status) {
      case 'RESOLVED':
        return 'border-emerald-800/80 text-emerald-300 bg-emerald-950/30';
      case 'IN_PROGRESS':
        return 'border-amber-800/80 text-amber-300 bg-amber-950/30';
      case 'REJECTED':
        return 'border-red-800/80 text-red-300 bg-red-950/30';
      default:
        return 'border-zinc-700 text-zinc-300 bg-zinc-800';
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-lg bg-[#0e1118] border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col text-xs text-zinc-200">
        {/* Header */}
        <div className="px-5 py-4 border-b border-zinc-800/80 flex items-center justify-between bg-[#11141e]">
          <div className="flex items-center gap-2">
            <Ticket className="w-4 h-4 text-zinc-400" />
            <span className="font-semibold text-zinc-100 text-sm">Ticket Details</span>
            <span className="font-mono text-[11px] text-zinc-400 bg-zinc-900 px-2 py-0.5 rounded border border-zinc-800">
              {ticket.ticketId}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto">
          {/* Title & Status Pills */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className={`text-[10px] font-mono font-bold uppercase px-2 py-0.5 rounded border ${getStatusBadge(ticket.status)}`}>
                {ticket.status}
              </span>
              <span className={`text-[10px] font-mono font-bold uppercase px-2 py-0.5 rounded border ${getPriorityBadge(ticket.priority)}`}>
                {ticket.priority} PRIORITY
              </span>
              <span className="text-[10px] font-mono text-zinc-400 bg-zinc-900 px-2 py-0.5 rounded border border-zinc-800 uppercase">
                {ticket.category?.replace('_', ' ')}
              </span>
            </div>
            <h3 className="text-sm font-semibold text-zinc-100 leading-snug">{ticket.title}</h3>
          </div>

          {/* Description */}
          <div className="p-3.5 rounded-xl border border-zinc-800/90 bg-[#12151d] space-y-1">
            <span className="text-[10px] font-mono uppercase text-zinc-500 tracking-wider">Description</span>
            <p className="text-zinc-300 leading-relaxed text-xs whitespace-pre-wrap">
              {ticket.description || 'No detailed description provided.'}
            </p>
          </div>

          {/* Metadata Grid */}
          <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
            <div className="p-2.5 rounded-lg border border-zinc-800/80 bg-[#12151d] space-y-0.5">
              <span className="text-zinc-500">Requester</span>
              <div className="text-zinc-200 font-medium truncate flex items-center gap-1">
                <User className="w-3 h-3 text-zinc-400" /> {ticket.userId}
              </div>
            </div>
            <div className="p-2.5 rounded-lg border border-zinc-800/80 bg-[#12151d] space-y-0.5">
              <span className="text-zinc-500">Created Date</span>
              <div className="text-zinc-200 font-medium truncate flex items-center gap-1">
                <Clock className="w-3 h-3 text-zinc-400" /> {new Date(ticket.createdAt).toLocaleDateString()}
              </div>
            </div>
          </div>

          {/* Resolution Notes (if resolving or resolved) */}
          {(canManage || isOwner) && ticket.status !== 'RESOLVED' && (
            <div className="space-y-1.5 pt-2 border-t border-zinc-800/70">
              <label className="text-[10px] font-mono uppercase text-zinc-400">Resolution / Operator Notes</label>
              <textarea
                value={resolutionNotes}
                onChange={(e) => setResolutionNotes(e.target.value)}
                placeholder="Optional notes explaining resolution actions..."
                rows={2}
                className="w-full bg-zinc-950/80 border border-zinc-800 rounded-lg p-2.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
              />
            </div>
          )}

          {ticket.metadata?.resolutionNotes && (
            <div className="p-3 rounded-lg border border-emerald-900/50 bg-emerald-950/20 text-emerald-200 space-y-1">
              <span className="text-[10px] font-mono uppercase text-emerald-400 font-semibold flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" /> Resolution Record
              </span>
              <p className="text-xs">{ticket.metadata.resolutionNotes}</p>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-5 py-3.5 border-t border-zinc-800 bg-[#11141e] flex items-center justify-between">
          <span className="text-[10px] font-mono text-zinc-500">
            {canManage ? 'Manager/Admin Privileges' : 'Requester View'}
          </span>

          <div className="flex items-center gap-2">
            {canManage && ticket.status === 'OPEN' && (
              <button
                type="button"
                onClick={() => handleStatusChange('IN_PROGRESS')}
                disabled={updateMutation.isPending}
                className="px-3 py-1.5 rounded-lg border border-amber-800/80 bg-amber-950/30 text-amber-300 hover:bg-amber-900/40 transition-colors font-medium flex items-center gap-1 text-xs"
              >
                Mark In Progress
              </button>
            )}

            {(canManage || isOwner) && ticket.status !== 'RESOLVED' && (
              <button
                type="button"
                onClick={() => handleStatusChange('RESOLVED')}
                disabled={updateMutation.isPending}
                className="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium transition-colors flex items-center gap-1 text-xs shadow-sm"
              >
                {updateMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                <span>Resolve Ticket</span>
              </button>
            )}

            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
