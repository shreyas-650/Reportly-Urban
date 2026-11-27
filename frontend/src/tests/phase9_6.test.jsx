import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CitizenReviewAppealCard from '../components/issues/CitizenReviewAppealCard';
import AdminAccuracyAppealsPage from '../pages/admin/AdminAccuracyAppealsPage';

const COMPLAINT_ID = '11111111-1111-4111-8111-111111111111';

describe('Phase 9.6 Citizen Appeal & Admin Accuracy Dashboard UI', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('CitizenReviewAppealCard stays hidden when ineligible/off and stays neutral when eligible', async () => {
    const fetchOff = vi.fn().mockResolvedValue({
      eligible: false,
      has_open_appeal: false,
      appeal_status: 'none',
    });
    const { container, unmount } = render(
      <CitizenReviewAppealCard complaintId={COMPLAINT_ID} api={{ fetchStatus: fetchOff }} />
    );
    await waitFor(() => expect(fetchOff).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
    unmount();

    const fetchEligible = vi.fn().mockResolvedValue({
      eligible: true,
      has_open_appeal: false,
      appeal_status: 'none',
    });
    const submitAppeal = vi.fn().mockResolvedValue({ submitted: true, status: 'open' });

    render(
      <CitizenReviewAppealCard
        complaintId={COMPLAINT_ID}
        api={{ fetchStatus: fetchEligible, submitAppeal }}
      />
    );

    await waitFor(() => {
      expect(screen.getByLabelText(/Review Note/i)).toBeTruthy();
    });

    // Strictly zero AI/flag terminology visible to citizens
    expect(document.body.textContent).not.toMatch(/suspicious|flagged by AI|confidence score|risk level/i);

    fireEvent.change(screen.getByLabelText(/Review Note/i), {
      target: { value: 'This urgent road blockage has been pending over three days.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Request Review/i }));

    await waitFor(() => {
      expect(submitAppeal).toHaveBeenCalledWith(
        COMPLAINT_ID,
        'This urgent road blockage has been pending over three days.'
      );
    });
  });

  it('AdminAccuracyAppealsPage displays Not enough data below min_samples, ward fairness notice, and plain-text appeals', async () => {
    const fetchDashboard = vi.fn().mockResolvedValue({
      window: '30d',
      date_from: '2026-10-28T00:00:00Z',
      date_to: '2026-11-27T00:00:00Z',
      min_samples: 20,
      plain_review_appeals_count: 1,
      cards: [
        {
          feature: 'category_priority',
          label: '9.1 Category & Priority',
          sample_size: 4,
          agreed_count: 3,
          disagreed_count: 1,
          excluded_count: 2,
          enough_data: false,
          agreement_rate: null,
          override_rate: null,
        },
        {
          feature: 'duplicate_detection',
          label: '9.4 Duplicate Detection',
          sample_size: 25,
          agreed_count: 22,
          disagreed_count: 3,
          excluded_count: 5,
          enough_data: true,
          agreement_rate: 0.88,
          false_positive_rate: 0.12,
        },
      ],
    });

    const fetchWards = vi.fn().mockResolvedValue({
      scope: 'category_priority',
      fixed_window: 'all_time',
      ward_min_samples: 20,
      fairness_notice: 'Fairness monitoring, informational only. Ward data never feeds any AI decision, threshold, or gate.',
      displayed_sample_total: 25,
      displayed_overall_rate: 0.88,
      enough_data: true,
      wards: [
        {
          ward: 'ward 1 - north central',
          is_other: false,
          sample_size: 25,
          agreed_count: 22,
          agreement_rate: 0.88,
          disparity_vs_overall: 0.0,
        },
      ],
    });

    const fetchAppeals = vi.fn().mockResolvedValue({
      appeal_feature_enabled: false,
      backend_flag_enabled: false,
      items: [
        {
          appeal_id: 'app-1',
          complaint_id: COMPLAINT_ID,
          complaint_number: 'RU-2026-0777',
          complaint_title: 'Drainage blocked on avenue',
          complaint_category: 'drainage',
          complaint_ward: 'Ward 1 - North Central',
          complaint_status: 'submitted',
          appeal_text: '<script>alert("xss")</script> Needs manual inspection please.',
          appeal_status: 'open',
          had_active_flag: true,
          risk_level: 'medium',
          created_at: '2026-11-27T09:00:00Z',
        },
      ],
      total: 1,
      page: 1,
      page_size: 20,
      total_pages: 1,
    });

    const decideAppeal = vi.fn().mockResolvedValue({ success: true });

    render(
      <MemoryRouter>
        <AdminAccuracyAppealsPage
          api={{ fetchDashboard, fetchWards, fetchAppeals, decideAppeal }}
        />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('9.1 Category & Priority')).toBeTruthy();
    });
    expect(screen.getByText(/Not enough data \(requires ≥ 20 verified samples\)/i)).toBeTruthy();
    expect(screen.getAllByText('88.0%').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Fairness monitoring, informational only/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Review Appeals/i }));
    await waitFor(() => {
      expect(screen.getByText('RU-2026-0777')).toBeTruthy();
    });

    // Amendment E: Rendered strictly as literal escaped text, never executable HTML
    expect(screen.getByText(/<script>alert\("xss"\)<\/script> Needs manual inspection please\./)).toBeTruthy();
    expect(screen.getByText(/Needs More Info.*admin-side decision only/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Release Flag/i }));
    await waitFor(() => {
      expect(decideAppeal).toHaveBeenCalledWith('app-1', {
        outcome: 'released',
        reason: null,
        is_correction: false,
      });
    });
  });
});
