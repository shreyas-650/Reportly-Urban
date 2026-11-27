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
import AdminEscalationsPage from './pages/admin/AdminEscalationsPage';
import AdminDisputedComplaintsPage from './pages/admin/AdminDisputedComplaintsPage';
import AdminDuplicatesPage from './pages/admin/AdminDuplicatesPage';
import AdminScreeningQueuePage from './pages/admin/AdminScreeningQueuePage';
import AdminAccuracyAppealsPage from './pages/admin/AdminAccuracyAppealsPage';
import AdminSlaRulesPage from './pages/admin/AdminSlaRulesPage';
import OfficerNotificationsPage from './pages/officer/OfficerNotificationsPage';
import OfficerComplaintDetailsPage from './pages/officer/OfficerComplaintDetailsPage';
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

              {/* Protected Officer Routes */}
              <Route
                path="officer"
                element={
                  <ProtectedRoute allowedRoles={['officer']} requireActiveOfficer={true}>
                    <OfficerNotificationsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="officer/complaints/:id"
                element={
                  <ProtectedRoute allowedRoles={['officer']} requireActiveOfficer={true}>
                    <OfficerComplaintDetailsPage />
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
              <Route path="escalations" element={<AdminEscalationsPage />} />
              <Route path="disputes" element={<AdminDisputedComplaintsPage />} />
              <Route path="duplicates" element={<AdminDuplicatesPage />} />
              <Route path="screening" element={<AdminScreeningQueuePage />} />
              <Route path="ai-accuracy" element={<AdminAccuracyAppealsPage />} />
              <Route path="sla-rules" element={<AdminSlaRulesPage />} />
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
