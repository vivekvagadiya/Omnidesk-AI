import React, { useState } from 'react';
import { useCopilot } from '../../context/CopilotContext';
import { useCreateTicketMutation } from '../../queries';
import { X, Tag, AlertTriangle } from 'lucide-react';

export function CreateTicketModal({ isOpen, onClose }) {
  const { incrementNotifications } = useCopilot();
  const createTicket = useCreateTicketMutation();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('IT_HARDWARE');
  const [priority, setPriority] = useState('MEDIUM');
  const isSubmitting = createTicket.isPending;
  const error = createTicket.error?.message || null;

  if (!isOpen) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!title.trim() || isSubmitting) return;

    createTicket.mutate(
      { title: title.trim(), description: description.trim(), category, priority },
      {
        onSuccess: () => {
          incrementNotifications();
          setTitle('');
          setDescription('');
          createTicket.reset();
          onClose();
        },
      }
    );
  };

  const handleClose = () => {
    createTicket.reset(); // don't show a stale error next time the modal opens
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-[#0f1118] border border-zinc-800 rounded-xl p-5 shadow-2xl text-xs text-zinc-100">
        <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <Tag className="w-4 h-4 text-zinc-400" />
            <span className="font-semibold text-sm">Create Support Ticket</span>
          </div>
          <button
            onClick={handleClose}
            className="p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="mt-3 p-2 bg-red-950/40 border border-red-900/60 rounded text-red-300 text-[11px]">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-3.5">
          <div>
            <label className="block text-zinc-400 font-medium mb-1">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. MacBook Pro Thunderbolt dock disconnecting"
              required
              className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-none focus:border-zinc-600 placeholder:text-zinc-600 text-xs"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-zinc-400 font-medium mb-1">Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full px-2.5 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 focus:outline-none focus:border-zinc-600 text-xs font-mono"
              >
                <option value="IT_HARDWARE">IT Hardware</option>
                <option value="IT_ACCESS">IT Access / VPN</option>
                <option value="HR_LEAVE">HR Leave</option>
                <option value="HR_BENEFITS">HR Benefits</option>
                <option value="GENERAL">General Request</option>
              </select>
            </div>

            <div>
              <label className="block text-zinc-400 font-medium mb-1">Priority</label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="w-full px-2.5 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 focus:outline-none focus:border-zinc-600 text-xs font-mono"
              >
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
                <option value="CRITICAL">Critical</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-zinc-400 font-medium mb-1">Details & Context</label>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Provide relevant details or error logs..."
              className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-none focus:border-zinc-600 placeholder:text-zinc-600 text-xs resize-none"
            />
          </div>

          <div className="pt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={handleClose}
              className="px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-1.5 rounded-lg bg-zinc-100 text-zinc-950 font-medium hover:bg-white disabled:opacity-50"
            >
              {isSubmitting ? 'Submitting...' : 'Submit Ticket'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
