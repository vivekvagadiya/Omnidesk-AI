import React, { useState, useEffect } from 'react';
import { useCopilot } from '../../context/CopilotContext';
import { Check, X, Clock, ShieldAlert, CheckCircle2, AlertCircle } from 'lucide-react';

export function HitlApprovalCard({ stagedAction }) {
  const { approveAction, rejectAction } = useCopilot();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState(900); // 15 mins default

  const { actionId, type, card, status, result } = stagedAction;

  // Countdown timer simulation for 15-minute token TTL
  useEffect(() => {
    if (status !== 'PENDING') return;

    const timer = setInterval(() => {
      setSecondsRemaining((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);

    return () => clearInterval(timer);
  }, [status]);

  const formatTime = (secs) => {
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    return `${mins}:${rem < 10 ? '0' : ''}${rem}`;
  };

  const handleApprove = async () => {
    setIsSubmitting(true);
    try {
      await approveAction(actionId);
    } catch {
      // Handled in context
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReject = async () => {
    setIsSubmitting(true);
    try {
      await rejectAction(actionId);
    } catch {
      // Handled in context
    } finally {
      setIsSubmitting(false);
    }
  };

  const isApproved = status === 'APPROVED';
  const isRejected = status === 'REJECTED';

  return (
    <div
      className={`my-3 rounded-xl border p-4 text-xs transition-colors ${
        isApproved
          ? 'bg-[#0f1713] border-emerald-900/60 text-emerald-200'
          : isRejected
          ? 'bg-[#181113] border-red-900/60 text-red-200'
          : 'bg-[#14161f] border-amber-800/60 text-zinc-200'
      }`}
    >
      {/* Card Header */}
      <div className="flex items-center justify-between pb-3 border-b border-zinc-800/80">
        <div className="flex items-center gap-2">
          <ShieldAlert
            className={`w-4 h-4 ${
              isApproved
                ? 'text-emerald-400'
                : isRejected
                ? 'text-red-400'
                : 'text-amber-400'
            }`}
          />
          <span className="font-semibold text-zinc-100">
            {card?.title || `Consequential Action: ${type}`}
          </span>
        </div>

        {/* Status or Expiration Timer */}
        {status === 'PENDING' ? (
          <div className="flex items-center gap-1 font-mono text-[11px] text-amber-400 bg-amber-950/40 border border-amber-800/50 px-2 py-0.5 rounded">
            <Clock className="w-3 h-3" />
            <span>Expires in {formatTime(secondsRemaining)}</span>
          </div>
        ) : isApproved ? (
          <div className="flex items-center gap-1 text-[11px] font-mono text-emerald-400 bg-emerald-950/40 border border-emerald-800/50 px-2 py-0.5 rounded">
            <CheckCircle2 className="w-3 h-3" />
            <span>APPROVED & COMMITTED</span>
          </div>
        ) : (
          <div className="flex items-center gap-1 text-[11px] font-mono text-red-400 bg-red-950/40 border border-red-800/50 px-2 py-0.5 rounded">
            <AlertCircle className="w-3 h-3" />
            <span>CANCELLED</span>
          </div>
        )}
      </div>

      {/* Summary Description */}
      <div className="py-2.5 text-zinc-300 leading-relaxed">
        {card?.summary || 'Human confirmation required before mutating enterprise database records.'}
      </div>

      {/* Structured Details Table */}
      {card?.details && (
        <div className="my-2 bg-[#0b0c10] rounded-lg border border-zinc-800/80 p-3 space-y-1.5 font-mono text-[11px]">
          {Object.entries(card.details).map(([key, value]) => (
            <div key={key} className="flex justify-between items-center">
              <span className="text-zinc-500">{key}:</span>
              <span className="text-zinc-200 font-medium">{String(value)}</span>
            </div>
          ))}
          {isApproved && result?.details?.remainingBalance !== undefined && (
            <div className="flex justify-between items-center text-emerald-400 font-bold pt-1 border-t border-zinc-800/60">
              <span>Updated Balance:</span>
              <span>{result.details.remainingBalance} day(s)</span>
            </div>
          )}
        </div>
      )}

      {/* Action Buttons (Only visible while PENDING) */}
      {status === 'PENDING' && (
        <div className="pt-3 flex items-center justify-end gap-2">
          <button
            onClick={handleReject}
            disabled={isSubmitting}
            className="px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900/80 text-zinc-300 hover:text-white hover:bg-zinc-800 active:scale-[0.98] transition-all flex items-center gap-1.5 font-medium disabled:opacity-50"
          >
            <X className="w-3.5 h-3.5" />
            <span>Reject</span>
          </button>

          <button
            onClick={handleApprove}
            disabled={isSubmitting}
            className="px-4 py-1.5 rounded-lg bg-zinc-100 text-zinc-950 hover:bg-white active:scale-[0.98] transition-all flex items-center gap-1.5 font-medium disabled:opacity-50"
          >
            <Check className="w-3.5 h-3.5 stroke-[2.5]" />
            <span>{isSubmitting ? 'Committing...' : 'Approve & Execute'}</span>
          </button>
        </div>
      )}
    </div>
  );
}
