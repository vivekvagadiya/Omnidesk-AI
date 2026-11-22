import React from 'react';
import { X, FileText, CheckCircle2, Shield, Layers, UploadCloud } from 'lucide-react';
import { useDocumentsQuery } from '../../queries';

export function PolicyLibraryModal({ isOpen, onClose }) {
  const { data, isPending } = useDocumentsQuery({ enabled: isOpen });
  const documents = data?.documents || [];

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-2xl bg-[#0e1118] border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col text-xs text-zinc-200 max-h-[80vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-zinc-800/80 flex items-center justify-between bg-[#11141e]">
          <div className="flex items-center gap-2.5">
            <FileText className="w-4 h-4 text-emerald-400" />
            <div>
              <div className="font-semibold text-zinc-100 text-sm">Indexed Policy Documents</div>
              <div className="text-[11px] font-mono text-zinc-400 mt-0.5">
                Active Ground-Truth Knowledge in Qdrant Vector DB
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-3">
          {isPending ? (
            <div className="text-center py-12 text-zinc-500 font-mono">Loading indexed policies…</div>
          ) : documents.length === 0 ? (
            <div className="text-center py-12 text-zinc-500 border border-dashed border-zinc-800 rounded-xl">
              No policies indexed yet.
            </div>
          ) : (
            documents.map((doc) => (
              <div
                key={doc.documentId}
                className="p-3.5 bg-[#12151d] rounded-xl border border-zinc-800 hover:border-zinc-700 transition-colors"
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-semibold text-zinc-100 text-xs">{doc.name}</span>
                  <span className="text-[9px] font-mono font-bold text-emerald-400 bg-emerald-950/40 border border-emerald-900/60 px-2 py-0.5 rounded flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" /> INDEXED
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-2 mt-2 pt-2 border-t border-zinc-800/60 text-[10px] font-mono text-zinc-400">
                  <div>
                    <span className="text-zinc-500">Department:</span> <strong className="text-zinc-300 font-normal">{doc.department}</strong>
                  </div>
                  <div>
                    <span className="text-zinc-500">Vectors:</span> <strong className="text-zinc-300 font-normal">{doc.totalChunks} chunks</strong>
                  </div>
                  <div>
                    <span className="text-zinc-500">Indexed:</span> <strong className="text-zinc-300 font-normal">{new Date(doc.lastIndexedAt).toLocaleDateString()}</strong>
                  </div>
                </div>

                <div className="mt-2 text-[10px] font-mono text-zinc-500">
                  <span>Allowed Roles: </span>
                  <span className="text-zinc-400">{doc.allowedRoles?.join(', ')}</span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-zinc-800 bg-[#11141e] flex items-center justify-between text-[11px] font-mono text-zinc-400">
          <span className="flex items-center gap-1">
            <Shield className="w-3.5 h-3.5 text-emerald-400" /> RBAC & Org Filtered Retrieval
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
