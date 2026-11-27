import React from 'react';
import { NavLink, Outlet, Link, useNavigate } from 'react-router-dom';
import {
  ShieldAlert,
  LayoutDashboard,
  FileText,
  Building,
  Users,
  Sliders,
  AlertOctagon,
  Copy,
  BarChart3,
  Trophy,
  ArrowLeft,
  LogOut,
  ExternalLink,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import NotificationBell from '../components/common/NotificationBell';

export default function AdminLayout() {
  const { citizenInfo, signOut } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate('/');
  };

  const navItems = [
    {
      to: '/admin',
      label: 'Administrative Overview',
      icon: LayoutDashboard,
      end: true,
    },
    {
      to: '/admin/complaints',
      label: 'Complaint Triage',
      icon: FileText,
      end: false,
    },
    {
      to: '/admin/departments',
      label: 'Departments',
      icon: Building,
      end: false,
    },
    {
      to: '/admin/officers',
      label: 'Officer Roster',
      icon: Users,
      end: false,
    },
    {
      to: '/admin/escalations',
      label: 'Escalations & History',
      icon: ShieldAlert,
      end: false,
    },
    {
      to: '/admin/disputes',
      label: 'Disputed Complaints',
      icon: AlertOctagon,
      end: false,
    },
    {
      to: '/admin/duplicates',
      label: 'Suspected Duplicates',
      icon: Copy,
      end: false,
    },
    {
      to: '/admin/screening',
      label: 'AI Screening',
      icon: ShieldAlert,
      end: false,
    },
    {
      to: '/admin/ai-accuracy',
      label: 'Accuracy & Appeals',
      icon: BarChart3,
      end: false,
    },
    {
      to: '/admin/rewards',
      label: 'Rewards & Challenges',
      icon: Trophy,
      end: false,
    },
    {
      to: '/admin/sla-rules',
      label: 'SLA Rules',
      icon: Sliders,
      end: false,
    },
  ];

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans">
      {/* Top Municipal Admin Navigation Bar */}
      <header className="bg-slate-900 text-white border-b border-slate-800 sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center font-bold text-white shadow-xs">
              RU
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-extrabold text-base tracking-tight text-white">ReportlyUrban</span>
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-400/30">
                  Municipal Admin
                </span>
              </div>
              <p className="text-[11px] text-slate-400">Urban Grievance Administration & Dispatch</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <NotificationBell role="admin" darkHeader={true} />

            <Link
              to="/dashboard"
              className="hidden sm:inline-flex items-center gap-1.5 text-xs text-slate-300 hover:text-white transition-colors py-1.5 px-3 rounded-lg hover:bg-slate-800"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Citizen View
            </Link>

            <div className="h-4 w-px bg-slate-700 hidden sm:block" />

            <div className="flex items-center gap-3">
              <div className="text-right hidden sm:block">
                <div className="text-xs font-semibold text-white">{citizenInfo.fullName}</div>
                <div className="text-[10px] text-slate-400 capitalize">{citizenInfo.role}</div>
              </div>
              <button
                type="button"
                onClick={handleSignOut}
                className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-rose-400 p-2 rounded-lg hover:bg-slate-800 transition-colors"
                title="Sign Out"
              >
                <LogOut className="w-4 h-4" />
                <span className="sr-only">Sign out</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Admin Body */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 w-full flex-1 flex flex-col md:flex-row gap-8 items-start">
        {/* Sidebar Navigation */}
        <aside className="w-full md:w-64 bg-white border border-slate-200 rounded-2xl p-4 shadow-xs shrink-0">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-400 px-3 mb-3">
            Administration Modules
          </div>
          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-semibold transition-colors ${
                      isActive
                        ? 'bg-blue-50 text-blue-700 shadow-2xs font-bold'
                        : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                    }`
                  }
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </NavLink>
              );
            })}
          </nav>

          <div className="mt-8 pt-4 border-t border-slate-100">
            <Link
              to="/"
              className="flex items-center gap-2 text-xs font-medium text-slate-500 hover:text-slate-900 px-3 py-2 rounded-lg hover:bg-slate-50 transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back to Public Portal</span>
            </Link>
          </div>
        </aside>

        {/* Content Outlet */}
        <main className="flex-1 w-full min-w-0">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
