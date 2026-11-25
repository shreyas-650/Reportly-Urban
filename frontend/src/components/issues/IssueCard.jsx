import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Calendar, MapPin } from 'lucide-react';
import StatusBadge from '../common/StatusBadge';
import { formatDate } from '../../utils/formatters';
import {
  getCategoryLabel,
  isValidUuid,
  sanitizePublicComplaint,
} from '../../services/publicService';

/**
 * Reusable public complaint summary card.
 * Enforces the public field allow-list: title, category, ward, status,
 * submitted_date, and link to /issues/:public_reference (UUID only).
 * Never renders coordinates, descriptions, images, or internal identifiers.
 */
export default function IssueCard({ complaint, fromSearch = '' }) {
  const safe = sanitizePublicComplaint(complaint);
  if (!safe) return null;

  const { public_reference, title, category, ward, status, submitted_date } = safe;
  const hasValidReference = isValidUuid(public_reference || '');
  const linkState =
    typeof fromSearch === 'string' && fromSearch.startsWith('?')
      ? { fromSearch }
      : undefined;

  return (
    <article className="bg-white rounded-xl border border-slate-200/90 hover:border-teal-400 shadow-2xs hover:shadow-sm transition-all p-5 flex flex-col justify-between gap-4 h-full">
      <div className="space-y-2.5">
        <div className="flex items-start justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-teal-700">
            {getCategoryLabel(category)}
          </span>
          <StatusBadge status={status} size="sm" />
        </div>

        <h3 className="text-base font-bold text-slate-900 leading-snug">
          {title}
        </h3>

        <div className="space-y-1 text-xs text-slate-600 pt-1">
          <div className="flex items-center gap-1.5">
            <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <span>{ward || 'Unspecified'}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Calendar className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <span>Submitted {formatDate(submitted_date)}</span>
          </div>
        </div>
      </div>

      {hasValidReference && (
        <div className="pt-3 border-t border-slate-100 flex items-center justify-end">
          <Link
            to={`/issues/${encodeURIComponent(public_reference)}`}
            state={linkState}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-800 hover:text-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-500 rounded px-1 py-0.5 transition-colors"
          >
            <span>View Public Record</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      )}
    </article>
  );
}
