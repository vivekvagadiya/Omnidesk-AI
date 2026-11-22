import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { copilotService } from '../services/copilot.service';
import { queryKeys } from './queryKeys';

/**
 * Which cached data each copilot tool can change. Used after a chat turn and after
 * HITL approvals so the side panels refresh without a manual reload.
 */
const TOOL_INVALIDATIONS = {
  createTicket: [queryKeys.tickets.all, queryKeys.notifications.all, queryKeys.audit.all],
  applyLeave: [queryKeys.profile.all, queryKeys.tickets.all, queryKeys.audit.all],
  requestHardwareUpgrade: [queryKeys.tickets.all, queryKeys.audit.all],
};

/**
 * Returns a function that refreshes the queries affected by the given tool names.
 */
export function useInvalidateForTools() {
  const queryClient = useQueryClient();

  return useCallback(
    (toolNames = []) => {
      const keys = new Map();
      for (const tool of toolNames) {
        for (const key of TOOL_INVALIDATIONS[tool] || []) keys.set(key.join('/'), key);
      }
      return Promise.all([...keys.values()].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
    },
    [queryClient]
  );
}

/**
 * Approve a staged HITL action. Leave approval changes balance and tickets;
 * hardware requests create a ticket — refresh both.
 */
export function useApproveActionMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (actionId) => copilotService.approveAction(actionId),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.profile.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tickets.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.audit.all }),
      ]),
    meta: { errorTitle: 'Approval Failed' },
  });
}

export function useRejectActionMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (actionId) => copilotService.rejectAction(actionId),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.audit.all }),
      ]),
    meta: { errorTitle: 'Rejection Failed' },
  });
}

export function useUploadDocumentMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ file, department, allowedRoles }) => copilotService.uploadDocument(file, department, allowedRoles),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.documents.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.audit.all }),
      ]),
    // No errorTitle: the upload panel reports progress and errors itself
  });
}

export function useDocumentsQuery({ enabled = true } = {}) {
  return useQuery({
    queryKey: queryKeys.documents.list(),
    queryFn: ({ signal }) => copilotService.listDocuments({ signal }),
    enabled,
    meta: { errorTitle: 'Could not fetch policy documents' },
  });
}
