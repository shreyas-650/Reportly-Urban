import React from 'react';
import { Link } from 'react-router-dom';
import { MapPin, Calendar, ArrowRight, Clock } from 'lucide-react';
import StatusBadge from '../common/StatusBadge';
import { formatDate } from '../../utils/formatters';

export default function IssueCard({ complaint }) {
  const {
    id,
    title,
    categoryName,
    location,
    ward,
    reportedDate,
    status,
    image,
    department
  } = complaint;

  return (
    <article className="group bg-white rounded-xl border border-slate-200/90 hover:border-blue-300 shadow-xs hover:shadow-md transition-all duration-200 overflow-hidden flex flex-col h-full">
      {/* Thumbnail */}
      <div className="relative aspect-video w-full bg-slate-100 overflow-hidden">
        <img
          src={image}
          alt={title}
          loading="lazy"
          className="w-full h-full object-cover group-hover:scale-102 transition-transform duration-300"
          onError={(e) => {
            e.target.onerror = null;
            e.target.src = 'https://images.unsplash.com/photo-1515162816999-a0c47dc192f7?auto=format&fit=crop&w=800&q=80';
          }}
        />
        <div className="absolute top-3 left-3">
          <StatusBadge status={status} size="sm" />
        </div>
        <div className="absolute top-3 right-3 bg-slate-900/70 backdrop-blur-xs text-white text-[11px] font-mono px-2 py-0.5 rounded-md">
          {id}
        </div>
      </div>

      {/* Content */}
      <div className="p-4 sm:p-5 flex flex-col flex-1">
        <div className="mb-2">
          <span className="text-xs font-semibold text-blue-600 uppercase tracking-wider">
            {categoryName}
          </span>
          <h3 className="text-base font-bold text-slate-900 mt-1 line-clamp-1 group-hover:text-blue-600 transition-colors">
            {title}
          </h3>
        </div>

        <p className="text-xs text-slate-600 line-clamp-2 mb-4 leading-relaxed">
          {complaint.description}
        </p>

        {/* Metadata */}
        <div className="mt-auto pt-3 border-t border-slate-100 space-y-1.5 text-xs text-slate-500">
          <div className="flex items-center gap-1.5 truncate">
            <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <span className="truncate">{location} {ward ? `• ${ward}` : ''}</span>
          </div>
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <span className="flex items-center gap-1">
              <Calendar className="w-3.5 h-3.5" />
              {formatDate(reportedDate)}
            </span>
            <span className="truncate max-w-[140px] text-right">
              {department}
            </span>
          </div>
        </div>

        {/* Action */}
        <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between">
          <span className="text-xs text-slate-400 font-medium">
            Full Audit Trail
          </span>
          <Link
            to={`/issues/${id}`}
            className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 group-hover:text-blue-700 group-hover:translate-x-0.5 transition-all"
          >
            Track Status <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>
    </article>
  );
}
