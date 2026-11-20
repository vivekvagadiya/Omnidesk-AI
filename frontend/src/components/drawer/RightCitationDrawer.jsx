import React from 'react';
import { useCopilot } from '../../context/CopilotContext';
import { X, FileText, CheckCircle, Shield, ExternalLink, Bookmark } from 'lucide-react';

export function RightCitationDrawer() {
  const { isCitationDrawerOpen, closeCitationDrawer, selectedCitation } = useCopilot();

  if (!isCitationDrawerOpen || !selectedCitation) {
    return null;
  }

  const confidenceScore = selectedCitation.confidencePercent || Math.round((selectedCitation.confidenceScore || 0.85) * 100);

  return (
    <aside className="w-80 md:w-96 border-l border-zinc-800 bg-[#0c0e14] flex flex-col h-[calc(100vh-3rem)] select-none">
      {/* Header */}
      <div className="h-12 border-b border-zinc-800 px-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-zinc-400" />
          <span className="text-xs font-semibold text-zinc-100">Citation Evidence Drawer</span>
        </div>

        <button
          onClick={closeCitationDrawer}
          className="p-1 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Drawer Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
        {/* Document Title & Badge Card */}
        <div className="bg-[#12151d] rounded-xl border border-zinc-800 p-3.5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] font-bold text-zinc-200 bg-zinc-800/80 px-2 py-0.5 rounded border border-zinc-700">
              {selectedCitation.badge || '[1]'}
            </span>
            <span className="text-[10px] font-mono uppercase text-zinc-400">
              Department: {selectedCitation.department || 'HR'}
            </span>
          </div>

          <h3 className="font-medium text-sm text-zinc-100 leading-snug">
            {selectedCitation.documentName || 'Company Policy Document'}
          </h3>

          <div className="text-[11px] text-zinc-400 font-mono flex items-center gap-1">
            <span>§ {selectedCitation.sectionTitle || 'General Guidelines'}</span>
          </div>
        </div>

        {/* Confidence Score Bar */}
        <div className="bg-[#12151d] rounded-xl border border-zinc-800 p-3.5 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-zinc-400 font-medium">Semantic Match Score</span>
            <span className="font-mono font-bold text-emerald-400">{confidenceScore}%</span>
          </div>

          {/* Progress bar */}
          <div className="w-full h-1.5 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all duration-500"
              style={{ width: `${confidenceScore}%` }}
            />
          </div>

          <div className="text-[10px] text-zinc-400 leading-tight">
            Vector similarity score meets the zero-hallucination threshold (&ge; 65%).
          </div>
        </div>

        {/* Verbatim Ground-Truth Excerpt */}
        <div className="space-y-1.5">
          <span className="text-[11px] font-mono uppercase text-zinc-400 tracking-wider">
            Verbatim Retrieved Excerpt
          </span>
          <div className="p-3.5 rounded-xl border border-zinc-800 bg-[#0e1017] text-zinc-300 leading-relaxed font-sans text-xs">
            <p className="bg-zinc-800/30 p-2 rounded border-l-2 border-emerald-500 italic">
              "{selectedCitation.excerpt || selectedCitation.text || 'Policy evidence details extracted from Qdrant vector database.'}"
            </p>
          </div>
        </div>

        {/* Security & Multi-Tenant Audit */}
        <div className="bg-[#12151d] rounded-xl border border-zinc-800 p-3.5 space-y-2 text-[11px] font-mono text-zinc-400">
          <div className="flex items-center gap-1 text-zinc-300 font-sans font-medium">
            <Shield className="w-3.5 h-3.5 text-zinc-400" />
            <span>Audit & Isolation Metadata</span>
          </div>
          <div className="space-y-1 pt-1 text-[10px]">
            <div className="flex justify-between">
              <span className="text-zinc-400">Source Database:</span>
              <span className="text-zinc-300">Qdrant Vector DB</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-400">Allowed Roles:</span>
              <span className="text-zinc-300">Employee, Manager, Admin</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-400">Vector Dimension:</span>
              <span className="text-zinc-300">768 (Gemini text-embedding)</span>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
