import React, { useState } from 'react';
import { X, Laptop, Monitor, Key, HardDrive, Shield, RefreshCw, CheckCircle2, AlertTriangle, Filter } from 'lucide-react';
import { useAssetsQuery, useUpdateAssetMutation } from '../../queries';
import { useAuth } from '../../context/AuthContext';

export function AssetInventoryModal({ isOpen, onClose }) {
  const { user } = useAuth();
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const assetsQuery = useAssetsQuery({
    type: typeFilter || undefined,
    status: statusFilter || undefined,
    enabled: isOpen,
  });

  const updateMutation = useUpdateAssetMutation();
  const assets = assetsQuery.data?.assets || [];

  if (!isOpen) return null;

  const isITAdmin = ['it_admin', 'super_admin', 'org_admin'].includes(user?.role);

  const getStatusBadge = (status) => {
    switch (status) {
      case 'IN_STOCK':
        return 'border-emerald-800/80 text-emerald-300 bg-emerald-950/30';
      case 'ASSIGNED':
        return 'border-blue-800/80 text-blue-300 bg-blue-950/30';
      case 'MAINTENANCE':
        return 'border-amber-800/80 text-amber-300 bg-amber-950/30';
      case 'RETIRED':
        return 'border-zinc-800 text-zinc-500 bg-zinc-900';
      default:
        return 'border-zinc-800 text-zinc-400 bg-zinc-900';
    }
  };

  const getAssetIcon = (type) => {
    switch (type) {
      case 'LAPTOP':
        return <Laptop className="w-4 h-4 text-blue-400" />;
      case 'MONITOR':
        return <Monitor className="w-4 h-4 text-emerald-400" />;
      case 'SOFTWARE_LICENSE':
        return <Key className="w-4 h-4 text-purple-400" />;
      default:
        return <HardDrive className="w-4 h-4 text-zinc-400" />;
    }
  };

  const handleStatusUpdate = async (assetTag, currentStatus) => {
    if (!isITAdmin) return;
    const nextStatus = currentStatus === 'IN_STOCK' ? 'MAINTENANCE' : 'IN_STOCK';
    await updateMutation.mutateAsync({
      assetTag,
      updates: { status: nextStatus },
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-3xl bg-[#0e1118] border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col text-xs text-zinc-200 max-h-[85vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-zinc-800/80 flex items-center justify-between bg-[#11141e]">
          <div className="flex items-center gap-2.5">
            <Laptop className="w-4 h-4 text-emerald-400" />
            <div>
              <div className="font-semibold text-zinc-100 text-sm">Corporate Hardware Asset Hub</div>
              <div className="text-[11px] font-mono text-zinc-400 mt-0.5">
                {isITAdmin ? 'IT Asset Management & Requisition Queue' : 'Assigned Enterprise Hardware'}
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

        {/* Filter Toolbar */}
        <div className="px-6 py-3 border-b border-zinc-800/70 bg-[#0c0e15] flex flex-wrap items-center justify-between gap-3 text-[11px] font-mono">
          <div className="flex items-center gap-2">
            <Filter className="w-3.5 h-3.5 text-zinc-500" />
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1 text-zinc-300 focus:outline-none"
            >
              <option value="">All Categories</option>
              <option value="LAPTOP">Laptops</option>
              <option value="MONITOR">Monitors</option>
              <option value="ACCESSORY">Accessories</option>
              <option value="SOFTWARE_LICENSE">Licenses</option>
            </select>

            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1 text-zinc-300 focus:outline-none"
            >
              <option value="">All Statuses</option>
              <option value="ASSIGNED">Assigned</option>
              <option value="IN_STOCK">In Stock</option>
              <option value="MAINTENANCE">Maintenance</option>
            </select>
          </div>

          <div className="text-zinc-400">
            Total Inventory: <span className="text-zinc-200 font-bold">{assets.length} items</span>
          </div>
        </div>

        {/* Assets Table / List */}
        <div className="flex-1 overflow-y-auto p-6 space-y-3">
          {assetsQuery.isPending ? (
            <div className="text-center py-12 text-zinc-500 font-mono">Loading hardware assets…</div>
          ) : assets.length === 0 ? (
            <div className="text-center py-12 text-zinc-500 border border-dashed border-zinc-800 rounded-xl">
              No assets matching current filter criteria.
            </div>
          ) : (
            <div className="grid gap-2.5">
              {assets.map((asset) => (
                <div
                  key={asset.assetTag}
                  className="p-3.5 bg-[#12151d] rounded-xl border border-zinc-800/90 hover:border-zinc-700 transition-colors flex items-center justify-between gap-4"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center flex-shrink-0">
                      {getAssetIcon(asset.type)}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10px] text-zinc-400 bg-zinc-950 px-1.5 py-0.2 rounded border border-zinc-800">
                          {asset.assetTag}
                        </span>
                        <span className="font-medium text-zinc-100 text-xs">{asset.model}</span>
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-[11px] font-mono text-zinc-500">
                        <span>Category: {asset.type}</span>
                        <span>•</span>
                        <span>Assigned to: <strong className="text-zinc-300 font-normal">{asset.assignedTo || 'Unassigned (Stock)'}</strong></span>
                        {asset.cost ? <span>• Value: ${asset.cost}</span> : null}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className={`text-[10px] font-mono font-bold uppercase px-2 py-0.5 rounded border ${getStatusBadge(asset.status)}`}>
                      {asset.status}
                    </span>

                    {isITAdmin && (
                      <button
                        onClick={() => handleStatusUpdate(asset.assetTag, asset.status)}
                        disabled={updateMutation.isPending}
                        title="Toggle Maintenance / In-Stock"
                        className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white text-[10px] font-mono border border-zinc-700 transition-colors"
                      >
                        Toggle Status
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-zinc-800 bg-[#11141e] flex items-center justify-between text-[11px] font-mono text-zinc-400">
          <span className="flex items-center gap-1.5">
            <Shield className="w-3.5 h-3.5 text-emerald-400" /> Multi-Tenant Asset Isolation Enforced
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
