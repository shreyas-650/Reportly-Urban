import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import OfficerComplaintDetailsPage from '../pages/officer/OfficerComplaintDetailsPage';

const mockUseAuth = vi.fn();

vi.mock('../context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('../components/maps/ComplaintLocationMap', () => ({
  default: () => <div data-testid="mock-location-map" />,
}));

vi.mock('../components/issues/ComplaintTimeline', () => ({
  default: () => <div data-testid="mock-timeline" />,
}));

const BASE_COMPLAINT = {
  id: '11111111-1111-4111-8111-111111111111',
  complaint_reference: 'RU-2026-00801',
  title: 'Damaged storm drain cover',
  category: 'drainage',
  description: 'Broken concrete drain slab near pedestrian crossing.',
  location: 'MG Road',
  ward: 'Ward 4',
  status: 'in_progress',
  priority: 'high',
  department_name: 'Stormwater & Drainage',
  assigned_officer_id: 'off-1',
  sla_deadline: '2026-11-26T12:00:00Z',
  created_at: '2026-11-25T05:00:00Z',
  updated_at: '2026-11-25T08:00:00Z',
  current_level: 0,
  timeline: [],
  escalations: [],
};

function renderPage({ fetcher, resolutionApi }) {
  return render(
    <MemoryRouter initialEntries={[`/officer/complaints/${BASE_COMPLAINT.id}`]}>
      <Routes>
        <Route
          path="/officer/complaints/:id"
          element={<OfficerComplaintDetailsPage fetcher={fetcher} resolutionApi={resolutionApi} />}
        />
      </Routes>
    </MemoryRouter>
  );
}

