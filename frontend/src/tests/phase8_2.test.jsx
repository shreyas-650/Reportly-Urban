import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import AdminAiResolutionPanel from '../components/admin/AdminAiResolutionPanel';

const COMPLAINT_ID = '11111111-1111-4111-8111-111111111111';

describe('Phase 8.2 Admin AI Resolution Comparison Panel Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing for citizens and officers (isAdmin = false)', () => {
    const fetchCheck = vi.fn();
    const { container } = render(
      <AdminAiResolutionPanel
        complaintId={COMPLAINT_ID}
        complaintStatus="resolved"
        isAdmin={false}
        api={{ fetchCheck, rerunCheck: vi.fn() }}
      />
    );
    expect(container.firstChild).toBeNull();
    expect(fetchCheck).not.toHaveBeenCalled();
  });

  it('shows feature-off state and disables re-run button while displaying mandatory advisory disclaimer', async () => {
    const fetchCheck = vi.fn().mockResolvedValue({
      feature_enabled: false,
      advisory_notice: 'This is an AI suggestion. It does not confirm that the work is complete.',
      confidence_note: 'Model-estimated visual confidence, not proof the work is complete',
      latest: null,
      attempts: [],
    });

    render(
      <AdminAiResolutionPanel
        complaintId={COMPLAINT_ID}
        complaintStatus="resolved"
        isAdmin={true}
        api={{ fetchCheck, rerunCheck: vi.fn() }}
      />
    );

    expect(await screen.findByText(/AI before-and-after comparison is currently turned off/i)).toBeInTheDocument();
    expect(screen.getByText(/This is an AI suggestion\. It does not confirm that the work is complete\./i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Re-run AI Comparison/i })).toBeDisabled();
  });

  it('renders completed verdict, escaped HTML summary, confidence note, metadata, and reloads from server after re-run', async () => {
    const user = userEvent.setup();
    const fetchCheck = vi
      .fn()
      .mockResolvedValueOnce({
        feature_enabled: true,
        advisory_notice: 'This is an AI suggestion. It does not confirm that the work is complete.',
        confidence_note: 'Model-estimated visual confidence, not proof the work is complete',
        latest: {
          id: 'chk-1',
          status: 'completed',
          verdict: 'unclear',
          confidence: 0.42,
          summary: '<b>Angle differs</b> <script>alert(1)</script> between photos.',
          failure_category: null,
          model_name: 'gemini-2.5-flash',
          prompt_version: 'v1.0',
          trigger_source: 'automatic',
          triggered_by_admin: false,
          created_at: '2026-11-25T10:00:00Z',
          completed_at: '2026-11-25T10:00:03Z',
        },
        attempts: [],
      })
      .mockResolvedValueOnce({
        feature_enabled: true,
        advisory_notice: 'This is an AI suggestion. It does not confirm that the work is complete.',
        confidence_note: 'Model-estimated visual confidence, not proof the work is complete',
        latest: {
          id: 'chk-2',
          status: 'completed',
          verdict: 'appears_fixed',
          confidence: 0.89,
          summary: 'Road depression appears patched in the completion photo.',
          failure_category: null,
          model_name: 'gemini-2.5-flash',
          prompt_version: 'v1.0',
          trigger_source: 'manual',
          triggered_by_admin: true,
          created_at: '2026-11-25T10:05:00Z',
          completed_at: '2026-11-25T10:05:02Z',
        },
        attempts: [],
      });

    const rerunCheck = vi.fn().mockResolvedValue({});

    const { container } = render(
      <AdminAiResolutionPanel
        complaintId={COMPLAINT_ID}
        complaintStatus="resolved"
        isAdmin={true}
        api={{ fetchCheck, rerunCheck }}
      />
    );

    expect(await screen.findByText(/Unclear \(different angles, poor lighting, blur, or insufficient visual evidence\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Model-estimated visual confidence, not proof the work is complete/i)).toBeInTheDocument();
    expect(screen.getByText(/Automatic post-resolution check/i)).toBeInTheDocument();
    expect(screen.getByText(/gemini-2.5-flash/i)).toBeInTheDocument();
    expect(screen.getByText(/v1\.0/i)).toBeInTheDocument();
    // Script/HTML must remain escaped plain text, never injected as a <script> DOM node
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText(/<script>alert\(1\)<\/script>/i)).toBeInTheDocument();
    // No approve or reject buttons controlled by AI
    expect(screen.queryByRole('button', { name: /Approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reject/i })).not.toBeInTheDocument();

    const rerunBtn = screen.getByRole('button', { name: /Re-run AI Comparison/i });
    await user.click(rerunBtn);

    await waitFor(() => {
      expect(rerunCheck).toHaveBeenCalledTimes(1);
      expect(fetchCheck).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText(/Appears fixed \(visual changes look consistent with the issue being addressed\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Manual re-run by Admin/i)).toBeInTheDocument();
  });

  it('renders pending, failed, appears_not_fixed, unavailable, and network_error states cleanly', async () => {
    const fetchPending = vi.fn().mockResolvedValue({
      feature_enabled: true,
      latest: { id: 'p1', status: 'pending', model_name: 'gemini-2.5-flash', prompt_version: 'v1.0', trigger_source: 'automatic', triggered_by_admin: false, created_at: '2026-11-25T10:00:00Z' },
    });
    const { unmount } = render(
      <AdminAiResolutionPanel complaintId={COMPLAINT_ID} complaintStatus="resolved" isAdmin={true} api={{ fetchCheck: fetchPending, rerunCheck: vi.fn() }} />
    );
    expect(await screen.findByText(/currently pending/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Re-run AI Comparison/i })).toBeDisabled();
    unmount();

    const fetchFailed = vi.fn().mockResolvedValue({
      feature_enabled: true,
      latest: { id: 'f1', status: 'failed', failure_category: 'timeout', model_name: 'gemini-2.5-flash', prompt_version: 'v1.0', trigger_source: 'automatic', triggered_by_admin: false, created_at: '2026-11-25T10:00:00Z', completed_at: '2026-11-25T10:00:15Z' },
    });
    const r2 = render(
      <AdminAiResolutionPanel complaintId={COMPLAINT_ID} complaintStatus="resolved" isAdmin={true} api={{ fetchCheck: fetchFailed, rerunCheck: vi.fn() }} />
    );
    expect(await screen.findByText(/Comparison Attempt Failed/i)).toBeInTheDocument();
    expect(screen.getByText(/timeout/i)).toBeInTheDocument();
    r2.unmount();

    const fetchNotFixed = vi.fn().mockResolvedValue({
      feature_enabled: true,
      latest: { id: 'n1', status: 'completed', verdict: 'appears_not_fixed', confidence: 0.77, summary: 'Pothole still unfilled.', model_name: 'gemini-2.5-flash', prompt_version: 'v1.0', trigger_source: 'manual', triggered_by_admin: true, created_at: '2026-11-25T10:00:00Z', completed_at: '2026-11-25T10:00:05Z' },
    });
    const r3 = render(
      <AdminAiResolutionPanel complaintId={COMPLAINT_ID} complaintStatus="resolved" isAdmin={true} api={{ fetchCheck: fetchNotFixed, rerunCheck: vi.fn() }} />
    );
    expect(await screen.findByText(/Does not appear fixed/i)).toBeInTheDocument();
    r3.unmount();

    const unavailErr = new Error('Service unavailable');
    unavailErr.status = 503;
    const r4 = render(
      <AdminAiResolutionPanel complaintId={COMPLAINT_ID} complaintStatus="resolved" isAdmin={true} api={{ fetchCheck: vi.fn().mockRejectedValue(unavailErr), rerunCheck: vi.fn() }} />
    );
    expect(await screen.findByText(/AI comparison service unavailable/i)).toBeInTheDocument();
    r4.unmount();

    const netErr = new Error('Network offline');
    render(
      <AdminAiResolutionPanel complaintId={COMPLAINT_ID} complaintStatus="resolved" isAdmin={true} api={{ fetchCheck: vi.fn().mockRejectedValue(netErr), rerunCheck: vi.fn() }} />
    );
    expect(await screen.findByText(/Network error reaching AI comparison service/i)).toBeInTheDocument();
  });
});
