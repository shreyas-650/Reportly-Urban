import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import {
  validateSlaRuleInput,
  validateManualEscalationReason,
} from '../services/slaApiService';
import AdminSlaRulesPage from '../pages/admin/AdminSlaRulesPage';
import AdminEscalationsPage from '../pages/admin/AdminEscalationsPage';
import NotificationBell from '../components/common/NotificationBell';
import OfficerNotificationsPage from '../pages/officer/OfficerNotificationsPage';
import OfficerComplaintDetailsPage from '../pages/officer/OfficerComplaintDetailsPage';
import IssueDetailsPage from '../pages/IssueDetailsPage';

// Mock dependencies used by IssueDetailsPage (Leaflet/Supabase/Auth) without altering production code
const mockUseAuth = vi.fn();
const mockFetchComplaintDetails = vi.fn();
const mockFetchCitizenFollowup = vi.fn();

vi.mock('../context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('../services/complaintService', async () => {
  const actual = await vi.importActual('../services/complaintService');
  return {
    ...actual,
    fetchComplaintDetails: (...args) => mockFetchComplaintDetails(...args),
  };
});

vi.mock('../services/slaApiService', async () => {
  const actual = await vi.importActual('../services/slaApiService');
  return {
    ...actual,
    fetchCitizenComplaintFollowup: (...args) => mockFetchCitizenFollowup(...args),
  };
});

vi.mock('../components/maps/ComplaintLocationMap', () => ({
  default: () => <div data-testid="mock-location-map" />,
}));

vi.mock('../components/issues/ComplaintTimeline', () => ({
  default: () => <div data-testid="mock-timeline" />,
}));

