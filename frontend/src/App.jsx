import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import MainLayout from './layouts/MainLayout';
import HomePage from './pages/HomePage';
import ReportIssuePage from './pages/ReportIssuePage';
import ExploreIssuesPage from './pages/ExploreIssuesPage';
import IssueDetailsPage from './pages/IssueDetailsPage';
import CitizenDashboard from './pages/CitizenDashboard';
import { ComplaintProvider } from './context/ComplaintContext';

function ScrollToTop() {
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return null;
}

export default function App() {
  return (
    <ComplaintProvider>
      <BrowserRouter>
        <ScrollToTop />
        <Routes>
          <Route path="/" element={<MainLayout />}>
            <Route index element={<HomePage />} />
            <Route path="report" element={<ReportIssuePage />} />
            <Route path="issues" element={<ExploreIssuesPage />} />
            <Route path="issues/:id" element={<IssueDetailsPage />} />
            <Route path="dashboard" element={<CitizenDashboard />} />
            <Route
              path="*"
              element={
                <div className="max-w-xl mx-auto px-4 py-20 text-center">
                  <h1 className="text-4xl font-extrabold text-slate-900 mb-2">404</h1>
                  <p className="text-sm text-slate-600 mb-6">The page you are looking for does not exist.</p>
                  <a href="/" className="inline-flex px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700">
                    Return to Home
                  </a>
                </div>
              }
            />
          </Route>
        </Routes>
      </BrowserRouter>
    </ComplaintProvider>
  );
}
