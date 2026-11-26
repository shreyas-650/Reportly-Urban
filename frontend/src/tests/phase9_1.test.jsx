import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import AdminAiSuggestionPanel from '../components/admin/AdminAiSuggestionPanel';
import { createComplaint } from '../services/complaintService';

const COMPLAINT_ID = '11111111-1111-4111-8111-111111111111';
const CITIZEN_ID = '33333333-3333-4333-8333-333333333333';
const IDEMPOTENCY_KEY = '44444444-4444-4444-8444-444444444444';

describe('Phase 9.1 AdminAiSuggestionPanel (Shadow Mode)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders nothing for non-admins (citizens and officers see nothing)', () => {
    const fetchSuggestion = vi.fn();
    const { container } = render(
      <AdminAiSuggestionPanel
        complaintId={COMPLAINT_ID}
        complaintCategory="potholes"
        complaintPriority="normal"
        complaintStatus="submitted"
        expectedUpdatedAt="2026-11-26T00:00:00Z"
        isAdmin={false}
        api={{ fetchSuggestion }}
      />
    );
    expect(container.firstChild).toBeNull();
    expect(fetchSuggestion).not.toHaveBeenCalled();
  });

  it('shows clear AI is off state when feature_enabled is false', async () => {
    const fetchSuggestion = vi.fn().mockResolvedValue({
      feature_enabled: false,
      label: 'AI suggestion',
      shadow_mode: true,
      latest: null,
      attempts: [],
    });

    render(
      <AdminAiSuggestionPanel
        complaintId={COMPLAINT_ID}
        complaintCategory="potholes"
        complaintPriority="normal"
        complaintStatus="submitted"
        expectedUpdatedAt="2026-11-26T00:00:00Z"
        isAdmin={true}
        api={{ fetchSuggestion }}
      />
    );

    expect(await screen.findByText(/AI is off/i)).toBeTruthy();
    expect(screen.getByText(/AI suggestion/i)).toBeTruthy();
  });

  it('shows clear No suggestion state when enabled but none recorded', async () => {
    const fetchSuggestion = vi.fn().mockResolvedValue({
      feature_enabled: true,
      label: 'AI suggestion',
      shadow_mode: true,
      latest: null,
      attempts: [],
    });

    render(
      <AdminAiSuggestionPanel
        complaintId={COMPLAINT_ID}
        complaintCategory="potholes"
        complaintPriority="normal"
        complaintStatus="submitted"
        expectedUpdatedAt="2026-11-26T00:00:00Z"
        isAdmin={true}
        api={{ fetchSuggestion }}
      />
    );

    expect(await screen.findByText(/No suggestion available/i)).toBeTruthy();
  });

  it('renders suggestion with confidence and handles Accept and Override actions', async () => {
    const pendingAttempt = {
      id: '22222222-2222-4222-8222-222222222222',
      complaint_id: COMPLAINT_ID,
      feature: 'category_priority_suggestion',
      model_name: 'gemini-2.5-flash',
      prompt_version: 'v1.0',
      status: 'completed',
      suggested_category: 'drainage',
      suggested_priority: 'high',
      confidence: 0.89,
      error_message: null,
      admin_decision: 'pending',
      final_category: null,
      final_priority: null,
      decided_at: null,
      created_at: '2026-11-26T00:00:00Z',
      completed_at: '2026-11-26T00:00:02Z',
    };

    const fetchSuggestion = vi
      .fn()
      .mockResolvedValueOnce({
        feature_enabled: true,
        label: 'AI suggestion',
        shadow_mode: true,
        latest: pendingAttempt,
        attempts: [pendingAttempt],
      })
      .mockResolvedValue({
        feature_enabled: true,
        label: 'AI suggestion',
        shadow_mode: true,
        latest: {
          ...pendingAttempt,
          admin_decision: 'accepted',
          final_category: 'drainage',
          final_priority: 'high',
          decided_at: '2026-11-26T00:05:00Z',
        },
        attempts: [],
      });

    const acceptSuggestion = vi.fn().mockResolvedValue({ success: true });
    const overrideSuggestion = vi.fn().mockResolvedValue({ success: true });
    const onDecisionSaved = vi.fn().mockResolvedValue(undefined);

    render(
      <AdminAiSuggestionPanel
        complaintId={COMPLAINT_ID}
        complaintCategory="potholes"
        complaintPriority="normal"
        complaintStatus="submitted"
        expectedUpdatedAt="2026-11-26T00:00:00Z"
        isAdmin={true}
        onDecisionSaved={onDecisionSaved}
        api={{ fetchSuggestion, acceptSuggestion, overrideSuggestion }}
      />
    );

    expect(await screen.findByText('Drainage & Sewage')).toBeTruthy();
    expect(screen.getByText(/89% \(0\.89\)/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Override/i }));
    fireEvent.change(screen.getByLabelText(/Final Category/i), {
      target: { value: 'streetlights' },
    });
    fireEvent.change(screen.getByLabelText(/Final Priority/i), {
      target: { value: 'emergency' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save Override/i }));

    await waitFor(() => {
      expect(overrideSuggestion).toHaveBeenCalledWith(COMPLAINT_ID, {
        category: 'streetlights',
        priority: 'emergency',
        expected_updated_at: '2026-11-26T00:00:00Z',
      });
      expect(onDecisionSaved).toHaveBeenCalled();
    });
  });

  it('accepts suggestion and refreshes complaint details', async () => {
    const pendingAttempt = {
      id: '22222222-2222-4222-8222-222222222222',
      complaint_id: COMPLAINT_ID,
      feature: 'category_priority_suggestion',
      model_name: 'gemini-2.5-flash',
      prompt_version: 'v1.0',
      status: 'completed',
      suggested_category: 'garbage',
      suggested_priority: 'medium',
      confidence: 0.92,
      error_message: null,
      admin_decision: 'pending',
      final_category: null,
      final_priority: null,
      decided_at: null,
      created_at: '2026-11-26T00:00:00Z',
      completed_at: '2026-11-26T00:00:02Z',
    };

    const fetchSuggestion = vi
      .fn()
      .mockResolvedValueOnce({
        feature_enabled: true,
        label: 'AI suggestion',
        shadow_mode: true,
        latest: pendingAttempt,
        attempts: [pendingAttempt],
      })
      .mockResolvedValueOnce({
        feature_enabled: true,
        label: 'AI suggestion',
        shadow_mode: true,
        latest: {
          ...pendingAttempt,
          admin_decision: 'accepted',
          final_category: 'garbage',
          final_priority: 'medium',
          decided_at: '2026-11-26T00:05:00Z',
        },
        attempts: [],
      });

    const acceptSuggestion = vi.fn().mockResolvedValue({ success: true });
    const onDecisionSaved = vi.fn().mockResolvedValue(undefined);

    render(
      <AdminAiSuggestionPanel
        complaintId={COMPLAINT_ID}
        complaintCategory="potholes"
        complaintPriority="normal"
        complaintStatus="submitted"
        expectedUpdatedAt="2026-11-26T00:00:00Z"
        isAdmin={true}
        onDecisionSaved={onDecisionSaved}
        api={{ fetchSuggestion, acceptSuggestion }}
      />
    );

    const acceptBtn = await screen.findByRole('button', { name: /^Accept$/i });
    fireEvent.click(acceptBtn);

    await waitFor(() => {
      expect(acceptSuggestion).toHaveBeenCalledWith(COMPLAINT_ID, {
        expected_updated_at: '2026-11-26T00:00:00Z',
      });
      expect(onDecisionSaved).toHaveBeenCalled();
    });
  });

  it('complaint creation is never blocked even if shadow AI trigger fetch fails', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Backend down'));

    const fakeSupabase = {
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: { session: { user: { id: CITIZEN_ID }, access_token: 'jwt-token' } },
          error: null,
        }),
      },
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: {
                id: COMPLAINT_ID,
                complaint_number: 'RU-2026-0099',
                status: 'submitted',
                title: 'Pothole on Main Road',
                category: 'potholes',
              },
              error: null,
            }),
          }),
        }),
      }),
    };

    const result = await createComplaint({
      title: 'Pothole on Main Road',
      category: 'potholes',
      ward: 'Ward 5',
      location: 'Main Road Junction',
      description: 'Large pothole obstructing traffic near main bus stop.',
      uploadedStoragePath: `${CITIZEN_ID}/${IDEMPOTENCY_KEY}.jpg`,
      idempotencyKey: IDEMPOTENCY_KEY,
      supabaseClient: fakeSupabase,
    });

    expect(result.error).toBeNull();
    expect(result.data?.id).toBe(COMPLAINT_ID);
    expect(fetchSpy).toHaveBeenCalled();
  });
});
