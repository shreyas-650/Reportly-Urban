import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ShieldCheck, PlusCircle, Menu, X, User, LogIn, ExternalLink } from 'lucide-react';
import Button from './Button';

export default function Navbar() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [authModal, setAuthModal] = useState({ isOpen: false, mode: 'login' });
  const location = useLocation();

  const navLinks = [
    { label: 'Home', path: '/' },
    { label: 'Explore Issues', path: '/issues' },
    { label: 'Citizen Dashboard', path: '/dashboard' },
  ];

  const isActive = (path) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  const handleNavClick = () => {
    setMobileMenuOpen(false);
  };

  return (
    <>
      <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-md border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            
            {/* Logo */}
            <Link to="/" className="flex items-center group py-1">
              <img
                src="/logo.png"
                alt="Reportly Urban Logo"
                className="h-9 sm:h-10 w-auto object-contain transition-transform group-hover:scale-102"
              />
            </Link>

            {/* Desktop Navigation */}
            <nav className="hidden md:flex items-center gap-1">
              {navLinks.map((link) => (
                <Link
                  key={link.path}
                  to={link.path}
                  className={`px-3.5 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                    isActive(link.path)
                      ? 'text-blue-600 bg-blue-50/70'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100/70'
                  }`}
                >
                  {link.label}
                </Link>
              ))}
              <a
                href="#how-it-works"
                className="px-3.5 py-1.5 text-sm font-medium rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-100/70 transition-colors"
                onClick={(e) => {
                  if (location.pathname !== '/') {
                    window.location.href = '/#how-it-works';
                  }
                }}
              >
                How It Works
              </a>
            </nav>

            {/* Action Buttons */}
            <div className="hidden md:flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => setAuthModal({ isOpen: true, mode: 'login' })}
                className="text-sm font-medium text-slate-600 hover:text-slate-900 px-3 py-1.5 rounded-lg hover:bg-slate-100 transition-colors"
              >
                Sign In
              </button>
              
              <Link to="/report">
                <Button variant="primary" size="md" icon={PlusCircle}>
                  Report an Issue
                </Button>
              </Link>
            </div>

            {/* Mobile Menu Button */}
            <div className="flex items-center md:hidden gap-2">
              <Link to="/report">
                <Button variant="primary" size="sm" icon={PlusCircle}>
                  Report
                </Button>
              </Link>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                className="p-2 text-slate-600 hover:text-slate-900 rounded-lg hover:bg-slate-100 focus:outline-none"
                aria-label="Toggle Navigation"
              >
                {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
              </button>
            </div>
          </div>
        </div>

        {/* Mobile Navigation Drawer */}
        {mobileMenuOpen && (
          <div className="md:hidden border-b border-slate-200 bg-white px-4 pt-2 pb-4 space-y-2">
            {navLinks.map((link) => (
              <Link
                key={link.path}
                to={link.path}
                onClick={handleNavClick}
                className={`block px-3 py-2 text-base font-medium rounded-lg ${
                  isActive(link.path)
                    ? 'text-blue-600 bg-blue-50'
                    : 'text-slate-700 hover:bg-slate-50'
                }`}
              >
                {link.label}
              </Link>
            ))}
            <a
              href="#how-it-works"
              onClick={handleNavClick}
              className="block px-3 py-2 text-base font-medium rounded-lg text-slate-700 hover:bg-slate-50"
            >
              How It Works
            </a>
            
            <div className="pt-3 border-t border-slate-100 flex flex-col gap-2">
              <Button
                variant="outline"
                size="md"
                className="w-full justify-start"
                icon={LogIn}
                onClick={() => {
                  setMobileMenuOpen(false);
                  setAuthModal({ isOpen: true, mode: 'login' });
                }}
              >
                Citizen Sign In
              </Button>
              <Button
                variant="secondary"
                size="md"
                className="w-full justify-start"
                icon={User}
                onClick={() => {
                  setMobileMenuOpen(false);
                  setAuthModal({ isOpen: true, mode: 'register' });
                }}
              >
                Create Account
              </Button>
            </div>
          </div>
        )}
      </header>

      {/* Auth Modal (UI Prototype Only) */}
      {authModal.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-slate-200 relative animate-in fade-in zoom-in duration-150">
            <button
              onClick={() => setAuthModal({ isOpen: false, mode: 'login' })}
              className="absolute top-4 right-4 text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-100"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center">
                <User className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-900">
                  {authModal.mode === 'login' ? 'Citizen Sign In' : 'Create Citizen Account'}
                </h3>
                <p className="text-xs text-slate-500">
                  {authModal.mode === 'login'
                    ? 'Access your submitted complaints and civic points'
                    : 'Register with your ward to start reporting local issues'}
                </p>
              </div>
            </div>

            <div className="space-y-3.5 my-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Mobile Number or Email
                </label>
                <input
                  type="text"
                  placeholder="e.g. ananya.sharma@civicmail.in"
                  defaultValue="ananya.sharma@civicmail.in"
                  className="w-full px-3.5 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Password
                </label>
                <input
                  type="password"
                  defaultValue="••••••••••••"
                  className="w-full px-3.5 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-xs leading-relaxed">
                <span className="font-semibold">Prototype Notice:</span> Full authentication will be connected in Phase 2 with Supabase Auth. You are currently viewing the platform with an active demo citizen session.
              </div>
            </div>

            <div className="flex flex-col gap-2 pt-2">
              <Button
                variant="primary"
                size="md"
                className="w-full"
                onClick={() => setAuthModal({ isOpen: false, mode: 'login' })}
              >
                {authModal.mode === 'login' ? 'Sign In as Demo Citizen' : 'Create Demo Account'}
              </Button>
              <button
                type="button"
                onClick={() =>
                  setAuthModal({
                    isOpen: true,
                    mode: authModal.mode === 'login' ? 'register' : 'login',
                  })
                }
                className="text-xs text-blue-600 hover:text-blue-800 text-center py-1 font-medium"
              >
                {authModal.mode === 'login'
                  ? "Don't have an account? Register here"
                  : 'Already registered? Sign in'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
