import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { assetService } from '../services/asset.service';
import { useAuth } from '../context/AuthContext';
import { queryKeys } from './queryKeys';

export function useAssetsQuery({ status, type, assignedTo, enabled = true } = {}) {
  const { user } = useAuth();
  const filters = {};
  if (status) filters.status = status;
  if (type) filters.type = type;
  if (assignedTo) filters.assignedTo = assignedTo;

  return useQuery({
    queryKey: queryKeys.assets.list(filters),
    queryFn: ({ signal }) => assetService.getAssets(filters, { signal }),
    enabled: Boolean(user?.userId) && enabled,
    placeholderData: keepPreviousData,
    meta: { errorTitle: 'Could not fetch hardware assets' },
  });
}

export function useUpdateAssetMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ assetTag, updates }) => assetService.updateAsset(assetTag, updates),
    onSuccess: (asset) => {
      toast.success('Asset Updated', {
        description: `Asset ${asset?.assetTag || ''} status updated to ${asset?.status || ''}.`,
      });
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.assets.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.audit.all }),
      ]);
    },
    meta: { errorTitle: 'Asset Update Failed' },
  });
}
