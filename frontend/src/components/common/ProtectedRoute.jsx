import React from 'react';
import { Navigate, useLocation, Outlet } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

export default function ProtectedRoute({
  children,
  allowedRoles = [],
  requireActiveOfficer = false,
  strictRoleMatch = false,
}) {
  const {
    isAuthenticated,
    loading,
    profileLoading,
    role,
    isOfficer,
    isAdmin,
  } = useAuth();
  const location = useLocation();

  // 1. Wait for auth session and profile loading to resolve before making routing decisions
  if (loading || profileLoading) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center p-6 text-center">
        <div className="w-10 h-10 border-3 border-blue-600/25 border-t-blue-600 rounded-full animate-spin mb-4" />
        <h4 className="text-sm font-semibold text-slate-900">Verifying Civic Credentials</h4>
        <p className="text-xs text-slate-500 mt-1">Please wait while we authenticate your access rights...</p>
      </div>
    );
  }

  // 2. Redirect unauthenticated users to home, preserving requested path
  if (!isAuthenticated) {
    return (
      <Navigate
        to="/"
        state={{ from: location, openAuth: true }}
        replace
      />
    );
  }

  // 3. Role-based authorization verification
  if (allowedRoles.length > 0) {
    // Strict routes (e.g. citizen-only rewards) forbid implicit admin bypass
    const hasRoleAccess = strictRoleMatch
      ? allowedRoles.includes(role)
      : allowedRoles.includes(role) || isAdmin;

    // For officer routes, strictly require a confirmed active officer record
    if (requireActiveOfficer && !isOfficer && !isAdmin) {
      return (
        <Navigate
          to="/access-denied"
          state={{
            from: location,
            requiredRoles: allowedRoles,
            currentRole: role,
            reason: 'ACTIVE_OFFICER_RECORD_REQUIRED',
          }}
          replace
        />
      );
    }

    if (!hasRoleAccess) {
      return (
        <Navigate
          to="/access-denied"
          state={{
            from: location,
            requiredRoles: allowedRoles,
            currentRole: role,
            reason: 'ROLE_MISMATCH',
          }}
          replace
        />
      );
    }
  }

  // 4. Access authorized
  return children ? children : <Outlet />;
}
