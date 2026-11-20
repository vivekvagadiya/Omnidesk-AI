import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useCopilot } from '../../context/CopilotContext';
import { HitlApprovalCard } from '../cards/HitlApprovalCard';
import {
  Send,
  Sparkles,
  Loader2,
  Search,
  ArrowUpRight,
  RotateCcw,
  FileText,
  Shield,
  Layers,
} from 'lucide-react';

export function ChatContainer() {
  const {
    sessionId,
    messages,
    sendMessage,
    clearChat,
    isStreaming,
    activeToolPill,
    openCitation,
    closeCitationDrawer,
    isCitationDrawerOpen,
    citationsList,
  } = useCopilot();

  const [input, setInput] = useState('');
  const messagesEndRef = useRef(null);

  // Auto-scroll on new tokens or messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming, activeToolPill]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!input.trim() || isStreaming) return;
    sendMessage(input.trim());
    setInput('');
  };

  const handlePromptChip = (chipText) => {
    if (isStreaming) return;
    sendMessage(chipText);
  };

  // Custom markdown component to transform [1], [2] into interactive clickable citation badges
  const renderMessageContent = (text, citations = []) => {
    // Regex matches [1], [2], etc.
    const parts = [];
    const citationRegex = /\[(\d+)\]/g;
    let lastIndex = 0;
    let match;

    while ((match = citationRegex.exec(text)) !== null) {
      const matchIndex = match.index;
      const badgeStr = match[0]; // e.g. '[1]'

      // Add text leading up to badge
      if (matchIndex > lastIndex) {
        parts.push(text.substring(lastIndex, matchIndex));
      }

      // Add interactive citation button
      parts.push(
        <button
          key={`cite_${matchIndex}`}
          onClick={() => openCitation(badgeStr)}
          title={`Click to view policy citation ${badgeStr}`}
          className="inline-flex items-center gap-0.5 mx-1 px-1.5 py-0.2 rounded font-mono text-[10px] font-bold bg-[#171b26] border border-zinc-700 text-zinc-200 hover:text-white hover:border-zinc-500 active:scale-95 transition-all select-none align-baseline cursor-pointer"
        >
          <span>{badgeStr}</span>
          <ArrowUpRight className="w-2.5 h-2.5 text-zinc-400" />
        </button>
      );

      lastIndex = matchIndex + badgeStr.length;
    }

    if (lastIndex < text.length) {
      parts.push(text.substring(lastIndex));
    }

    return (
      <div className="prose prose-invert prose-xs max-w-none text-xs leading-relaxed text-zinc-200">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {text}
        </ReactMarkdown>
      </div>
    );
  };

  return (
    <main className="flex-1 flex flex-col h-[calc(100vh-3rem)] bg-[#090a0f] overflow-hidden">
      {/* Session Sub-Header Bar (Sprint 5 Deliverable) */}
      <div className="h-10 border-b border-zinc-800/80 bg-[#0d0f15] px-4 flex items-center justify-between select-none">
        <div className="flex items-center gap-2 text-xs">
          <div className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-400 bg-zinc-900 border border-zinc-800 px-2 py-0.5 rounded">
            <span className="text-zinc-500">Session:</span>
            <span className="text-zinc-200">{sessionId.substring(0, 14)}...</span>
          </div>

          <div className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-400 bg-zinc-900 border border-zinc-800 px-2 py-0.5 rounded">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-zinc-300">Gemini 3.8 Flash</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {citationsList.length > 0 && (
            <button
              onClick={() => {
                if (isCitationDrawerOpen) closeCitationDrawer();
                else openCitation(citationsList[0]);
              }}
              className="px-2 py-1 rounded text-[11px] font-mono border border-zinc-800 text-zinc-300 hover:text-white hover:bg-zinc-800/60 transition-colors flex items-center gap-1.5"
            >
              <FileText className="w-3 h-3 text-emerald-400" />
              <span>Evidence ({citationsList.length})</span>
            </button>
          )}

          <button
            onClick={clearChat}
            disabled={isStreaming}
            title="Start new conversation turn"
            className="px-2 py-1 rounded text-[11px] font-mono border border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 transition-colors flex items-center gap-1.5 disabled:opacity-50"
          >
            <RotateCcw className="w-3 h-3" />
            <span>Clear Chat</span>
          </button>
        </div>
      </div>

      {/* Messages Scroll Area */}
      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6 space-y-6">
        {messages.map((msg) => {
          const isUser = msg.sender === 'user';

          return (
            <div
              key={msg.id}
              className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
            >
              <div className="flex items-center gap-1.5 mb-1 text-[11px] font-mono text-zinc-500">
                <span>{isUser ? 'You' : 'OmniDesk Copilot'}</span>
                <span>•</span>
                <span>{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </div>

              <div
                className={`max-w-2xl rounded-2xl px-4 py-3 text-xs ${
                  isUser
                    ? 'bg-zinc-800 text-zinc-100 rounded-tr-sm border border-zinc-700'
                    : 'bg-[#11131a] text-zinc-200 rounded-tl-sm border border-zinc-800/90'
                }`}
              >
                {msg.text ? (
                  renderMessageContent(msg.text, msg.citations)
                ) : isStreaming ? (
                  <div className="flex items-center gap-1.5 py-1 text-zinc-400 font-mono text-xs">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Thinking...</span>
                  </div>
                ) : null}

                {/* Staged Consequential Action Card */}
                {msg.stagedAction && (
                  <HitlApprovalCard stagedAction={msg.stagedAction} />
                )}
              </div>
            </div>
          );
        })}

        {/* Live Active Tool Pill Indicator */}
        {activeToolPill && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#11141c] border border-zinc-800 text-xs text-zinc-300 w-fit animate-pulse font-mono">
            <Search className="w-3.5 h-3.5 text-emerald-400" />
            <span>{activeToolPill.status || 'Executing enterprise tool...'}</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Bottom Input Area & Quick Chips */}
      <div className="p-4 border-t border-zinc-800/80 bg-[#0d0f14]">
        <div className="max-w-3xl mx-auto space-y-2.5">
          {/* Quick Prompt Chips */}
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1 text-[11px]">
            <span className="text-zinc-600 font-mono flex items-center gap-1 pl-1">
              <Sparkles className="w-3 h-3 text-zinc-500" /> Prompts:
            </span>
            {[
              'What is the casual leave policy?',
              'What is my current leave balance?',
              'Apply for 2 days casual leave starting 2026-12-05',
              'Show my active tickets',
            ].map((chip) => (
              <button
                key={chip}
                onClick={() => handlePromptChip(chip)}
                disabled={isStreaming}
                className="whitespace-nowrap px-2.5 py-1 rounded-md border border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-zinc-100 hover:border-zinc-700 hover:bg-zinc-800 transition-colors select-none disabled:opacity-50"
              >
                {chip}
              </button>
            ))}
          </div>

          {/* Chat Input Form */}
          <form
            onSubmit={handleSubmit}
            className="flex items-center gap-2 p-1.5 bg-[#12151c] rounded-xl border border-zinc-800 focus-within:border-zinc-600 transition-colors"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask OmniDesk Copilot or query company policies..."
              disabled={isStreaming}
              className="flex-1 bg-transparent px-3 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none disabled:opacity-50 font-sans"
            />

            <button
              type="submit"
              disabled={!input.trim() || isStreaming}
              className="p-2 rounded-lg bg-zinc-100 text-zinc-950 hover:bg-white active:scale-95 transition-all disabled:opacity-30 disabled:pointer-events-none"
            >
              {isStreaming ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Send className="w-3.5 h-3.5" />
              )}
            </button>
          </form>

          <div className="flex justify-between items-center text-[10px] text-zinc-400 font-mono px-1">
            <span>PII Redacted with surrogate tokens • Evidence citations verified with Qdrant</span>
            <span>Return ↵ to send</span>
          </div>
        </div>
      </div>
    </main>
  );
}
