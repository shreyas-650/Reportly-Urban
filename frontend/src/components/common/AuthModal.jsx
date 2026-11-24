import React, { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  X,
  User,
  Mail,
  Lock,
  Phone,
  MapPin,
  AlertCircle,
  CheckCircle2,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import Button from './Button';
import { useAuth } from '../../context/AuthContext';
import { WARDS } from '../../data/categories';

export default function AuthModal({ isOpen, initialMode = 'login', onClose }) {
  const [mode, setMode] = useState(initialMode); // 'login' | 'register'
  const location = useLocation();
  const navigate = useNavigate();
  const [formData, setFormData] = useState({
    fullName: '',
    email: '',
    password: '',
    confirmPassword: '',
    phoneNumber: '',
    ward: '',
  });
  const [errors, setErrors] = useState({});
  const [generalError, setGeneralError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { signIn, signUp } = useAuth();

  // Synchronize initial mode when modal opens
  useEffect(() => {
    if (isOpen) {
      setMode(initialMode);
      setErrors({});
      setGeneralError(null);
      setSuccessMessage(null);
      setFormData({
        fullName: '',
        email: '',
        password: '',
        confirmPassword: '',
        phoneNumber: '',
        ward: WARDS[0] || '',
      });
    }
  }, [isOpen, initialMode]);

  // Handle ESC key to dismiss
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && isOpen && !isSubmitting) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSubmitting, onClose]);

  if (!isOpen) return null;

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    if (errors[name]) {
      setErrors((prev) => ({ ...prev, [name]: null }));
    }
    if (generalError) {
      setGeneralError(null);
    }
  };

  const validate = () => {
    const newErrors = {};

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!formData.email.trim()) {
      newErrors.email = 'Email address is required.';
    } else if (!emailRegex.test(formData.email.trim())) {
      newErrors.email = 'Please enter a valid email address.';
    }

    // Password validation
    if (!formData.password) {
      newErrors.password = 'Password is required.';
    } else if (formData.password.length < 6) {
      newErrors.password = 'Password must be at least 6 characters.';
    }

    // Registration-only fields
    if (mode === 'register') {
      if (!formData.fullName.trim()) {
        newErrors.fullName = 'Full name is required.';
      } else if (formData.fullName.trim().length < 2) {
        newErrors.fullName = 'Full name must be at least 2 characters.';
      }

      const phoneClean = formData.phoneNumber.replace(/[\s-]/g, '');
      if (!formData.phoneNumber.trim()) {
        newErrors.phoneNumber = 'Phone number is required.';
      } else if (!/^\+?[0-9]{10,14}$/.test(phoneClean)) {
        newErrors.phoneNumber = 'Please enter a valid 10-digit mobile number.';
      }

      if (!formData.ward) {
        newErrors.ward = 'Please select your municipal ward.';
      }

      if (formData.password !== formData.confirmPassword) {
        newErrors.confirmPassword = 'Passwords do not match.';
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setGeneralError(null);
    setSuccessMessage(null);

    if (!validate()) return;

    setIsSubmitting(true);

    try {
      if (mode === 'login') {
        const { error } = await signIn({
          email: formData.email,
          password: formData.password,
        });

        if (error) {
          // Provide clear, safe user-facing error messages
          if (error.message?.toLowerCase().includes('invalid login credentials')) {
            setGeneralError('Invalid email or password. Please verify your credentials and try again.');
          } else if (error.message?.toLowerCase().includes('email not confirmed')) {
            setGeneralError('Your email address has not been confirmed yet. Please check your inbox.');
          } else {
            setGeneralError(error.message || 'Unable to sign in. Please try again.');
          }
          setIsSubmitting(false);
          return;
        }

        // Login successful
        setSuccessMessage('Signed in successfully.');
        setTimeout(() => {
          onClose();
          const targetPath = location.state?.from?.pathname;
          if (targetPath && targetPath !== '/' && targetPath !== '/access-denied') {
            navigate(targetPath, { replace: true });
          }
        }, 600);
      } else {
        // Mode is 'register'
        const { data, error } = await signUp({
          fullName: formData.fullName,
          email: formData.email,
          password: formData.password,
          phoneNumber: formData.phoneNumber,
          ward: formData.ward,
        });

        if (error) {
          if (error.message?.toLowerCase().includes('already registered')) {
            setGeneralError('An account with this email address already exists. Please sign in instead.');
          } else {
            setGeneralError(error.message || 'Registration failed. Please check your details and try again.');
          }
          setIsSubmitting(false);
          return;
        }

        // Check if email confirmation is required by Supabase project
        if (data?.user && !data?.session) {
          setSuccessMessage(
            'Registration successful! Please check your email to confirm your account before signing in.'
          );
          setIsSubmitting(false);
        } else {
          setSuccessMessage('Citizen account registered successfully!');
          setTimeout(() => {
            onClose();
          }, 800);
        }
      }
    } catch (err) {
      console.error('[AuthModal] Submission exception:', err);
      setGeneralError('A network or server error occurred. Please try again.');
      setIsSubmitting(false);
    }
  };

  const switchMode = (newMode) => {
    setMode(newMode);
    setErrors({});
    setGeneralError(null);
    setSuccessMessage(null);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-modal-title"
    >
      <div className="bg-white rounded-2xl max-w-md w-full p-6 sm:p-7 shadow-2xl border border-slate-200 relative animate-in fade-in zoom-in duration-150 my-8">
        
        {/* Close Button */}
        <button
          onClick={onClose}
          disabled={isSubmitting}
          className="absolute top-4 right-4 text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition-colors disabled:opacity-50"
          aria-label="Close modal"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Modal Header */}
        <div className="flex items-center gap-3 mb-5">
          <div className="w-11 h-11 rounded-xl bg-blue-50 text-blue-600 border border-blue-100 flex items-center justify-center shrink-0">
            {mode === 'login' ? <User className="w-6 h-6" /> : <ShieldCheck className="w-6 h-6" />}
          </div>
          <div>
            <h3 id="auth-modal-title" className="text-xl font-bold text-slate-900 leading-tight">
              {mode === 'login' ? 'Citizen Sign In' : 'Create Citizen Account'}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {mode === 'login'
                ? 'Access your reported issues, tracking, and civic points'
                : 'Register your municipal ward to report and track issues'}
            </p>
          </div>
        </div>

        {/* Tab Toggle */}
        <div className="flex p-1 bg-slate-100 rounded-xl mb-5">
          <button
            type="button"
            onClick={() => switchMode('login')}
            disabled={isSubmitting}
            className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all ${
              mode === 'login'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Sign In
          </button>
          <button
            type="button"
            onClick={() => switchMode('register')}
            disabled={isSubmitting}
            className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all ${
              mode === 'register'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Register
          </button>
        </div>

        {/* Error Alert */}
        {generalError && (
          <div className="mb-4 p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-800 text-xs flex items-start gap-2.5 animate-in fade-in">
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
            <div className="leading-relaxed">{generalError}</div>
          </div>
        )}

        {/* Success Alert */}
        {successMessage && (
          <div className="mb-4 p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-800 text-xs flex items-start gap-2.5 animate-in fade-in">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <div className="leading-relaxed">{successMessage}</div>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-3.5" noValidate>
          {/* Registration: Full Name */}
          {mode === 'register' && (
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Full Name <span className="text-rose-500">*</span>
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                  <User className="w-4 h-4" />
                </div>
                <input
                  type="text"
                  name="fullName"
                  value={formData.fullName}
                  onChange={handleChange}
                  placeholder="e.g. Ananya Sharma"
                  disabled={isSubmitting}
                  className={`w-full pl-9 pr-3.5 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    errors.fullName ? 'border-rose-300 bg-rose-50/30' : 'border-slate-200'
                  }`}
                />
              </div>
              {errors.fullName && <p className="text-rose-600 text-xs mt-1">{errors.fullName}</p>}
            </div>
          )}

          {/* Email Address */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Email Address <span className="text-rose-500">*</span>
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                <Mail className="w-4 h-4" />
              </div>
              <input
                type="email"
                name="email"
                value={formData.email}
                onChange={handleChange}
                placeholder="e.g. ananya.sharma@civicmail.in"
                disabled={isSubmitting}
                className={`w-full pl-9 pr-3.5 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  errors.email ? 'border-rose-300 bg-rose-50/30' : 'border-slate-200'
                }`}
              />
            </div>
            {errors.email && <p className="text-rose-600 text-xs mt-1">{errors.email}</p>}
          </div>

          {/* Registration: Phone Number & Ward */}
          {mode === 'register' && (
            <>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Mobile Number <span className="text-rose-500">*</span>
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                    <Phone className="w-4 h-4" />
                  </div>
                  <input
                    type="tel"
                    name="phoneNumber"
                    value={formData.phoneNumber}
                    onChange={handleChange}
                    placeholder="e.g. 9876543210"
                    disabled={isSubmitting}
                    className={`w-full pl-9 pr-3.5 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                      errors.phoneNumber ? 'border-rose-300 bg-rose-50/30' : 'border-slate-200'
                    }`}
                  />
                </div>
                {errors.phoneNumber && (
                  <p className="text-rose-600 text-xs mt-1">{errors.phoneNumber}</p>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Municipal Ward <span className="text-rose-500">*</span>
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                    <MapPin className="w-4 h-4" />
                  </div>
                  <select
                    name="ward"
                    value={formData.ward}
                    onChange={handleChange}
                    disabled={isSubmitting}
                    className={`w-full pl-9 pr-3.5 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white ${
                      errors.ward ? 'border-rose-300 bg-rose-50/30' : 'border-slate-200'
                    }`}
                  >
                    <option value="" disabled>Select your ward...</option>
                    {WARDS.map((w) => (
                      <option key={w} value={w}>
                        {w}
                      </option>
                    ))}
                  </select>
                </div>
                {errors.ward && <p className="text-rose-600 text-xs mt-1">{errors.ward}</p>}
              </div>
            </>
          )}

          {/* Password */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Password <span className="text-rose-500">*</span>
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                <Lock className="w-4 h-4" />
              </div>
              <input
                type="password"
                name="password"
                value={formData.password}
                onChange={handleChange}
                placeholder="At least 6 characters"
                disabled={isSubmitting}
                className={`w-full pl-9 pr-3.5 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  errors.password ? 'border-rose-300 bg-rose-50/30' : 'border-slate-200'
                }`}
              />
            </div>
            {errors.password && <p className="text-rose-600 text-xs mt-1">{errors.password}</p>}
          </div>

          {/* Registration: Confirm Password */}
          {mode === 'register' && (
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Confirm Password <span className="text-rose-500">*</span>
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                  <Lock className="w-4 h-4" />
                </div>
                <input
                  type="password"
                  name="confirmPassword"
                  value={formData.confirmPassword}
                  onChange={handleChange}
                  placeholder="Re-enter your password"
                  disabled={isSubmitting}
                  className={`w-full pl-9 pr-3.5 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    errors.confirmPassword ? 'border-rose-300 bg-rose-50/30' : 'border-slate-200'
                  }`}
                />
              </div>
              {errors.confirmPassword && (
                <p className="text-rose-600 text-xs mt-1">{errors.confirmPassword}</p>
              )}
            </div>
          )}

          {/* Submit Button */}
          <div className="pt-2">
            <Button
              type="submit"
              variant="primary"
              size="md"
              className="w-full justify-center"
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  {mode === 'login' ? 'Signing In...' : 'Registering Account...'}
                </>
              ) : mode === 'login' ? (
                'Sign In'
              ) : (
                'Create Citizen Account'
              )}
            </Button>
          </div>

          {/* Mode Switch Footnote */}
          <div className="text-center pt-2">
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}
              className="text-xs text-blue-600 hover:text-blue-800 font-medium transition-colors"
            >
              {mode === 'login'
                ? "Don't have an account? Register here"
                : 'Already registered? Sign in to your account'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
