import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CitizenDashboard from '../pages/CitizenDashboard';
import CitizenRewardsPage from '../pages/CitizenRewardsPage';
import AdminRewardsPage from '../pages/admin/AdminRewardsPage';
import * as authCtx from '../context/AuthContext';
import * as complaintSvc from '../services/complaintService';
import * as slaApiSvc from '../services/slaApiService';

describe('Phase 10 Citizen Rewards UI & Privacy Guards', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('Decision 1: CitizenDashboard hides legacy civicPoints and badgeLevel pills when rewards are OFF', async () => {
    vi.spyOn(authCtx, 'useAuth').mockReturnValue({
      user: { id: 'cit-1' },
      isAuthenticated: true,
      isCitizen: true,
      citizenInfo: {
        fullName: 'Asha Citizen',
        ward: 'Ward 4',
        email: 'asha@example.com',
        civicPoints: 0,
        badgeLevel: 'Civic Starter',
      },
    });
    vi.spyOn(complaintSvc, 'fetchCitizenComplaints').mockResolvedValue({
      data: [],
      stats: { total: 0, pending: 0, inProgress: 0, resolved: 0, rejected: 0 },
    });
    vi.spyOn(slaApiSvc, 'fetchCitizenRewardsSummary').mockResolvedValue({
      feature_enabled: false,
      badges: [],
      recent_ledger: [],
      active_challenges: [],
    });

    render(
      <MemoryRouter>
        <CitizenDashboard />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/Welcome back, Asha Citizen/i)).toBeTruthy();
    });

    expect(screen.queryByText(/Civic Starter/i)).toBeNull();
    expect(screen.queryByText(/Civic Score:/i)).toBeNull();
    expect(screen.queryByLabelText(/Citizen Rewards Summary/i)).toBeNull();
  });

  it('CitizenDashboard displays real Phase 10 rewards when enabled and omits legacy Civic Starter', async () => {
    vi.spyOn(authCtx, 'useAuth').mockReturnValue({
      user: { id: 'cit-1' },
      isAuthenticated: true,
      isCitizen: true,
      citizenInfo: {
        fullName: 'Asha Citizen',
        ward: 'Ward 4',
        email: 'asha@example.com',
        civicPoints: 0,
        badgeLevel: 'Civic Starter',
      },
    });
    vi.spyOn(complaintSvc, 'fetchCitizenComplaints').mockResolvedValue({
      data: [],
      stats: { total: 1, pending: 0, inProgress: 0, resolved: 1, rejected: 0 },
    });
    vi.spyOn(slaApiSvc, 'fetchCitizenRewardsSummary').mockResolvedValue({
      feature_enabled: true,
      anonymous_handle: 'Civic-Member-9F2A1B',
      total_points: 50,
      verified_reports_count: 1,
      daily_points_used: 50,
      daily_points_limit: 150,
      daily_awards_used: 1,
      daily_awards_limit: 3,
      weekly_points_used: 50,
      weekly_points_limit: 500,
      weekly_awards_used: 1,
      weekly_awards_limit: 10,
      badges: [
        {
          badge_code: 'first_verified_report',
          title: 'First Verified Report',
          description: 'Earned after first verification.',
          badge_kind: 'milestone',
          earned_at: '2026-11-27T08:00:00Z',
        },
      ],
      recent_ledger: [],
      active_challenges: [],
    });

    render(
      <MemoryRouter>
        <CitizenDashboard />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByLabelText(/Citizen Rewards Summary/i)).toBeTruthy();
    });

    expect(screen.queryByText(/Civic Starter/i)).toBeNull();
    expect(screen.getByText(/Civic-Member-9F2A1B/i)).toBeTruthy();
  });

  it('CitizenRewardsPage hides suppressed leaderboards and exposes zero internal hold/screening details', async () => {
    vi.spyOn(authCtx, 'useAuth').mockReturnValue({
      isCitizen: true,
      loading: false,
      profileLoading: false,
    });
    vi.spyOn(slaApiSvc, 'fetchCitizenRewardsSummary').mockResolvedValue({
      feature_enabled: true,
      anonymous_handle: 'Civic-Member-9F2A1B',
      total_points: 50,
      verified_reports_count: 1,
      daily_points_used: 50,
      daily_points_limit: 150,
      daily_awards_used: 1,
      daily_awards_limit: 3,
      weekly_points_used: 50,
      weekly_points_limit: 500,
      weekly_awards_used: 1,
      weekly_awards_limit: 10,
      badges: [],
      recent_ledger: [
        {
          id: 'led-1',
          complaint_number: 'URB-2026-0009',
          points_delta: 50,
          summary_label: 'Verified complaint reward',
          created_at: '2026-11-27T08:00:00Z',
        },
      ],
      active_challenges: [],
    });
    vi.spyOn(slaApiSvc, 'fetchCitizenRewardsLeaderboard').mockResolvedValue({
      feature_enabled: true,
      window: 'all_time',
      scope: 'citywide',
      ward: null,
      min_group_size: 20,
      enough_data: false,
      entries: [],
      available_wards: [],
    });

    render(
      <MemoryRouter>
        <CitizenRewardsPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/Not enough participants yet in this view/i)).toBeTruthy();
    });

    expect(document.body.textContent).not.toMatch(/pending_flag_hold|suspicious|Other/i);
  });

  it('AdminRewardsPage displays DB feature gate, first_enabled_at, and audit evaluation outcomes', async () => {
    vi.spyOn(slaApiSvc, 'fetchAdminRewardsAudit').mockResolvedValue({
      feature_enabled: false,
      backend_flag_enabled: false,
      first_enabled_at: null,
      settings_updated_at: '2026-11-27T08:00:00Z',
      summary: {
        total_points_awarded: 0,
        total_points_reversed: 0,
        pending_holds_logged: 1,
        cap_skips_logged: 0,
        trigger_failures_logged: 0,
      },
      evaluations: [
        {
          id: 'ev-1',
          complaint_id: 'cmp-1',
          complaint_number: 'URB-2026-0011',
          citizen_id: 'cit-1',
          source_table: 'complaint_resolution_verifications',
          outcome: 'pending_flag_hold',
          points_delta: 0,
          detail: 'Held pending Phase 9.5 screening review.',
          created_at: '2026-11-27T08:05:00Z',
        },
      ],
      challenges: [],
    });

    render(
      <MemoryRouter>
        <AdminRewardsPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/Citizen Rewards, Challenges & Audit/i)).toBeTruthy();
    });
    expect(screen.getByText('pending_flag_hold')).toBeTruthy();
    expect(screen.getByText(/Not enabled yet/i)).toBeTruthy();
  });
});
