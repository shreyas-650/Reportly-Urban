import React from 'react';
import { getStatusColor } from '../../utils/formatters';

export default function StatusBadge({ status, size = 'md' }) {
  const colors = getStatusColor(status);
  const sizeStyles = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs';

  return (
    <span
      className={`inline-flex items-center gap-1.5 font-medium rounded-full border ${colors.bg} ${colors.text} ${colors.border} ${sizeStyles}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${colors.dot}`} />
      {status || 'Pending'}
    </span>
  );
}
