import React from 'react';
import { Check, Clock, AlertCircle, XCircle } from 'lucide-react';
import { formatDateTime, formatStatusLabel } from '../../utils/formatters';

export default function ComplaintTimeline({ timeline = [], currentStatus = 'submitted' }) {
  if (!timeline || timeline.length === 0) {
    return (
      <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl text-center text-xs text-slate-500">
        No timeline audit events logged yet.
      </div>
    );
  }

  const isRejected = currentStatus === 'rejected';

  return (
    <div className="flow-root">
      <ul className="-mb-8">
        {timeline.map((step, stepIdx) => {
          const isLast = stepIdx === timeline.length - 1;
          const isCompleted = step.completed;

          const isCurrentActive =
            !isCompleted && (stepIdx === 0 || timeline[stepIdx - 1]?.completed);

          const stepIsRejected = step.status === 'rejected';

          return (
            <li key={step.id || step.status || stepIdx}>
              <div className="relative pb-8">
                {/* Connecting line */}
                {!isLast && (
                  <span
                    className={`absolute top-4 left-4 -ml-px h-full w-0.5 ${
                      isCompleted ? 'bg-blue-600' : 'bg-slate-200'
                    }`}
                    aria-hidden="true"
                  />
                )}

                <div className="relative flex items-start space-x-3.5">
                  {/* Step Icon */}
                  <div>
                    {stepIsRejected ? (
                      <span className="h-8 w-8 rounded-full bg-rose-600 flex items-center justify-center text-white ring-4 ring-white shadow-xs">
                        <XCircle className="w-4 h-4" />
                      </span>
                    ) : isCompleted ? (
                      <span className="h-8 w-8 rounded-full bg-blue-600 flex items-center justify-center text-white ring-4 ring-white shadow-xs">
                        <Check className="w-4 h-4" />
                      </span>
                    ) : isCurrentActive ? (
                      <span className="h-8 w-8 rounded-full bg-blue-50 border-2 border-blue-600 flex items-center justify-center text-blue-600 ring-4 ring-white shadow-xs animate-pulse">
                        <Clock className="w-4 h-4" />
                      </span>
                    ) : (
                      <span className="h-8 w-8 rounded-full bg-slate-100 border border-slate-300 flex items-center justify-center text-slate-400 ring-4 ring-white">
                        <span className="w-2 h-2 rounded-full bg-slate-300" />
                      </span>
                    )}
                  </div>

                  {/* Citizen-Safe Step Details: status, stage title, timestamp, and public explanation */}
                  <div className="min-w-0 flex-1 pt-1.5">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                      <h4
                        className={`text-sm font-bold ${
                          stepIsRejected
                            ? 'text-rose-700'
                            : isCompleted
                            ? 'text-slate-900'
                            : isCurrentActive
                            ? 'text-blue-600'
                            : 'text-slate-500'
                        }`}
                      >
                        {step.title || step.stage_title || formatStatusLabel(step.status)}
                      </h4>
                      <span className="text-xs text-slate-400 font-mono">
                        {step.created_at ? formatDateTime(step.created_at) : step.date}
                      </span>
                    </div>

                    {/* Public citizen-facing explanation / statement */}
                    {step.public_description && (
                      <div
                        className={`mt-2 text-xs leading-relaxed p-3 rounded-xl border ${
                          stepIsRejected
                            ? 'bg-rose-50/80 border-rose-200 text-rose-800'
                            : step.status === 'resolved'
                            ? 'bg-emerald-50/80 border-emerald-200 text-emerald-900'
                            : 'bg-slate-50 border-slate-200 text-slate-700'
                        }`}
                      >
                        <p className="font-medium text-[11px] uppercase tracking-wider text-slate-500 mb-1">
                          {stepIsRejected
                            ? 'Administrative Rejection Reason'
                            : step.status === 'resolved'
                            ? 'Verified Resolution Summary'
                            : 'Public Municipal Update'}
                        </p>
                        <p className="font-normal">{step.public_description}</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
