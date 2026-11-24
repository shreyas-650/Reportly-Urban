import React from 'react';
import { getPriorityColor, formatPriorityLabel } from '../../utils/formatters';

export default function PriorityBadge({ priority, size = 'md' }) {
  const colors = getPriorityColor(priority);
  const sizeStyles = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs';

  return (
    <span
      className={`inline-flex items-center gap-1.5 font-medium rounded-full border ${colors.bg} ${colors.text} ${colors.border} ${sizeStyles}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${colors.dot}`} />
      {formatPriorityLabel(priority)}
    </span>
  );
}