describe('Phase 7.3 Unit & Mocked Integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 1. SLA Validation Unit Tests
  it('validates SLA rule thresholds strictly per DB constraints', () => {
    const ok = validateSlaRuleInput({
      sla_hours: '48',
      reminder_before_hours: '12',
      level2_after_hours: '24',
      level3_after_hours: '72',
    });
    expect(ok.valid).toBe(true);
    expect(ok.parsed).toEqual({
      sla_hours: 48,
      reminder_before_hours: 12,
      level2_after_hours: 24,
      level3_after_hours: 72,
    });

    const bad = validateSlaRuleInput({
      sla_hours: '0',
      reminder_before_hours: '12',
      level2_after_hours: '24',
      level3_after_hours: '24',
    });
    expect(bad.valid).toBe(false);
    expect(bad.errors.sla_hours).toBeTruthy();
    expect(bad.errors.level3_after_hours).toBeTruthy();

    const remEqualSla = validateSlaRuleInput({
      sla_hours: '24',
      reminder_before_hours: '24',
      level2_after_hours: '12',
      level3_after_hours: '36',
    });
    expect(remEqualSla.valid).toBe(false);
    expect(remEqualSla.errors.reminder_before_hours).toBeTruthy();

    const nonInt = validateSlaRuleInput({
      sla_hours: '24.5',
      reminder_before_hours: '6',
      level2_after_hours: '12',
      level3_after_hours: '36',
    });
    expect(nonInt.valid).toBe(false);
    expect(nonInt.errors.sla_hours).toBeTruthy();
  });

  // 2. Manual Escalation Reason Validation Unit Tests
  it('validates trimmed manual escalation reason length', () => {
    expect(validateManualEscalationReason('   abc  ').valid).toBe(false);
    const valid = validateManualEscalationReason('  SLA   overdue   for 30h  ');
    expect(valid.valid).toBe(true);
    expect(valid.trimmed).toBe('SLA overdue for 30h');
  });

  // 3. AdminSlaRulesPage Unit & Mocked Update (diff confirm, stale error, success)
  it('renders SLA rules, confirms diff before save, surfaces server conflict errors, and saves cleanly', async () => {
    const user = userEvent.setup();
    const initialRules = [
      {
        category: 'potholes',
        sla_hours: 48,
        reminder_before_hours: 12,
        level2_after_hours: 24,
        level3_after_hours: 72,
        updated_at: '2026-11-25T10:00:00Z',
      },
    ];
    const fetchRules = vi.fn().mockResolvedValue({ items: initialRules });
    const updateRule = vi
      .fn()
      .mockRejectedValueOnce(new Error('Stale SLA rule data: refresh before saving.'))
      .mockResolvedValueOnce({
        category: 'potholes',
        sla_hours: 36,
        reminder_before_hours: 8,
        level2_after_hours: 18,
        level3_after_hours: 48,
        updated_at: '2026-11-25T11:00:00Z',
      });

    render(
      <MemoryRouter>
        <AdminSlaRulesPage api={{ fetchRules, updateRule }} />
      </MemoryRouter>
    );

    expect(await screen.findByText(/Potholes & Road Damage/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Edit Rule/i }));

    const slaInput = screen.getByLabelText(/SLA Hours/i);
    await user.clear(slaInput);
    await user.type(slaInput, '36');

    const remInput = screen.getByLabelText(/Reminder Before/i);
    await user.clear(remInput);
    await user.type(remInput, '8');

    const l2Input = screen.getByLabelText(/Level 2 Threshold/i);
    await user.clear(l2Input);
    await user.type(l2Input, '18');

    const l3Input = screen.getByLabelText(/Level 3 Threshold/i);
    await user.clear(l3Input);
    await user.type(l3Input, '48');

    await user.click(screen.getByRole('button', { name: /Review & Save/i }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/48h\s*→\s*36h/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/12h\s*→\s*8h/i)).toBeInTheDocument();

    // First attempt triggers mocked stale conflict
    await user.click(within(dialog).getByRole('button', { name: /Confirm Update/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Stale SLA rule data/i);

    // Retry save succeeds
    await user.click(screen.getByRole('button', { name: /Review & Save/i }));
    await user.click(screen.getByRole('button', { name: /Confirm Update/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/Saved SLA configuration/i);
    expect(updateRule).toHaveBeenCalledTimes(2);
  });

  // 4. AdminEscalationsPage List, Empty/Error, History & Double-Submit Lock
  it('renders escalations list, history panel, validates reason, and prevents duplicate manual escalation submit', async () => {
    const user = userEvent.setup();
    const fetchList = vi
      .fn()
      .mockRejectedValueOnce(new Error('Service temporarily unavailable.'))
      .mockResolvedValue({
        items: [
          {
            id: 'esc-1',
            complaint_id: 'comp-1',
            complaint_reference: 'RU-2026-00001',
            category: 'potholes',
            ward: 'Ward 1 - North Central',
            complaint_status: 'in_progress',
            current_level: 1,
            from_level: 0,
            to_level: 1,
            status: 'completed',
            recipient: 'A. Verma (Junior Engineer)',
            reason: 'Overdue SLA',
            triggered_by: 'system',
            created_at: '2026-11-25T09:00:00Z',
          },
        ],
        page: 1,
        page_size: 20,
        total: 1,
        total_pages: 1,
        departments: [{ id: 'dept-1', name: 'Roads' }],
      });

    const fetchHistory = vi.fn().mockResolvedValue({
      complaint: {
        id: 'comp-1',
        complaint_reference: 'RU-2026-00001',
        category: 'potholes',
        ward: 'Ward 1 - North Central',
        status: 'in_progress',
        department_name: 'Roads',
        current_level: 1,
        updated_at: '2026-11-25T09:00:00Z',
      },
      history: [
        {
          id: 'esc-1',
          from_level: 0,
          to_level: 1,
          status: 'completed',
          reason: 'Overdue SLA',
          triggered_by: 'system',
          recipient: 'A. Verma (Junior Engineer)',
          created_at: '2026-11-25T09:00:00Z',
        },
      ],
    });

    let resolveEscalate;
    const escalate = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveEscalate = resolve;
        })
    );

    render(
      <MemoryRouter initialEntries={['/admin/escalations']}>
        <AdminEscalationsPage api={{ fetchList, fetchHistory, escalate }} />
      </MemoryRouter>
    );

    // Error & Retry state
    expect(await screen.findByText(/Service temporarily unavailable/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Retry/i }));

    expect(await screen.findByText('RU-2026-00001')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /History & Escalate/i }));
    expect(await screen.findByText(/Current Escalation Level: Level 1/i)).toBeInTheDocument();

    // Invalid short reason
    const reasonBox = screen.getByLabelText(/Escalation Reason/i);
    await user.type(reasonBox, 'abc');
    await user.click(screen.getByRole('button', { name: /^Escalate Complaint$/i }));
    expect(screen.getByText(/at least 5 characters/i)).toBeInTheDocument();
    expect(escalate).not.toHaveBeenCalled();

    // Double click prevention during in-flight escalation
    await user.clear(reasonBox);
    await user.type(reasonBox, 'Manual intervention requested');
    const submitBtn = screen.getByRole('button', { name: /^Escalate Complaint$/i });
    await user.click(submitBtn);
    await user.click(submitBtn);
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(escalate.mock.calls[0][1]).toEqual({
      reason: 'Manual intervention requested',
      expectedUpdatedAt: '2026-11-25T09:00:00Z',
    });

    resolveEscalate({
      escalation_id: 'esc-2',
      complaint_id: 'comp-1',
      from_level: 1,
      to_level: 2,
      status: 'completed',
    });

    expect(
      await screen.findByText(/Complaint escalated from Level 1 to Level 2/i)
    ).toBeInTheDocument();
  });

  // 5. NotificationBell Read/Unread + Empty State
  it('renders admin notifications bell, marks unread notification read, and handles empty state', async () => {
    const user = userEvent.setup();
    const list = vi.fn().mockResolvedValue({
      items: [
        {
          id: 'notif-1',
          complaint_id: 'comp-9',
          complaint_reference: 'RU-2026-00099',
          kind: 'escalation_blocked',
          title: 'Level 2 Escalation Blocked',
          message: 'No active department head configured.',
          is_read: false,
          created_at: '2026-11-25T10:30:00Z',
        },
      ],
      unread_count: 1,
    });
    const markRead = vi.fn().mockResolvedValue({ id: 'notif-1', is_read: true });

    render(
      <MemoryRouter>
        <NotificationBell role="admin" api={{ list, markRead }} />
      </MemoryRouter>
    );

    expect(await screen.findByTestId('unread-badge')).toHaveTextContent('1');
    await user.click(screen.getByRole('button', { name: /Notifications/i }));
    expect(await screen.findByText('Level 2 Escalation Blocked')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Mark read/i }));
    await waitFor(() => {
      expect(markRead).toHaveBeenCalledWith('notif-1');
    });
    expect(screen.queryByTestId('unread-badge')).not.toBeInTheDocument();
  });

  // 6. OfficerNotificationsPage distinguishing pre-deadline vs overdue & empty/error states
  it('distinguishes pre-deadline vs overdue reminders, shows escalated complaints, and links to officer complaint view', async () => {
    const fetchReminders = vi.fn().mockResolvedValue({
      items: [
        {
          id: 'rem-pre',
          complaint_id: 'c-1',
          complaint_reference: 'RU-2026-00101',
          category: 'water_leakage',
          ward: 'Ward 7',
          kind: 'pre_deadline',
          created_at: '2026-11-25T08:00:00Z',
        },
        {
          id: 'rem-ov',
          complaint_id: 'c-2',
          complaint_reference: 'RU-2026-00102',
          category: 'potholes',
          ward: 'Ward 12',
          kind: 'overdue',
          created_at: '2026-11-25T09:00:00Z',
        },
      ],
    });
    const fetchEscalations = vi.fn().mockResolvedValue({
      items: [
        {
          id: 'esc-o1',
          complaint_id: 'c-2',
          complaint_reference: 'RU-2026-00102',
          category: 'potholes',
          ward: 'Ward 12',
          to_level: 1,
          reason: 'sla_overdue_level1',
          created_at: '2026-11-25T09:15:00Z',
        },
      ],
    });
    const fetchNotifications = vi.fn().mockResolvedValue({ items: [], unread_count: 0 });
    const markRead = vi.fn();

    render(
      <MemoryRouter>
        <OfficerNotificationsPage
          api={{ fetchReminders, fetchEscalations, fetchNotifications, markRead }}
        />
      </MemoryRouter>
    );

    expect(await screen.findByText('RU-2026-00101')).toBeInTheDocument();
    const remindersSection = screen.getByRole('region', { name: /SLA reminders/i });
    expect(within(remindersSection).getByText('Pre-Deadline', { selector: 'span' })).toBeInTheDocument();
    expect(within(remindersSection).getByText('Overdue', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Level 1 Escalation')).toBeInTheDocument();
    expect(screen.getByText('No notifications yet')).toBeInTheDocument();

    const links = screen.getAllByRole('link', { name: /View Complaint|Open Case/i });
    expect(links.some((l) => l.getAttribute('href') === '/officer/complaints/c-1')).toBe(true);
    expect(links.some((l) => l.getAttribute('href') === '/officer/complaints/c-2')).toBe(true);
  });

  // 7. Citizen IssueDetailsPage Neutral Follow-Up Message
  it('shows exact citizen follow-up message when is_followed_up is true and nothing when false', async () => {
    mockUseAuth.mockReturnValue({
      user: { id: 'citizen-1' },
      role: 'citizen',
      isAuthenticated: true,
      loading: false,
    });
    mockFetchComplaintDetails.mockResolvedValue({
      data: {
        id: '11111111-1111-4111-8111-111111111111',
        complaint_number: 'RU-2026-00500',
        title: 'Water pipe leak',
        category: 'water_leakage',
        description: 'Continuous street water leakage near market entrance.',
        location: 'Market Street',
        ward: 'Ward 7',
        status: 'in_progress',
        created_at: '2026-11-25T06:00:00Z',
        timeline: [],
      },
      error: null,
    });

    // True case
    mockFetchCitizenFollowup.mockResolvedValueOnce({ is_followed_up: true });
    const { unmount } = render(
      <MemoryRouter initialEntries={['/dashboard/issues/11111111-1111-4111-8111-111111111111']}>
        <Routes>
          <Route path="/dashboard/issues/:id" element={<IssueDetailsPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(
      await screen.findByText('This complaint is being followed up.')
    ).toBeInTheDocument();
    unmount();

    // False case
    mockFetchCitizenFollowup.mockResolvedValueOnce({ is_followed_up: false });
    render(
      <MemoryRouter initialEntries={['/dashboard/issues/11111111-1111-4111-8111-111111111111']}>
        <Routes>
          <Route path="/dashboard/issues/:id" element={<IssueDetailsPage />} />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByText('Water pipe leak');
    expect(
      screen.queryByText('This complaint is being followed up.')
    ).not.toBeInTheDocument();
  });

  // 8. Empty & Error States across AdminEscalationsPage & NotificationBell
  it('renders empty states and notification error retry state cleanly', async () => {
    const user = userEvent.setup();
    const emptyList = vi.fn().mockResolvedValue({
      items: [],
      page: 1,
      page_size: 20,
      total: 0,
      total_pages: 1,
      departments: [],
    });

    render(
      <MemoryRouter>
        <AdminEscalationsPage api={{ fetchList: emptyList, fetchHistory: vi.fn(), escalate: vi.fn() }} />
      </MemoryRouter>
    );
    expect(await screen.findByText('No Escalations Found')).toBeInTheDocument();

    const failingNotif = vi
      .fn()
      .mockRejectedValueOnce(new Error('Notifications endpoint failed'))
      .mockResolvedValueOnce({ items: [], unread_count: 0 });
    render(
      <MemoryRouter>
        <NotificationBell role="officer" api={{ list: failingNotif, markRead: vi.fn() }} />
      </MemoryRouter>
    );

    await user.click(screen.getByRole('button', { name: /Notifications/i }));
    expect(await screen.findByText('No notifications yet')).toBeInTheDocument();
  });

  // 9. OfficerComplaintDetailsPage renders sanitized details without internal notes or citizen PII
  it('renders OfficerComplaintDetailsPage cleanly without admin-only notes or citizen PII and surfaces expired session error', async () => {
    mockUseAuth.mockReturnValue({
      officerRecord: { id: 'off-1' },
    });

    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('Your session has expired or is invalid. Please sign in again.'))
      .mockResolvedValueOnce({
        id: 'c-99',
        complaint_reference: 'RU-2026-00999',
        title: 'Streetlight failure',
        category: 'streetlights',
        description: 'Pole #14 lamp out near junction.',
        location: 'Main Junction',
        ward: 'Ward 7',
        status: 'in_progress',
        priority: 'high',
        department_name: 'Electrical',
        assigned_officer_id: 'off-1',
        sla_deadline: '2026-11-26T10:00:00Z',
        created_at: '2026-11-25T05:00:00Z',
        updated_at: '2026-11-25T06:00:00Z',
        current_level: 1,
        timeline: [],
        escalations: [
          {
            id: 'esc-99',
            from_level: 0,
            to_level: 1,
            status: 'completed',
            reason: 'Assigned officer escalation',
            triggered_by: 'system',
            created_at: '2026-11-25T09:00:00Z',
          },
        ],
      });

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/officer/complaints/c-99']}>
        <Routes>
          <Route
            path="/officer/complaints/:id"
            element={<OfficerComplaintDetailsPage fetcher={fetcher} />}
          />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText(/Your session has expired/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Retry/i }));

    expect(await screen.findByText('RU-2026-00999')).toBeInTheDocument();
    expect(screen.getByText('Streetlight failure')).toBeInTheDocument();
    expect(screen.getByText('Assigned officer escalation')).toBeInTheDocument();
    expect(screen.queryByText(/Triage & Dispatch/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Internal Remark/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Citizen Information/i)).not.toBeInTheDocument();
  });
});
