import React, { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Navbar from '../components/common/Navbar';
import Footer from '../components/common/Footer';
import ProtectedRoute from '../components/common/ProtectedRoute';
import CitizenDashboard from '../pages/CitizenDashboard';
import CitizenRewardsPage from '../pages/CitizenRewardsPage';
import HomePage from '../pages/HomePage';
import { AuthProvider, useAuth } from '../context/AuthContext';
import * as authCtx from '../context/AuthContext';
import * as complaintSvc from '../services/complaintService';
import * as slaApiSvc from '../services/slaApiService';
import * as publicSvc from '../services/publicService';
import { supabase } from '../lib/supabase';

vi.mock('../components/common/NotificationBell', () => ({
  default: () => <div data-testid="notification-bell" />,
}));

describe('Navbar Role Links & AuthContext Tab-Refocus Stability', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('removes Citizen Dashboard from main desktop and mobile nav links', () => {
    vi.spyOn(authCtx, 'useAuth').mockReturnValue({
      isAuthenticated: false,
      isOfficer: false,
      isAdmin: false,
      isCitizen: false,
      citizenInfo: { fullName: '', email: '', ward: '' },
      signOut: vi.fn(),
    });

    render(
      <MemoryRouter>
        <Navbar />
      </MemoryRouter>
    );

    expect(screen.queryByText(/Citizen Dashboard/i)).toBeNull();
    expect(screen.queryByText(/How It Works/i)).toBeNull();
    expect(screen.getByText('Home')).toBeTruthy();
    expect(screen.getByText('Explore Issues')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Toggle Navigation'));
    expect(screen.queryByText(/Citizen Dashboard/i)).toBeNull();
    expect(screen.queryByText(/How It Works/i)).toBeNull();
  });

  it('officer does NOT see Citizen Dashboard anywhere and sees Officer Alerts & Reminders', () => {
    vi.spyOn(authCtx, 'useAuth').mockReturnValue({
      isAuthenticated: true,
      isOfficer: true,
      isAdmin: false,
      isCitizen: false,
      citizenInfo: {
        fullName: 'Inspector Rao',
        email: 'rao@city.gov',
        ward: 'Ward 5',
      },
      signOut: vi.fn(),
    });

    render(
      <MemoryRouter>
        <Navbar />
      </MemoryRouter>
    );

    expect(screen.queryByText(/Citizen Dashboard/i)).toBeNull();

    fireEvent.click(screen.getByLabelText('User profile menu'));
    expect(screen.getByText(/Officer Alerts & Reminders/i)).toBeTruthy();
    expect(screen.queryByText(/Citizen Dashboard/i)).toBeNull();

    fireEvent.click(screen.getByLabelText('Toggle Navigation'));
    expect(screen.getAllByText(/Officer Alerts & Reminders/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/Citizen Dashboard/i)).toBeNull();
  });

  it('citizen sees Citizen Dashboard in profile dropdown only (not in main nav links)', () => {
    vi.spyOn(authCtx, 'useAuth').mockReturnValue({
      isAuthenticated: true,
      isOfficer: false,
      isAdmin: false,
      isCitizen: true,
      citizenInfo: {
        fullName: 'Asha Citizen',
        email: 'asha@example.com',
        ward: 'Ward 4',
      },
      signOut: vi.fn(),
    });

    render(
      <MemoryRouter>
        <Navbar />
      </MemoryRouter>
    );

    // Not in main top nav before opening dropdown
    expect(screen.queryByText(/Citizen Dashboard/i)).toBeNull();

    fireEvent.click(screen.getByLabelText('User profile menu'));
    const dropdownLink = screen.getByRole('link', { name: /Citizen Dashboard/i });
    expect(dropdownLink.getAttribute('href')).toBe('/dashboard');
  });

  it('admin does NOT see Citizen Dashboard in dropdown or mobile menu and keeps Municipal Admin Console', () => {
    vi.spyOn(authCtx, 'useAuth').mockReturnValue({
      isAuthenticated: true,
      isOfficer: false,
      isAdmin: true,
      isCitizen: false,
      citizenInfo: {
        fullName: 'City Admin',
        email: 'admin@city.gov',
        ward: 'Central',
      },
      signOut: vi.fn(),
    });

    render(
      <MemoryRouter>
        <Navbar />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByLabelText('User profile menu'));
    expect(screen.getByRole('link', { name: /Municipal Admin Console/i })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Citizen Dashboard/i })).toBeNull();

    fireEvent.click(screen.getByLabelText('Toggle Navigation'));
    expect(screen.queryByRole('link', { name: /Citizen Dashboard/i })).toBeNull();
  });

  it('AuthProvider + ProtectedRoute do not flash loading/verifying credentials or unmount child on tab refocus / TOKEN_REFRESHED', async () => {
    let authCallback = null;
    let currentDbRole = 'citizen';

    vi.spyOn(supabase.auth, 'getSession').mockResolvedValue({
      data: {
        session: {
          access_token: 'tok-1',
          expires_at: 9999999999,
          user: { id: 'user-1', email: 'asha@example.com' },
        },
      },
      error: null,
    });

    vi.spyOn(supabase.auth, 'onAuthStateChange').mockImplementation((cb) => {
      authCallback = cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });

    vi.spyOn(supabase, 'from').mockImplementation((table) => {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: 'user-1',
                  role: currentDbRole,
                  full_name: 'Asha Citizen',
                  ward: 'Ward 4',
                  phone_number: '9999999999',
                  civic_points: 0,
                  badge_level: 'Civic Starter',
                  updated_at: '2026-11-27T00:00:00Z',
                },
                error: null,
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
      };
    });

    let mountCount = 0;
    let unmountCount = 0;
    const seenLoadingStates = [];

    function ProtectedProbe() {
      const { loading, profileLoading } = useAuth();
      seenLoadingStates.push({ loading, profileLoading });

      useEffect(() => {
        mountCount += 1;
        return () => {
          unmountCount += 1;
        };
      }, []);

      return <div data-testid="protected-content">Citizen Protected Content</div>;
    }

    render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/dashboard']}>
          <Routes>
            <Route path="/" element={<div data-testid="home-redirect">Home</div>} />
            <Route path="/access-denied" element={<div data-testid="access-denied">Restricted</div>} />
            <Route
              path="/dashboard"
              element={
                <ProtectedRoute allowedRoles={['citizen', 'admin']}>
                  <ProtectedProbe />
                </ProtectedRoute>
              }
            />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('protected-content')).toBeTruthy();
    });
    expect(mountCount).toBe(1);
    expect(unmountCount).toBe(0);
    seenLoadingStates.length = 0;

    // Simulate tab refocus (re-emitted SIGNED_IN + TOKEN_REFRESHED for same user)
    await act(async () => {
      await authCallback('SIGNED_IN', {
        access_token: 'tok-1',
        expires_at: 9999999999,
        user: { id: 'user-1', email: 'asha@example.com' },
      });
      await authCallback('TOKEN_REFRESHED', {
        access_token: 'tok-2',
        expires_at: 9999999999,
        user: { id: 'user-1', email: 'asha@example.com' },
      });
    });

    // Must never show Verifying Civic Credentials or unmount protected child
    expect(screen.queryByText(/Verifying Civic Credentials/i)).toBeNull();
    expect(screen.getByTestId('protected-content')).toBeTruthy();
    expect(mountCount).toBe(1);
    expect(unmountCount).toBe(0);
    expect(seenLoadingStates.every((s) => !s.loading && !s.profileLoading)).toBe(true);

    // Security check: SIGNED_OUT while on protected route clears session and redirects to /
    await act(async () => {
      await authCallback('SIGNED_OUT', null);
    });

    await waitFor(() => {
      expect(screen.getByTestId('home-redirect')).toBeTruthy();
    });
  });

  it('AuthProvider respects DB role change on background refresh and restricts access', async () => {
    let authCallback = null;
    let currentDbRole = 'citizen';

    vi.spyOn(supabase.auth, 'getSession').mockResolvedValue({
      data: {
        session: {
          access_token: 'tok-1',
          expires_at: 9999999999,
          user: { id: 'user-2', email: 'asha@example.com' },
        },
      },
      error: null,
    });

    vi.spyOn(supabase.auth, 'onAuthStateChange').mockImplementation((cb) => {
      authCallback = cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });

    vi.spyOn(supabase, 'from').mockImplementation((table) => {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: 'user-2',
                  role: currentDbRole,
                  full_name: 'Role Changed User',
                  ward: 'Ward 4',
                  phone_number: '9999999999',
                  civic_points: 0,
                  badge_level: 'Civic Starter',
                  updated_at: '2026-11-27T00:00:00Z',
                },
                error: null,
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
      };
    });

    render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/dashboard']}>
          <Routes>
            <Route path="/" element={<div data-testid="home-redirect">Home</div>} />
            <Route path="/access-denied" element={<div data-testid="access-denied">Restricted</div>} />
            <Route
              path="/dashboard"
              element={
                <ProtectedRoute allowedRoles={['citizen', 'admin']}>
                  <div data-testid="protected-content">Citizen Protected Content</div>
                </ProtectedRoute>
              }
            />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('protected-content')).toBeTruthy();
    });

    currentDbRole = 'officer';
    await act(async () => {
      await authCallback('TOKEN_REFRESHED', {
        access_token: 'tok-2',
        expires_at: 9999999999,
        user: { id: 'user-2', email: 'asha@example.com' },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('access-denied')).toBeTruthy();
    });
  });

  it('officer and admin do NOT see Rewards & Leaderboard in Navbar, while citizen DOES', () => {
    // Officer
    vi.spyOn(authCtx, 'useAuth').mockReturnValue({
      isAuthenticated: true,
      isOfficer: true,
      isAdmin: false,
      isCitizen: false,
      citizenInfo: { fullName: 'Officer 1', email: 'off@city.gov', ward: 'W1' },
      signOut: vi.fn(),
    });
    const { unmount } = render(
      <MemoryRouter>
        <Navbar />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByLabelText('User profile menu'));
    expect(screen.getByText(/Officer Alerts & Reminders/i)).toBeTruthy();
    expect(screen.queryByText(/Rewards & Leaderboard/i)).toBeNull();
    fireEvent.click(screen.getByLabelText('Toggle Navigation'));
    expect(screen.queryByText(/Rewards & Leaderboard/i)).toBeNull();
    unmount();

    // Admin
    vi.spyOn(authCtx, 'useAuth').mockReturnValue({
      isAuthenticated: true,
      isOfficer: false,
      isAdmin: true,
      isCitizen: false,
      citizenInfo: { fullName: 'Admin 1', email: 'adm@city.gov', ward: 'Central' },
      signOut: vi.fn(),
    });
    const admRender = render(
      <MemoryRouter>
        <Navbar />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByLabelText('User profile menu'));
    expect(screen.getByText(/Municipal Admin Console/i)).toBeTruthy();
    expect(screen.queryByText(/Rewards & Leaderboard/i)).toBeNull();
    fireEvent.click(screen.getByLabelText('Toggle Navigation'));
    expect(screen.queryByText(/Rewards & Leaderboard/i)).toBeNull();
    admRender.unmount();

    // Citizen
    vi.spyOn(authCtx, 'useAuth').mockReturnValue({
      isAuthenticated: true,
      isOfficer: false,
      isAdmin: false,
      isCitizen: true,
      citizenInfo: { fullName: 'Cit 1', email: 'cit@city.gov', ward: 'W2' },
      signOut: vi.fn(),
    });
    render(
      <MemoryRouter>
        <Navbar />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByLabelText('User profile menu'));
    expect(screen.getByRole('link', { name: /Rewards & Leaderboard/i }).getAttribute('href')).toBe('/rewards');
  });

  it('/rewards blocks both officer and admin to access-denied and makes ZERO rewards API calls; CitizenDashboard skips rewards API for non-citizen', async () => {
    const sumSpy = vi.spyOn(slaApiSvc, 'fetchCitizenRewardsSummary').mockResolvedValue({
      feature_enabled: true,
    });
    const boardSpy = vi.spyOn(slaApiSvc, 'fetchCitizenRewardsLeaderboard').mockResolvedValue({
      feature_enabled: true,
    });

    for (const testRole of ['officer', 'admin']) {
      vi.spyOn(authCtx, 'useAuth').mockReturnValue({
        isAuthenticated: true,
        loading: false,
        profileLoading: false,
        role: testRole,
        isOfficer: testRole === 'officer',
        isAdmin: testRole === 'admin',
        isCitizen: false,
        user: { id: `${testRole}-1` },
        citizenInfo: { fullName: 'Staff', email: 'staff@city.gov', ward: 'HQ' },
      });

      const { unmount } = render(
        <MemoryRouter initialEntries={['/rewards']}>
          <Routes>
            <Route path="/access-denied" element={<div data-testid="access-denied">Restricted</div>} />
            <Route
              path="/rewards"
              element={
                <ProtectedRoute allowedRoles={['citizen']} strictRoleMatch={true}>
                  <CitizenRewardsPage />
                </ProtectedRoute>
              }
            />
          </Routes>
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByTestId('access-denied')).toBeTruthy();
      });
      unmount();
    }

    // Non-citizen admin viewing CitizenDashboard must also skip rewards API completely
    vi.spyOn(complaintSvc, 'fetchCitizenComplaints').mockResolvedValue({
      data: [],
      stats: { total: 0, pending: 0, inProgress: 0, resolved: 0, rejected: 0 },
    });
    vi.spyOn(authCtx, 'useAuth').mockReturnValue({
      isAuthenticated: true,
      loading: false,
      profileLoading: false,
      role: 'admin',
      isOfficer: false,
      isAdmin: true,
      isCitizen: false,
      user: { id: 'admin-1' },
      citizenInfo: { fullName: 'Admin', email: 'adm@city.gov', ward: 'HQ' },
    });

    render(
      <MemoryRouter>
        <CitizenDashboard />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/Welcome back, Admin/i)).toBeTruthy();
    });

    expect(sumSpy).not.toHaveBeenCalled();
    expect(boardSpy).not.toHaveBeenCalled();
  });

  it('Report an Issue buttons in Navbar and HomePage are visible for logged-out and citizen, hidden for officer and admin', async () => {
    vi.spyOn(publicSvc, 'fetchPublicStats').mockResolvedValue({
      total: 10,
      resolved: 6,
      pending: 4,
      overdue: 0,
      no_deadline_count: 1,
      resolution_rate: 60,
      avg_resolution_hours: 12,
    });
    vi.spyOn(publicSvc, 'fetchPublicComplaints').mockResolvedValue({ items: [] });

    // Logged-out visitor sees Report an Issue in Navbar & HomePage
    vi.spyOn(authCtx, 'useAuth').mockReturnValue({
      isAuthenticated: false,
      isOfficer: false,
      isAdmin: false,
      isCitizen: false,
      citizenInfo: { fullName: '', email: '', ward: '' },
      signOut: vi.fn(),
    });
    const guestView = render(
      <MemoryRouter>
        <Navbar />
        <HomePage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getAllByText(/Report an Issue/i).length).toBeGreaterThanOrEqual(2);
    });
    expect(screen.getByText(/File Custom Report/i)).toBeTruthy();
    guestView.unmount();

    // Citizen sees Report an Issue in Navbar & HomePage
    vi.spyOn(authCtx, 'useAuth').mockReturnValue({
      isAuthenticated: true,
      isOfficer: false,
      isAdmin: false,
      isCitizen: true,
      citizenInfo: { fullName: 'Cit 1', email: 'cit@city.gov', ward: 'W2' },
      signOut: vi.fn(),
    });
    const citView = render(
      <MemoryRouter>
        <Navbar />
        <HomePage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getAllByText(/Report an Issue/i).length).toBeGreaterThanOrEqual(2);
    });
    citView.unmount();

    // Officer & Admin see zero Report an Issue / File Custom Report CTAs
    for (const staffRole of ['officer', 'admin']) {
      vi.spyOn(authCtx, 'useAuth').mockReturnValue({
        isAuthenticated: true,
        isOfficer: staffRole === 'officer',
        isAdmin: staffRole === 'admin',
        isCitizen: false,
        citizenInfo: { fullName: 'Staff', email: 'staff@city.gov', ward: 'HQ' },
        signOut: vi.fn(),
      });

      const staffView = render(
        <MemoryRouter>
          <Navbar />
          <HomePage />
          <Footer />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByText(/Your City\. Your Voice\./i)).toBeTruthy();
      });

      expect(screen.queryByRole('button', { name: /^Report$/i })).toBeNull();
      expect(screen.queryByText(/Report an Issue Now/i)).toBeNull();
      expect(screen.queryByRole('link', { name: /Report an Issue/i })).toBeNull();
      expect(screen.queryByText(/File Custom Report/i)).toBeNull();
      expect(screen.queryByRole('link', { name: /Citizen Dashboard/i })).toBeNull();
      expect(screen.queryByRole('link', { name: /My Grievance Dashboard/i })).toBeNull();
      expect(screen.queryByRole('link', { name: /Submit Grievance/i })).toBeNull();
      staffView.unmount();
    }
  });

  it('/report route blocks officer and admin to access-denied without mounting form, sends guest to login, and allows citizen', async () => {
    function MockReportPage() {
      return <div data-testid="report-form-loaded">Mock Report Page</div>;
    }

    // Officer and Admin blocked to /access-denied
    for (const staffRole of ['officer', 'admin']) {
      vi.spyOn(authCtx, 'useAuth').mockReturnValue({
        isAuthenticated: true,
        loading: false,
        profileLoading: false,
        role: staffRole,
        isOfficer: staffRole === 'officer',
        isAdmin: staffRole === 'admin',
        isCitizen: false,
        citizenInfo: { fullName: 'Staff', email: 'staff@city.gov', ward: 'HQ' },
      });

      const { unmount } = render(
        <MemoryRouter initialEntries={['/report']}>
          <Routes>
            <Route path="/" element={<div data-testid="guest-login-redirect">Home Login</div>} />
            <Route path="/access-denied" element={<div data-testid="access-denied">Restricted</div>} />
            <Route
              path="/report"
              element={
                <ProtectedRoute allowedRoles={['citizen']} strictRoleMatch={true}>
                  <MockReportPage />
                </ProtectedRoute>
              }
            />
          </Routes>
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByTestId('access-denied')).toBeTruthy();
      });
      expect(screen.queryByTestId('report-form-loaded')).toBeNull();
      unmount();
    }

    // Logged-out visitor redirected to login flow on /
    vi.spyOn(authCtx, 'useAuth').mockReturnValue({
      isAuthenticated: false,
      loading: false,
      profileLoading: false,
      role: null,
      isOfficer: false,
      isAdmin: false,
      isCitizen: false,
    });
    const guestRoute = render(
      <MemoryRouter initialEntries={['/report']}>
        <Routes>
          <Route path="/" element={<div data-testid="guest-login-redirect">Home Login</div>} />
          <Route
            path="/report"
            element={
              <ProtectedRoute allowedRoles={['citizen']} strictRoleMatch={true}>
                <MockReportPage />
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId('guest-login-redirect')).toBeTruthy();
    });
    expect(screen.queryByTestId('report-form-loaded')).toBeNull();
    guestRoute.unmount();

    // Citizen can load /report
    vi.spyOn(authCtx, 'useAuth').mockReturnValue({
      isAuthenticated: true,
      loading: false,
      profileLoading: false,
      role: 'citizen',
      isOfficer: false,
      isAdmin: false,
      isCitizen: true,
    });
    render(
      <MemoryRouter initialEntries={['/report']}>
        <Routes>
          <Route path="/" element={<div data-testid="guest-login-redirect">Home Login</div>} />
          <Route
            path="/report"
            element={
              <ProtectedRoute allowedRoles={['citizen']} strictRoleMatch={true}>
                <MockReportPage />
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId('report-form-loaded')).toBeTruthy();
    });
  });

  it('/dashboard route is strictly citizen-only (blocks admin and officer to access-denied, allows citizen)', async () => {
    function MockCitizenDashboard() {
      return <div data-testid="citizen-dashboard-loaded">Citizen Dashboard</div>;
    }

    for (const staffRole of ['officer', 'admin']) {
      vi.spyOn(authCtx, 'useAuth').mockReturnValue({
        isAuthenticated: true,
        loading: false,
        profileLoading: false,
        role: staffRole,
        isOfficer: staffRole === 'officer',
        isAdmin: staffRole === 'admin',
        isCitizen: false,
      });

      const { unmount } = render(
        <MemoryRouter initialEntries={['/dashboard']}>
          <Routes>
            <Route path="/access-denied" element={<div data-testid="access-denied">Restricted</div>} />
            <Route
              path="/dashboard"
              element={
                <ProtectedRoute allowedRoles={['citizen']} strictRoleMatch={true}>
                  <MockCitizenDashboard />
                </ProtectedRoute>
              }
            />
          </Routes>
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByTestId('access-denied')).toBeTruthy();
      });
      expect(screen.queryByTestId('citizen-dashboard-loaded')).toBeNull();
      unmount();
    }

    vi.spyOn(authCtx, 'useAuth').mockReturnValue({
      isAuthenticated: true,
      loading: false,
      profileLoading: false,
      role: 'citizen',
      isOfficer: false,
      isAdmin: false,
      isCitizen: true,
    });

    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="/access-denied" element={<div data-testid="access-denied">Restricted</div>} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute allowedRoles={['citizen']} strictRoleMatch={true}>
                <MockCitizenDashboard />
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByTestId('citizen-dashboard-loaded')).toBeTruthy();
    });
  });
});
