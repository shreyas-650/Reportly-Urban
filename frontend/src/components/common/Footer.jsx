import React from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, PhoneCall, ExternalLink, Heart } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

export default function Footer() {
  const { isAuthenticated, isCitizen } = useAuth();
  const canReportIssue = !isAuthenticated || isCitizen;
  const canAccessCitizenDashboard = !isAuthenticated || isCitizen;
  return (
    <footer className="bg-slate-900 text-slate-300 border-t border-slate-800">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-16">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8 lg:gap-12">
          
          {/* Brand Column */}
          <div className="space-y-4">
            <Link to="/" className="inline-block bg-white px-3.5 py-1.5 rounded-xl shadow-xs hover:bg-slate-50 transition-colors">
              <img
                src="/logo.png"
                alt="Reportly Urban Logo"
                className="h-7 w-auto object-contain"
              />
            </Link>
            <p className="text-xs text-slate-400 leading-relaxed">
              Report. Track. Resolve. Verify. Empowering citizens and municipal authorities with an AI-driven transparent civic accountability platform.
            </p>
            <div className="pt-2">
              <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-800 text-slate-300 text-xs border border-slate-700">
                <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                Municipal Services Active
              </span>
            </div>
          </div>

          {/* Quick Navigation */}
          <div>
            <h4 className="text-sm font-semibold text-white uppercase tracking-wider mb-4">
              Citizen Portal
            </h4>
            <ul className="space-y-2.5 text-xs">
              <li>
                <Link to="/" className="hover:text-blue-400 transition-colors">
                  Home Overview
                </Link>
              </li>
              <li>
                <Link to="/accountability" className="hover:text-blue-400 transition-colors">
                  Public Accountability
                </Link>
              </li>
              {canReportIssue && (
                <li>
                  <Link to="/report" className="hover:text-blue-400 transition-colors">
                    Submit Grievance
                  </Link>
                </li>
              )}
              <li>
                <Link to="/issues" className="hover:text-blue-400 transition-colors">
                  Explore Reported Issues
                </Link>
              </li>
              <li>
                <Link to="/map" className="hover:text-blue-400 transition-colors">
                  Public Issue Map
                </Link>
              </li>
              {canAccessCitizenDashboard && (
                <li>
                  <Link to="/dashboard" className="hover:text-blue-400 transition-colors">
                    My Grievance Dashboard
                  </Link>
                </li>
              )}
            </ul>
          </div>

          {/* Issue Categories */}
          <div>
            <h4 className="text-sm font-semibold text-white uppercase tracking-wider mb-4">
              Civic Divisions
            </h4>
            <ul className="space-y-2.5 text-xs text-slate-400">
              <li>Roads & Infrastructure (PWD)</li>
              <li>Solid Waste Management</li>
              <li>Electrical & Lighting Board</li>
              <li>Water Supply & Sewerage Board</li>
              <li>Stormwater & Flood Abatement</li>
            </ul>
          </div>

          {/* Emergency Helpline Numbers */}
          <div>
            <h4 className="text-sm font-semibold text-white uppercase tracking-wider mb-4">
              Emergency Helplines
            </h4>
            <div className="space-y-2.5 text-xs">
              <div className="flex items-center gap-2 text-slate-300">
                <PhoneCall className="w-3.5 h-3.5 text-blue-400" />
                <span>Municipal Control Room: <strong>1912</strong></span>
              </div>
              <div className="flex items-center gap-2 text-slate-300">
                <PhoneCall className="w-3.5 h-3.5 text-emerald-400" />
                <span>Disaster Management: <strong>1077</strong></span>
              </div>
              <div className="flex items-center gap-2 text-slate-300">
                <PhoneCall className="w-3.5 h-3.5 text-amber-400" />
                <span>Water Supply Emergency: <strong>1916</strong></span>
              </div>
              <p className="text-[11px] text-slate-500 pt-2 leading-tight">
                For life-threatening emergencies, call national emergency response at 112 immediately.
              </p>
            </div>
          </div>

        </div>

        {/* Bottom Bar */}
        <div className="mt-12 pt-8 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500">
          <p>© {new Date().getFullYear()} Reportly Urban Platform. Built for civic transparency & accountability.</p>
          <div className="flex items-center gap-4">
            <span className="hover:text-slate-400 cursor-pointer">Privacy Charter</span>
            <span className="hover:text-slate-400 cursor-pointer">Citizen Rights</span>
            <span className="hover:text-slate-400 cursor-pointer">Municipal Bylaws</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
