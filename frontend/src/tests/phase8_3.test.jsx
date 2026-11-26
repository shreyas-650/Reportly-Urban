import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import CitizenResolutionVerificationPanel from '../components/issues/CitizenResolutionVerificationPanel';
import AdminVerificationHistoryPanel from '../components/admin/AdminVerificationHistoryPanel';
import AdminDisputedComplaintsPage from '../pages/admin/AdminDisputedComplaintsPage';

describe('Phase 8.3 Citizen Verification/Dispute & Admin History UI', () => {
  it('renders before/after photos, validates dispute reason, submits dispute, and shows zero AI text', async () => {
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce({
        complaint_id: 'c-1',
        complaint_status: 'resolved',
        latest_evidence_id: 'e-1',
        can_verify: true,
        current_decision: null,
        history: [],
      })
      .mockResolvedValueOnce({
        complaint_id: 'c-1',
        complaint_status: 'in_progress',
        latest_evidence_id: null,
        can_verify: false,
        current_decision: null,
        history: [
          {
            id: 'v-1',
            evidence_id: 'e-1',
            decision: 'disputed',
            reason: 'Drain is still overflowing.',
            created_at: '2026-11-25T12:00:00Z',
          },
        ],
      });
    const dispute = vi.fn().mockResolvedValue({
      verification_id: 'v-1',
      decision: 'disputed',
      complaint_status: 'in_progress',
    });
    const onDecisionSubmitted = vi.fn();

    const { container } = render(
      <CitizenResolutionVerificationPanel
        complaintId="c-1"
        complaintStatus="resolved"
        beforeImageUrl="https://example.com/before.jpg"
        afterImageUrl="https://example.com/after.jpg"
        onDecisionSubmitted={onDecisionSubmitted}
        api={{ fetchStatus, verify: vi.fn(), dispute }}
      />
    );

    await waitFor(() => {
      expect(screen.getByAltText('Before resolution')).toHaveAttribute('src', 'https://example.com/before.jpg');
      expect(screen.getByAltText('After completion')).toHaveAttribute('src', 'https://example.com/after.jpg');
      expect(screen.getByRole('button', { name: /Verify Resolution/i })).toBeInTheDocument();
    });

    // Zero AI verdict/confidence wording in citizen component
    expect(container.textContent).not.toMatch(/appears_fixed|Model-estimated|AI suggestion/i);

    // Clicking Dispute without reason blocks submission
    fireEvent.click(screen.getByRole('button', { name: /Dispute Resolution/i }));
    fireEvent.click(screen.getByRole('button', { name: /Submit Dispute & Reopen/i }));
    expect(screen.getByText(/Please describe why the issue is not resolved/i)).toBeInTheDocument();
    expect(dispute).not.toHaveBeenCalled();

    // Enter reason and submit
    fireEvent.change(screen.getByLabelText(/Reason for Dispute/i), {
      target: { value: 'Drain is still overflowing.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Submit Dispute & Reopen/i }));

    await waitFor(() => {
      expect(dispute).toHaveBeenCalledWith('c-1', {
        evidence_id: 'e-1',
        reason: 'Drain is still overflowing.',
      });
      expect(onDecisionSubmitted).toHaveBeenCalledWith('disputed');
      expect(screen.getByText('Drain is still overflowing.')).toBeInTheDocument();
    });
  });

  it('submits Verify Resolution cleanly and handles error+retry state', async () => {
    const fetchStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error('Upstream error'))
      .mockResolvedValueOnce({
        complaint_id: 'c-2',
        complaint_status: 'resolved',
        latest_evidence_id: 'e-2',
        can_verify: true,
        current_decision: null,
        history: [],
      })
      .mockResolvedValueOnce({
        complaint_id: 'c-2',
        complaint_status: 'resolved',
        latest_evidence_id: 'e-2',
        can_verify: false,
        current_decision: {
          id: 'v-2',
          evidence_id: 'e-2',
          decision: 'verified',
          reason: null,
          created_at: '2026-11-25T13:00:00Z',
        },
        history: [
          {
            id: 'v-2',
            evidence_id: 'e-2',
            decision: 'verified',
            reason: null,
            created_at: '2026-11-25T13:00:00Z',
          },
        ],
      });
    const verify = vi.fn().mockResolvedValue({ verification_id: 'v-2', decision: 'verified' });

    render(
      <CitizenResolutionVerificationPanel
        complaintId="c-2"
        complaintStatus="resolved"
        api={{ fetchStatus, verify, dispute: vi.fn() }}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Upstream error')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Verify Resolution/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Verify Resolution/i }));

    await waitFor(() => {
      expect(verify).toHaveBeenCalledWith('c-2', { evidence_id: 'e-2' });
      expect(screen.getByText('Your Decision: Verified Fixed')).toBeInTheDocument();
    });
  });

  it('renders AdminVerificationHistoryPanel with decisions and blocks non-admins', async () => {
    const fetchVerifications = vi.fn().mockResolvedValue({
      complaint_id: 'c-3',
      complaint_status: 'in_progress',
      latest_evidence_id: 'e-3',
      latest_decision: 'disputed',
      history: [
        {
          id: 'v-3',
          evidence_id: 'e-3',
          decision: 'disputed',
          reason: 'Still broken at corner.',
          citizen_display_name: 'Ravi K.',
          created_at: '2026-11-25T14:00:00Z',
        },
      ],
    });

    const { container: nonAdminContainer } = render(
      <AdminVerificationHistoryPanel
        complaintId="c-3"
        complaintStatus="in_progress"
        isAdmin={false}
        api={{ fetchVerifications }}
      />
    );
    expect(nonAdminContainer).toBeEmptyDOMElement();
    expect(fetchVerifications).not.toHaveBeenCalled();

    render(
      <AdminVerificationHistoryPanel
        complaintId="c-3"
        complaintStatus="in_progress"
        isAdmin={true}
        api={{ fetchVerifications }}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Latest: Disputed')).toBeInTheDocument();
      expect(screen.getByText('Ravi K.')).toBeInTheDocument();
      expect(screen.getByText('Still broken at corner.')).toBeInTheDocument();
    });
  });

  it('renders AdminDisputedComplaintsPage with status filters, pagination, and detail links', async () => {
    const fetchDisputes = vi.fn().mockResolvedValue({
      items: [
        {
          complaint_id: 'c-4',
          complaint_reference: 'RU-2026-00404',
          title: 'Overflowing culvert',
          category: 'drainage',
          ward: 'Ward 9',
          complaint_status: 'resolved',
          dispute_state: 'escalated_to_admin',
          reopen_count: 2,
          latest_reason: 'Repeatedly unresolved after crew visit.',
          citizen_display_name: 'Meera P.',
          updated_at: '2026-11-25T15:00:00Z',
        },
      ],
      page: 1,
      page_size: 20,
      total: 1,
      total_pages: 1,
    });

    render(
      <MemoryRouter>
        <AdminDisputedComplaintsPage api={{ fetchDisputes }} />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Disputed Complaints Queue')).toBeInTheDocument();
      expect(screen.getByText('RU-2026-00404')).toBeInTheDocument();
      expect(screen.getByText('Repeatedly unresolved after crew visit.')).toBeInTheDocument();
    });

    const link = screen.getByRole('link', { name: /History & Review/i });
    expect(link).toHaveAttribute('href', '/admin/complaints/c-4');

    fireEvent.change(screen.getByLabelText('Dispute Status:'), {
      target: { value: 'escalated_to_admin' },
    });
    await waitFor(() => {
      expect(fetchDisputes).toHaveBeenLastCalledWith({
        status: 'escalated_to_admin',
        page: 1,
        page_size: 20,
      });
    });
  });

  it('shows admin escalation message when citizen dispute hits max reopen limit', async () => {
    const fetchStatus = vi.fn().mockResolvedValue({
      complaint_id: 'c-5',
      complaint_status: 'resolved',
      latest_evidence_id: 'e-5',
      can_verify: true,
      reopen_count: 2,
      max_reopens: 2,
      current_decision: null,
      history: [],
    });
    const dispute = vi.fn().mockResolvedValue({
      verification_id: 'v-5',
      decision: 'disputed',
      reopened: false,
      escalated_to_admin: true,
      message: 'Maximum automatic reopens reached. An administrator will review your dispute.',
    });

    render(
      <CitizenResolutionVerificationPanel
        complaintId="c-5"
        complaintStatus="resolved"
        api={{ fetchStatus, verify: vi.fn(), dispute }}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Dispute Resolution/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Dispute Resolution/i }));
    fireEvent.change(screen.getByLabelText(/Reason for Dispute/i), {
      target: { value: 'Issue persists after two reopens.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Submit Dispute & Reopen/i }));

    await waitFor(() => {
      expect(
        screen.getByText('Maximum automatic reopens reached. An administrator will review your dispute.')
      ).toBeInTheDocument();
    });
  });
});
