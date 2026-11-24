import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ShieldAlert, Home, LayoutDashboard, ArrowLeft } from 'lucide-react';
import Button from '../components/common/Button';
import { useAuth } from '../context/AuthContext';

export default function AccessDeniedPage() {
  const location = useLocation();
  const { role, isCitizen, citizenInfo } = useAuth();

  const attemptedPath = location.state?.from?.pathname || 'the requested page';
  const reason = location.state?.reason;

  return (
    <div className="min-h-[70vh] flex items-center justify-center px-4 py-16 sm:px-6 lg:px-8">
      <div className="max-w-md w-full bg-white rounded-2xl border border-slate-200 shadow-xl p-7 text-center animate-in fade-in zoom-in-95 duration-200">
        
        {/* Shield Icon */}
        <div className="w-16 h-16 rounded-2xl bg-rose-50 border border-rose-200 text-rose-600 flex items-center justify-center mx-auto mb-5 shadow-xs">
          <ShieldAlert className="w-8 h-8" />
        </div>

        {/* Title */}
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
          Access Restricted
        </h1>
        <p className="text-sm text-slate-600 mt-2 leading-relaxed">
          You do not have the required municipal credentials to access{' '}
          <span className="font-semibold text-slate-800 break-all">{attemptedPath}</span>.
        </p>

        {/* Role Diagnostic Card */}
        <div className="my-6 p-4 bg-slate-50 border border-slate-200 rounded-xl text-left text-xs space-y-1.5">
          <div className="flex justify-between items-center">
            <span className="text-slate-500 font-medium">Signed in as:</span>
            <span className="text-slate-900 font-semibold">{citizenInfo.fullName}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-slate-500 font-medium">Assigned Role:</span>
            <span className="capitalize px-2 py-0.5 rounded-md font-semibold text-blue-700 bg-blue-50 border border-blue-200">
              {role || 'Citizen'}
            </span>
          </div>
          {reason === 'ACTIVE_OFFICER_RECORD_REQUIRED' && (
            <p className="text-rose-600 text-[11px] pt-1">
              Notice: An active departmental officer record is required to access the Officer Portal.
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-2.5 justify-center">
          <Link to="/" className="w-full sm:w-auto">
            <Button variant="outline" size="md" icon={Home} className="w-full justify-center">
              Home
            </Button>
          </Link>
          {isCitizen && (
            <Link to="/dashboard" className="w-full sm:w-auto">
              <Button variant="primary" size="md" icon={LayoutDashboard} className="w-full justify-center">
                Citizen Dashboard
              </Button>
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
