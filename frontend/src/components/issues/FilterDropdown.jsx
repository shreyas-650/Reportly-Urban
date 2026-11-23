import React from 'react';
import { ChevronDown } from 'lucide-react';

export default function FilterDropdown({
  label,
  value,
  onChange,
  options = [],
  className = '',
}) {
  return (
    <div className={`relative inline-block ${className}`}>
      {label && (
        <label className="block text-xs font-semibold text-slate-600 mb-1">
          {label}
        </label>
      )}
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="appearance-none w-full bg-white border border-slate-200 text-slate-800 text-sm rounded-lg pl-3 pr-8 py-2 font-medium focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all shadow-2xs cursor-pointer"
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <ChevronDown className="w-4 h-4 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
      </div>
    </div>
  );
}
