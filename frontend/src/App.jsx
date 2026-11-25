import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import MainLayout from './layouts/MainLayout';
import HomePage from './pages/HomePage';
import AccountabilityDashboardPage from './pages/AccountabilityDashboardPage';
import ReportIssuePage from './pages/ReportIssuePage';
import ExploreIssuesPage from './pages/ExploreIssuesPage';
import PublicComplaintDetailsPage from './pages/PublicComplaintDetailsPage';
import PublicMapPage from './pages/PublicMapPage';
import IssueDetailsPage from './pages/IssueDetailsPage';
import CitizenDashboard from './pages/CitizenDashboard';
import AccessDeniedPage from './pages/AccessDeniedPage';
import ProtectedRoute from './components/common/ProtectedRoute';
import AdminLayout from './layouts/AdminLayout';
import AdminOverviewPage from './pages/admin/AdminOverviewPage';
import AdminComplaintsPage from './pages/admin/AdminComplaintsPage';
import AdminComplaintDetailsPage from './pages/admin/AdminComplaintDetailsPage';
import AdminDepartmentsPage from './pages/admin/AdminDepartmentsPage';
import AdminOfficersPage from './pages/admin/AdminOfficersPage';
import { ComplaintProvider } from './context/ComplaintContext';
import { AuthProvider } from './context/AuthContext';

function ScrollToTop() {
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return null;
}

export default function App() {
  return (
    <AuthProvider>
      <ComplaintProvider>
        <BrowserRouter>
          <ScrollToTop />
          <Routes>
            <Route path="/" element={<MainLayout />}>
              {/* Public Routes */}
              <Route index element={<HomePage />} />
              <Route path="accountability" element={<AccountabilityDashboardPage />} />
              <Route path="report" element={<ReportIssuePage />} />
              <Route path="issues" element={<ExploreIssuesPage />} />
              <Route path="issues/:reference" element={<PublicComplaintDetailsPage />} />
              <Route path="map" element={<PublicMapPage />} />
              <Route path="access-denied" element={<AccessDeniedPage />} />

              {/* Protected Citizen Routes */}
              <Route
                path="dashboard"
                element={
                  <ProtectedRoute allowedRoles={['citizen', 'admin']}>
                    <CitizenDashboard />
                  </ProtectedRoute>
                }
              />
              <Route
                path="dashboard/issues/:id"
                element={
                  <ProtectedRoute allowedRoles={['citizen', 'admin']}>
                    <IssueDetailsPage />
                  </ProtectedRoute>
                }
              />

              {/* Protected Officer Routes (UI placeholder; full portal in Phase 4) */}
              <Route
                path="officer/*"
                element={
                  <ProtectedRoute allowedRoles={['officer']} requireActiveOfficer={true}>
                    <div className="max-w-3xl mx-auto py-20 px-4 text-center">
                      <div className="inline-block px-3 py-1 rounded-full bg-blue-100 text-blue-700 font-semibold text-xs mb-3">
                        Officer Authorization Confirmed
                      </div>
                      <h2 className="text-2xl font-bold text-slate-900">Municipal Officer Workstation</h2>
                      <p className="text-sm text-slate-600 mt-2">
                        Your active officer credentials have been verified. Field complaint management will be connected in Phase 4.
                      </p>
                    </div>
                  </ProtectedRoute>
                }
              />
            </Route>

            {/* Protected Admin Routes (Phase 4.1 Scaffolding) */}
            <Route
              path="admin"
              element={
                <ProtectedRoute allowedRoles={['admin']}>
                  <AdminLayout />
                </ProtectedRoute>
              }
            >
              <Route index element={<AdminOverviewPage />} />
              <Route path="complaints" element={<AdminComplaintsPage />} />
              <Route path="complaints/:id" element={<AdminComplaintDetailsPage />} />
              <Route path="departments" element={<AdminDepartmentsPage />} />
              <Route path="officers" element={<AdminOfficersPage />} />
            </Route>

            {/* 404 Route */}
            <Route
              path="*"
              element={
                <MainLayout>
                  <div className="max-w-xl mx-auto px-4 py-20 text-center">
                    <h1 className="text-4xl font-extrabold text-slate-900 mb-2">404</h1>
                    <p className="text-sm text-slate-600 mb-6">The page you are looking for does not exist.</p>
                    <a href="/" className="inline-flex px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700">
                      Return to Home
                    </a>
                  </div>
                </MainLayout>
              }
            />
          </Routes>
        </BrowserRouter>
      </ComplaintProvider>
    </AuthProvider>
  );
}