describe('Phase 8.1 Officer Completion Photo Resolve Screen Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAuth.mockReturnValue({
      officerRecord: { id: 'off-1' },
    });
  });

  it('keeps Mark Resolved disabled until verified upload completes, shows preview, and resolves cleanly', async () => {
    const user = userEvent.setup();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(BASE_COMPLAINT)
      .mockResolvedValueOnce({ ...BASE_COMPLAINT, status: 'resolved', updated_at: '2026-11-25T09:00:00Z' });

    const uploadPhoto = vi.fn().mockResolvedValue({
      evidence_id: 'ev-1',
      storage_path: `resolution/${BASE_COMPLAINT.id}/aaaa1111-2222-4333-8444-555566667777.jpg`,
      mime_type: 'image/jpeg',
      file_size_bytes: 12000,
      width: 640,
      height: 480,
      upload_status: 'completed',
      exif_stripped: true,
    });
    const resolveComplaint = vi.fn().mockResolvedValue({
      complaint_id: BASE_COMPLAINT.id,
      status: 'resolved',
    });

    renderPage({
      fetcher,
      resolutionApi: { uploadPhoto, registerPhoto: vi.fn(), resolveComplaint, transitionComplaint: vi.fn() },
    });

    const openBtn = await screen.findByRole('button', { name: /Upload Completion Proof & Resolve/i });
    await user.click(openBtn);

    const resolveBtn = screen.getByRole('button', { name: /Mark Resolved/i });
    expect(resolveBtn).toBeDisabled();
    expect(screen.getByText(/Mark Resolved stays disabled until the photo is verified and saved/i)).toBeInTheDocument();

    const fileInput = screen.getByLabelText(/Completion Photograph/i);
    const validFile = new File(['fake-jpg-bytes'], 'repaired.jpg', { type: 'image/jpeg' });
    await user.upload(fileInput, validFile);

    await waitFor(() => {
      expect(uploadPhoto).toHaveBeenCalledWith(BASE_COMPLAINT.id, validFile);
      expect(resolveBtn).not.toBeDisabled();
    });
    expect(screen.getByText(/Completion photo verified and ready/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/Public Progress Note/i), 'Replaced damaged slab and cleared debris.');
    await user.click(resolveBtn);

    await waitFor(() => {
      expect(resolveComplaint).toHaveBeenCalledWith(BASE_COMPLAINT.id, {
        expectedUpdatedAt: BASE_COMPLAINT.updated_at,
        publicDescription: 'Replaced damaged slab and cleared debris.',
        resolutionImagePath: `resolution/${BASE_COMPLAINT.id}/aaaa1111-2222-4333-8444-555566667777.jpg`,
      });
    });
    expect(await screen.findByText(/Complaint marked resolved with verified completion photograph/i)).toBeInTheDocument();
  });

  it('handles upload-succeeded-but-registration-failed with clean retry while blocking resolve', async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn().mockResolvedValue(BASE_COMPLAINT);
    const pendingPath = `resolution/${BASE_COMPLAINT.id}/bbbb1111-2222-4333-8444-555566667777.jpg`;

    const regErr = new Error('The photo was uploaded, but saving its completion record failed.');
    regErr.status = 502;
    regErr.data = { registration_pending: true, storage_path: pendingPath };

    const uploadPhoto = vi.fn().mockRejectedValueOnce(regErr);
    const registerPhoto = vi.fn().mockResolvedValueOnce({
      evidence_id: 'ev-2',
      storage_path: pendingPath,
      upload_status: 'completed',
      exif_stripped: true,
    });
    const resolveComplaint = vi.fn();

    renderPage({
      fetcher,
      resolutionApi: { uploadPhoto, registerPhoto, resolveComplaint, transitionComplaint: vi.fn() },
    });

    await user.click(await screen.findByRole('button', { name: /Upload Completion Proof & Resolve/i }));
    const fileInput = screen.getByLabelText(/Completion Photograph/i);
    await user.upload(fileInput, new File(['bytes'], 'proof.jpg', { type: 'image/jpeg' }));

    const retryBtn = await screen.findByRole('button', { name: /Retry Saving Photo Record/i });
    expect(screen.getByRole('button', { name: /Mark Resolved/i })).toBeDisabled();

    await user.click(retryBtn);
    await waitFor(() => {
      expect(registerPhoto).toHaveBeenCalledWith(BASE_COMPLAINT.id, pendingPath);
      expect(screen.getByRole('button', { name: /Mark Resolved/i })).not.toBeDisabled();
    });
    expect(uploadPhoto).toHaveBeenCalledTimes(1);
    expect(resolveComplaint).not.toHaveBeenCalled();
  });

  it('re-checks real complaint status after resolve timeout and prevents double-resolve when already resolved', async () => {
    const user = userEvent.setup();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(BASE_COMPLAINT)
      .mockResolvedValueOnce({ ...BASE_COMPLAINT, status: 'resolved', updated_at: '2026-11-25T09:10:00Z' });

    const uploadPhoto = vi.fn().mockResolvedValue({
      evidence_id: 'ev-3',
      storage_path: `resolution/${BASE_COMPLAINT.id}/cccc1111-2222-4333-8444-555566667777.jpg`,
      upload_status: 'completed',
      exif_stripped: true,
    });
    const timeoutErr = new Error('Request timed out or was cancelled.');
    timeoutErr.name = 'AbortError';
    timeoutErr.isTimeout = true;
    const resolveComplaint = vi.fn().mockRejectedValueOnce(timeoutErr);

    renderPage({
      fetcher,
      resolutionApi: { uploadPhoto, registerPhoto: vi.fn(), resolveComplaint, transitionComplaint: vi.fn() },
    });

    await user.click(await screen.findByRole('button', { name: /Upload Completion Proof & Resolve/i }));
    await user.upload(
      screen.getByLabelText(/Completion Photograph/i),
      new File(['bytes'], 'proof.jpg', { type: 'image/jpeg' })
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /Mark Resolved/i })).not.toBeDisabled());

    await user.type(screen.getByLabelText(/Public Progress Note/i), 'Completed manhole replacement cleanly.');
    await user.click(screen.getByRole('button', { name: /Mark Resolved/i }));

    expect(
      await screen.findByText(/status check confirmed this complaint is already marked resolved/i)
    ).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText(/terminal state \(resolved\)/i)).toBeInTheDocument();
  });

  it('allows retrying safely if post-timeout status check confirms complaint is still in_progress, and preserves non-resolve transitions', async () => {
    const user = userEvent.setup();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(BASE_COMPLAINT)
      .mockResolvedValueOnce({ ...BASE_COMPLAINT, status: 'in_progress', updated_at: '2026-11-25T08:05:00Z' });

    const uploadPhoto = vi.fn().mockResolvedValue({
      evidence_id: 'ev-4',
      storage_path: `resolution/${BASE_COMPLAINT.id}/dddd1111-2222-4333-8444-555566667777.jpg`,
      upload_status: 'completed',
      exif_stripped: true,
    });
    const timeoutErr = new Error('Timed out');
    timeoutErr.isTimeout = true;
    const resolveComplaint = vi.fn().mockRejectedValueOnce(timeoutErr);

    renderPage({
      fetcher,
      resolutionApi: { uploadPhoto, registerPhoto: vi.fn(), resolveComplaint, transitionComplaint: vi.fn() },
    });

    await user.click(await screen.findByRole('button', { name: /Upload Completion Proof & Resolve/i }));
    await user.upload(
      screen.getByLabelText(/Completion Photograph/i),
      new File(['bytes'], 'proof.jpg', { type: 'image/jpeg' })
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /Mark Resolved/i })).not.toBeDisabled());
    await user.type(screen.getByLabelText(/Public Progress Note/i), 'Resurfaced section and inspected drain.');
    await user.click(screen.getByRole('button', { name: /Mark Resolved/i }));

    expect(
      await screen.findByText(/Real status is still "in progress" — you can safely try marking it resolved again/i)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Mark Resolved/i })).not.toBeDisabled();
  });

  it('keeps Mark Resolved locked with Re-check Status button if timeout re-check fails, and preserves in_progress transition', async () => {
    const user = userEvent.setup();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(BASE_COMPLAINT)
      .mockRejectedValueOnce(new Error('Network offline'))
      .mockResolvedValueOnce({ ...BASE_COMPLAINT, status: 'resolved', updated_at: '2026-11-25T09:15:00Z' });

    const uploadPhoto = vi.fn().mockResolvedValue({
      evidence_id: 'ev-5',
      storage_path: `resolution/${BASE_COMPLAINT.id}/eeee1111-2222-4333-8444-555566667777.jpg`,
      upload_status: 'completed',
      exif_stripped: true,
    });
    const timeoutErr = new Error('Timed out');
    timeoutErr.isTimeout = true;
    const resolveComplaint = vi.fn().mockRejectedValueOnce(timeoutErr);

    renderPage({
      fetcher,
      resolutionApi: { uploadPhoto, registerPhoto: vi.fn(), resolveComplaint, transitionComplaint: vi.fn() },
    });

    await user.click(await screen.findByRole('button', { name: /Upload Completion Proof & Resolve/i }));
    await user.upload(
      screen.getByLabelText(/Completion Photograph/i),
      new File(['bytes'], 'proof.jpg', { type: 'image/jpeg' })
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /Mark Resolved/i })).not.toBeDisabled());
    await user.type(screen.getByLabelText(/Public Progress Note/i), 'Completed repair and verified site.');
    await user.click(screen.getByRole('button', { name: /Mark Resolved/i }));

    const recheckBtn = await screen.findByRole('button', { name: /Re-check Complaint Status/i });
    expect(screen.getByRole('button', { name: /Mark Resolved/i })).toBeDisabled();

    await user.click(recheckBtn);
    expect(
      await screen.findByText(/status check confirmed this complaint is already marked resolved/i)
    ).toBeInTheDocument();
  });

  it('preserves under_review -> in_progress transition without requiring a completion photo', async () => {
    const user = userEvent.setup();
    const underReviewComplaint = { ...BASE_COMPLAINT, status: 'under_review' };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(underReviewComplaint)
      .mockResolvedValueOnce({ ...BASE_COMPLAINT, status: 'in_progress' });
    const transitionComplaint = vi.fn().mockResolvedValue({ data: null, error: null });

    renderPage({
      fetcher,
      resolutionApi: { uploadPhoto: vi.fn(), registerPhoto: vi.fn(), resolveComplaint: vi.fn(), transitionComplaint },
    });

    await user.click(await screen.findByRole('button', { name: /Commence Fieldwork/i }));
    const confirmBtn = screen.getByRole('button', { name: /Confirm/i });
    expect(confirmBtn).not.toBeDisabled();

    await user.click(confirmBtn);
    await waitFor(() => {
      expect(transitionComplaint).toHaveBeenCalledWith({
        complaintId: BASE_COMPLAINT.id,
        newStatus: 'in_progress',
        expectedUpdatedAt: underReviewComplaint.updated_at,
        publicDescription: null,
        internalNote: null,
        resolutionImagePath: null,
      });
    });
  });
});
