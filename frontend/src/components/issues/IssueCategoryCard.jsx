import React from 'react';
import { AlertTriangle, Trash2, LightbulbOff, Droplets, Waves, Building2, Clock, ArrowRight } from 'lucide-react';

const ICON_MAP = {
  AlertTriangle,
  Trash2,
  LightbulbOff,
  Droplets,
  Waves,
  Building2,
};

export default function IssueCategoryCard({ category, onClick, isSelected = false }) {
  const IconComponent = ICON_MAP[category.icon] || AlertTriangle;

  return (
    <div
      onClick={() => onClick && onClick(category.id)}
      className={`group relative p-5 rounded-2xl border transition-all duration-200 cursor-pointer ${
        isSelected
          ? 'bg-blue-50/80 border-blue-600 ring-2 ring-blue-500/20 shadow-sm'
          : 'bg-white border-slate-200 hover:border-blue-300 hover:shadow-md'
      }`}
    >
      <div className="flex items-start justify-between mb-3.5">
        <div
          className={`w-11 h-11 rounded-xl flex items-center justify-center transition-colors ${
            isSelected
              ? 'bg-blue-600 text-white'
              : 'bg-blue-50 text-blue-600 group-hover:bg-blue-600 group-hover:text-white'
          }`}
        >
          <IconComponent className="w-5 h-5" />
        </div>
        <div className="flex items-center gap-1 text-[11px] font-medium text-slate-500 bg-slate-100 px-2.5 py-1 rounded-full">
          <Clock className="w-3 h-3 text-slate-400" />
          <span>SLA: {category.slaHours}h</span>
        </div>
      </div>

      <h3 className="text-base font-bold text-slate-900 group-hover:text-blue-600 transition-colors mb-1.5">
        {category.name}
      </h3>

      <p className="text-xs text-slate-600 leading-relaxed mb-3">
        {category.description}
      </p>

      <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-xs">
        <span className="text-[11px] text-slate-400 truncate max-w-[170px]">
          {category.department}
        </span>
        <span className="text-blue-600 font-semibold inline-flex items-center gap-1 group-hover:translate-x-0.5 transition-transform">
          Report <ArrowRight className="w-3 h-3" />
        </span>
      </div>
    </div>
  );
}
