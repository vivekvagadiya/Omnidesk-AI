import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { auditService } from '../services/audit.service';
import { useAuth } from '../context/AuthContext';
import { queryKeys } from './queryKeys';

export function useAuditLogsQuery({ action, actorId, limit = 50, enabled = true } = {}) {
  const { user } = useAuth();
  const filters = { limit };
  if (action) filters.action = action;
  if (actorId) filters.actorId = actorId;

  return useQuery({
    queryKey: queryKeys.audit.list(filters),
    queryFn: ({ signal }) => auditService.getAuditLogs(filters, { signal }),
    enabled: Boolean(user?.userId) && enabled,
    placeholderData: keepPreviousData,
    refetchInterval: enabled ? 60000 : false,
    meta: { errorTitle: 'Could not fetch audit logs' },
  });
}
