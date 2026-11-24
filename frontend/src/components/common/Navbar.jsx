import React, { useState, useRef, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  ShieldCheck,
  PlusCircle,
  Menu,
  X,
  User,
  LogIn,
  LogOut,
  ChevronDown,
  LayoutDashboard,
  Award,
  MapPin,
} from 'lucide-react';
import Button from './Button';
import AuthModal from './AuthModal';
import { useAuth } from '../../context/AuthContext';

export default function Navbar() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [userDropdownOpen, setUserDropdownOpen] = useState(false);
  const [authModal, setAuthModal] = useState({ isOpen: false, mode: 'login' });

  const { isAuthenticated, citizenInfo, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const dropdownRef = useRef(null);

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
    setUserDropdownOpen(false);
  };

  // Open login modal automatically if directed from a protected route
  useEffect(() => {
    if (location.state?.openAuth && !isAuthenticated) {
      setAuthModal({ isOpen: true, mode: 'login' });
    }
  }, [location.state, isAuthenticated]);

  // Close dropdown on outside click
  useEffect(() => {
    const handleOutsideClick = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setUserDropdownOpen(false);
      }
    };
    if (userDropdownOpen) {
      document.addEventListener('mousedown', handleOutsideClick);
    }
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
    };
  }, [userDropdownOpen]);

  const handleSignOut = async () => {
    setUserDropdownOpen(false);
    setMobileMenuOpen(false);
    await signOut();
    navigate('/');
  };

  return (
    <>
      <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-md border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            
            {/* Logo */}
            <Link to="/" className="flex items-center group py-1" onClick={handleNavClick}>
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

            {/* Desktop Action Buttons / Auth State */}
            <div className="hidden md:flex items-center gap-2.5">
              {isAuthenticated ? (
                <div className="relative" ref={dropdownRef}>
                  <button
                    type="button"
                    onClick={() => setUserDropdownOpen(!userDropdownOpen)}
                    className="flex items-center gap-2.5 px-3 py-1.5 rounded-xl border border-slate-200 hover:border-slate-300 hover:bg-slate-50 transition-colors text-left"
                    aria-expanded={userDropdownOpen}
                    aria-label="User profile menu"
                  >
                    <div className="w-8 h-8 rounded-lg bg-blue-600 text-white flex items-center justify-center font-bold text-xs shadow-xs">
                      {citizenInfo.fullName?.charAt(0)?.toUpperCase() || 'C'}
                    </div>
                    <div className="flex flex-col">
                      <span className="text-xs font-semibold text-slate-900 truncate max-w-[130px] leading-tight">
                        {citizenInfo.fullName}
                      </span>
                      <span className="text-[10px] text-slate-500 truncate max-w-[130px]">
                        {citizenInfo.ward}
                      </span>
                    </div>
                    <ChevronDown className="w-4 h-4 text-slate-400" />
                  </button>

                  {/* Dropdown Menu */}
                  {userDropdownOpen && (
                    <div className="absolute right-0 mt-1.5 w-60 bg-white rounded-xl shadow-lg border border-slate-200 py-1.5 z-50 animate-in fade-in zoom-in-95 duration-100">
                      <div className="px-3.5 py-2.5 border-b border-slate-100">
                        <p className="text-xs font-semibold text-slate-900 truncate">
                          {citizenInfo.fullName}
                        </p>
                        <p className="text-[11px] text-slate-500 truncate">
                          {citizenInfo.email}
                        </p>
                        <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-blue-600 bg-blue-50 px-2 py-0.5 rounded-md font-medium w-fit">
                          <MapPin className="w-3 h-3" />
                          <span className="truncate max-w-[180px]">{citizenInfo.ward}</span>
                        </div>
                      </div>

                      <div className="py-1">
                        <Link
                          to="/dashboard"
                          onClick={() => setUserDropdownOpen(false)}
                          className="flex items-center gap-2.5 px-3.5 py-2 text-xs text-slate-700 hover:bg-slate-50 hover:text-slate-900 font-medium transition-colors"
                        >
                          <LayoutDashboard className="w-4 h-4 text-slate-400" />
                          Citizen Dashboard
                        </Link>
                      </div>

                      <div className="border-t border-slate-100 pt-1">
                        <button
                          type="button"
                          onClick={handleSignOut}
                          className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-rose-600 hover:bg-rose-50 font-medium transition-colors"
                        >
                          <LogOut className="w-4 h-4 text-rose-500" />
                          Sign Out
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setAuthModal({ isOpen: true, mode: 'login' })}
                    className="text-sm font-medium text-slate-600 hover:text-slate-900 px-3 py-1.5 rounded-lg hover:bg-slate-100 transition-colors"
                  >
                    Sign In
                  </button>
                  <Button
                    variant="outline"
                    size="md"
                    onClick={() => setAuthModal({ isOpen: true, mode: 'register' })}
                  >
                    Register
                  </Button>
                </>
              )}

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
              {isAuthenticated ? (
                <div className="space-y-2.5">
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl">
                    <p className="text-sm font-bold text-slate-900">{citizenInfo.fullName}</p>
                    <p className="text-xs text-slate-500">{citizenInfo.email}</p>
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-blue-600">
                      <MapPin className="w-3.5 h-3.5" />
                      <span>{citizenInfo.ward}</span>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="md"
                    className="w-full justify-start text-rose-600 hover:text-rose-700 hover:bg-rose-50 border-rose-200"
                    icon={LogOut}
                    onClick={handleSignOut}
                  >
                    Sign Out
                  </Button>
                </div>
              ) : (
                <>
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
                </>
              )}
            </div>
          </div>
        )}
      </header>

      {/* Accessible Authentication Dialog */}
      <AuthModal
        isOpen={authModal.isOpen}
        initialMode={authModal.mode}
        onClose={() => setAuthModal({ isOpen: false, mode: 'login' })}
      />
    </>
  );
}
