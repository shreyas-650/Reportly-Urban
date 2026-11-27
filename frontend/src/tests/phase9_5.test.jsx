import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminScreeningPanel from '../components/admin/AdminScreeningPanel';
import AdminScreeningQueuePage from '../pages/admin/AdminScreeningQueuePage';

const COMPLAINT_ID = '11111111-1111-4111-8111-111111111111';

describe('Phase 9.5 Admin Screening UI', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing for non-admin callers (citizens & officers never see flags)', () => {
    const { container } = render(
      <MemoryRouter>
        <AdminScreeningPanel
          complaintId={COMPLAINT_ID}
          complaintStatus="submitted"
          isAdmin={false}
        />
      </MemoryRouter>
    );
    expect(container.firstChild).toBeNull();
  });

  it('displays Shadow badge, signals, and dismiss/confirm controls for open review flags', async () => {
    const fetchScreening = vi.fn().mockResolvedValue({
      complaint_id: COMPLAINT_ID,
      complaint_status: 'submitted',
      screening_mode: 'shadow',
      feature_enabled: true,
      review: {
        review_id: 'rev-1',
        mode: 'shadow',
        risk_level: 'medium',
        confidence: 0.82,
        reason_codes: ['rate_abuse'],
        operational_flags: ['duplicate_suspected'],
        would_advance: false,
        applied_advance: false,
        review_status: 'needs_review',
        admin_decision: 'none',
        advancement_outcome: 'none',
      },
      events: [],
    });
    const dismissScreening = vi.fn().mockResolvedValue({ success: true });
    const confirmScreening = vi.fn().mockResolvedValue({ success: true });

    render(
      <MemoryRouter>
        <AdminScreeningPanel
          complaintId={COMPLAINT_ID}
          complaintStatus="submitted"
          isAdmin={true}
          api={{ fetchScreening, dismissScreening, confirmScreening }}
        />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Shadow')).toBeTruthy();
    });
    expect(screen.getByText('medium risk')).toBeTruthy();
    expect(screen.getByText('Elevated submission frequency')).toBeTruthy();
    expect(screen.getByText('Duplicate gate hold (suspected link)')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Dismiss Flag/i }));
    await waitFor(() => {
      expect(dismissScreening).toHaveBeenCalledWith(COMPLAINT_ID);
    });
  });

  it('allows admin to keep or revert AI advancement with validation on revert reason', async () => {
    const fetchScreening = vi.fn().mockResolvedValue({
      complaint_id: COMPLAINT_ID,
      complaint_status: 'under_review',
      screening_mode: 'active',
      feature_enabled: true,
      review: {
        review_id: 'rev-2',
        mode: 'active',
        risk_level: 'low',
        confidence: 0.94,
        reason_codes: [],
        operational_flags: [],
        would_advance: true,
        applied_advance: true,
        review_status: 'ai_advanced',
        admin_decision: 'none',
        advancement_outcome: 'pending_review',
      },
      events: [],
    });
    const revertAdvancement = vi.fn().mockResolvedValue({ success: true });

    render(
      <MemoryRouter>
        <AdminScreeningPanel
          complaintId={COMPLAINT_ID}
          complaintStatus="under_review"
          isAdmin={true}
          api={{ fetchScreening, revertAdvancement }}
        />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/AI auto-advanced this complaint/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /Revert \/ Flag Advancement/i }));
    fireEvent.click(screen.getByRole('button', { name: /Submit Revert Decision/i }));
    expect(screen.getByText(/at least 5 characters/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Revert Reason/i), {
      target: { value: 'Needs manual citizen evidence verification' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Submit Revert Decision/i }));
    await waitFor(() => {
      expect(revertAdvancement).toHaveBeenCalledWith(
        COMPLAINT_ID,
        'Needs manual citizen evidence verification'
      );
    });
  });

  it('renders AdminScreeningQueuePage with Shadow indicator and filter reload', async () => {
    const fetchQueue = vi.fn().mockResolvedValue({
      screening_mode: 'shadow',
      feature_enabled: true,
      items: [
        {
          review_id: 'rev-1',
          complaint_id: COMPLAINT_ID,
          complaint_number: 'RU-2026-0999',
          complaint_title: 'Gibberish submission test',
          complaint_category: 'potholes',
          complaint_status: 'submitted',
          complaint_created_at: '2026-11-27T09:00:00Z',
          screening_version: 'v1.0',
          model_name: 'deterministic_rules',
          prompt_version: 'v1.0',
          mode: 'shadow',
          risk_level: 'high',
          confidence: 0.96,
          reason_codes: ['gibberish'],
          operational_flags: [],
          used_gemini: false,
          would_advance: false,
          applied_advance: false,
          review_status: 'priority_review',
          admin_decision: 'none',
          advancement_outcome: 'none',
          created_at: '2026-11-27T09:00:05Z',
          updated_at: '2026-11-27T09:00:05Z',
        },
      ],
      total: 1,
      page: 1,
      page_size: 20,
      total_pages: 1,
    });

    render(
      <MemoryRouter>
        <AdminScreeningQueuePage api={{ fetchQueue }} />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('RU-2026-0999')).toBeTruthy();
    });
    expect(screen.getByText('Shadow Mode')).toBeTruthy();
    expect(screen.getByText('gibberish')).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Queue Filter/i), {
      target: { value: 'ai_advanced' },
    });
    await waitFor(() => {
      expect(fetchQueue).toHaveBeenCalledWith({
        status: 'ai_advanced',
        page: 1,
        page_size: 20,
      });
    });
  });
});
