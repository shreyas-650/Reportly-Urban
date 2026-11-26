import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import AdminDuplicateLinksPanel from '../components/admin/AdminDuplicateLinksPanel';
import AdminDuplicatesPage from '../pages/admin/AdminDuplicatesPage';
import { createComplaint } from '../services/complaintService';

const COMPLAINT_ID = '11111111-1111-4111-8111-111111111111';
const CANDIDATE_ID = '22222222-2222-4222-8222-222222222222';
const LINK_ID = '88888888-8888-4888-8888-888888888888';
const CITIZEN_ID = '33333333-3333-4333-8333-333333333333';
const IDEMPOTENCY_KEY = '44444444-4444-4444-8444-444444444444';

describe('Phase 9.4 Duplicate Detection Admin UI', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders nothing on complaint details for non-admins (citizens and officers see nothing)', () => {
    const fetchDuplicates = vi.fn();
    const { container } = render(
      <MemoryRouter>
        <AdminDuplicateLinksPanel
          complaintId={COMPLAINT_ID}
          isAdmin={false}
          api={{ fetchDuplicates }}
        />
      </MemoryRouter>
    );
    expect(container.firstChild).toBeNull();
    expect(fetchDuplicates).not.toHaveBeenCalled();
  });

  it('shows AI is off state and Confirm / Not a duplicate actions for suspected links', async () => {
    const suspectedLink = {
      id: LINK_ID,
      complaint_id: COMPLAINT_ID,
      candidate_complaint_id: CANDIDATE_ID,
      similarity_score: 0.87,
      reason: 'Same category (potholes) within 45m.',
      method: 'rule',
      status: 'suspected',
      decided_by: null,
      decided_at: null,
      created_at: '2026-11-26T00:00:00Z',
      linked_complaint_id: CANDIDATE_ID,
      linked_complaint_number: 'RU-2026-0098',
      linked_title: 'Deep pothole near metro pillar',
      linked_category: 'potholes',
      linked_ward: 'Ward 8',
      linked_status: 'under_review',
      linked_priority: 'normal',
      linked_created_at: '2026-11-25T10:00:00Z',
    };

    const fetchDuplicates = vi
      .fn()
      .mockResolvedValueOnce({
        feature_enabled: false,
        items: [suspectedLink],
      })
      .mockResolvedValueOnce({
        feature_enabled: false,
        items: [
          {
            ...suspectedLink,
            status: 'confirmed_duplicate',
            decided_at: '2026-11-26T01:00:00Z',
          },
        ],
      });

    const confirmDuplicate = vi.fn().mockResolvedValue({ success: true });
    const dismissDuplicate = vi.fn().mockResolvedValue({ success: true });

    render(
      <MemoryRouter>
        <AdminDuplicateLinksPanel
          complaintId={COMPLAINT_ID}
          isAdmin={true}
          api={{ fetchDuplicates, confirmDuplicate, dismissDuplicate }}
        />
      </MemoryRouter>
    );

    expect(await screen.findByText('RU-2026-0098')).toBeTruthy();
    expect(screen.getByText(/AI is off/i)).toBeTruthy();
    expect(screen.getByText(/87% similarity \(Rule\)/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Confirm$/i }));

    await waitFor(() => {
      expect(confirmDuplicate).toHaveBeenCalledWith(LINK_ID);
    });
    expect(await screen.findByText(/Confirmed Duplicate/i)).toBeTruthy();
  });

  it('calls Not a duplicate when dismissed', async () => {
    const suspectedLink = {
      id: LINK_ID,
      complaint_id: COMPLAINT_ID,
      candidate_complaint_id: CANDIDATE_ID,
      similarity_score: 0.81,
      reason: 'AI matched similar drainage blockage description.',
      method: 'ai',
      status: 'suspected',
      decided_by: null,
      decided_at: null,
      created_at: '2026-11-26T00:00:00Z',
      linked_complaint_id: CANDIDATE_ID,
      linked_complaint_number: 'RU-2026-0077',
      linked_title: 'Blocked storm drain',
      linked_category: 'drainage',
      linked_ward: 'Ward 3',
      linked_status: 'submitted',
      linked_priority: 'high',
      linked_created_at: '2026-11-25T10:00:00Z',
    };

    const fetchDuplicates = vi
      .fn()
      .mockResolvedValueOnce({ feature_enabled: true, items: [suspectedLink] })
      .mockResolvedValueOnce({
        feature_enabled: true,
        items: [{ ...suspectedLink, status: 'not_duplicate', decided_at: '2026-11-26T01:00:00Z' }],
      });

    const dismissDuplicate = vi.fn().mockResolvedValue({ success: true });

    render(
      <MemoryRouter>
        <AdminDuplicateLinksPanel
          complaintId={COMPLAINT_ID}
          isAdmin={true}
          api={{ fetchDuplicates, dismissDuplicate }}
        />
      </MemoryRouter>
    );

    const dismissBtn = await screen.findByRole('button', { name: /Not a duplicate/i });
    fireEvent.click(dismissBtn);

    await waitFor(() => {
      expect(dismissDuplicate).toHaveBeenCalledWith(LINK_ID);
    });
    expect(await screen.findByText(/Not a duplicate/i)).toBeTruthy();
  });

  it('renders AdminDuplicatesPage with filters, pagination, and AI is off banner', async () => {
    const fetchDuplicates = vi.fn().mockResolvedValue({
      feature_enabled: false,
      items: [
        {
          id: LINK_ID,
          complaint_id: COMPLAINT_ID,
          candidate_complaint_id: CANDIDATE_ID,
          similarity_score: 0.85,
          reason: 'Same category within 30m.',
          method: 'rule',
          status: 'suspected',
          decided_at: null,
          created_at: '2026-11-26T00:00:00Z',
          complaint_number: 'RU-2026-0101',
          complaint_title: 'Pothole near gate',
          complaint_category: 'potholes',
          complaint_ward: 'Ward 8',
          complaint_status: 'submitted',
          candidate_complaint_number: 'RU-2026-0098',
          candidate_title: 'Nearby pothole',
          candidate_ward: 'Ward 8',
          candidate_status: 'under_review',
        },
      ],
      total: 25,
      page: 1,
      page_size: 20,
      total_pages: 2,
    });

    render(
      <MemoryRouter>
        <AdminDuplicatesPage api={{ fetchDuplicates }} />
      </MemoryRouter>
    );

    expect(await screen.findByText('RU-2026-0101')).toBeTruthy();
    expect(screen.getByText('RU-2026-0098')).toBeTruthy();
    expect(screen.getByText(/AI is off/i)).toBeTruthy();
    expect(screen.getByText(/Page 1 of 2/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Link Status/i), {
      target: { value: 'confirmed_duplicate' },
    });

    await waitFor(() => {
      expect(fetchDuplicates).toHaveBeenLastCalledWith({
        status: 'confirmed_duplicate',
        page: 1,
        page_size: 20,
      });
    });
  });

  it('groups multiple duplicate candidates under one complaint header without repeating the same complaint name', async () => {
    const fetchDuplicates = vi
      .fn()
      .mockResolvedValueOnce({
        feature_enabled: true,
        items: [
          {
            id: 'link-1',
            complaint_id: 'cmp-71',
            candidate_complaint_id: 'cmp-64',
            similarity_score: 0.63,
            reason: 'Same category (potholes) within 143m and recent open window.',
            method: 'rule',
            status: 'suspected',
            decided_at: null,
            created_at: '2026-11-26T21:48:00Z',
            complaint_number: 'RU-2026-0071',
            complaint_title: 'Nashik Potholes',
            complaint_category: 'potholes',
            complaint_ward: 'Ward 1 - North Central',
            complaint_status: 'submitted',
            candidate_complaint_number: 'RU-2026-0064',
            candidate_title: 'Problem Pothole ki ha',
            candidate_ward: 'Ward 1 - North Central',
            candidate_status: 'submitted',
          },
          {
            id: 'link-2',
            complaint_id: 'cmp-71',
            candidate_complaint_id: 'cmp-63',
            similarity_score: 0.67,
            reason: 'Same category (potholes) within 110m and recent open window.',
            method: 'rule',
            status: 'suspected',
            decided_at: null,
            created_at: '2026-11-26T21:48:00Z',
            complaint_number: 'RU-2026-0071',
            complaint_title: 'Nashik Potholes',
            complaint_category: 'potholes',
            complaint_ward: 'Ward 1 - North Central',
            complaint_status: 'submitted',
            candidate_complaint_number: 'RU-2026-0063',
            candidate_title: 'Gaadha ha bhai',
            candidate_ward: 'Ward 1 - North Central',
            candidate_status: 'submitted',
          },
          {
            id: 'link-3',
            complaint_id: 'cmp-69',
            candidate_complaint_id: 'cmp-60',
            similarity_score: 0.77,
            reason: 'Same category (potholes) within 25m and recent open window.',
            method: 'rule',
            status: 'suspected',
            decided_at: null,
            created_at: '2026-11-26T21:42:00Z',
            complaint_number: 'RU-2026-0069',
            complaint_title: 'Hello Duplicate',
            complaint_category: 'potholes',
            complaint_ward: 'Ward 1 - North Central',
            complaint_status: 'submitted',
            candidate_complaint_number: 'RU-2026-0060',
            candidate_title: 'Pothole',
            candidate_ward: 'Ward 1 - North Central',
            candidate_status: 'submitted',
          },
        ],
        total: 3,
        page: 1,
        page_size: 20,
        total_pages: 1,
      })
      .mockResolvedValueOnce({
        feature_enabled: true,
        items: [],
        total: 0,
        page: 1,
        page_size: 20,
        total_pages: 1,
      });

    render(
      <MemoryRouter>
        <AdminDuplicatesPage api={{ fetchDuplicates }} />
      </MemoryRouter>
    );

    expect(await screen.findByText('RU-2026-0071')).toBeTruthy();
    expect(screen.getAllByText('RU-2026-0071')).toHaveLength(1);
    expect(screen.getAllByText('Nashik Potholes')).toHaveLength(1);
    expect(screen.getByText('2 linked candidates')).toBeTruthy();
    expect(screen.getByText('RU-2026-0064')).toBeTruthy();
    expect(screen.getByText('RU-2026-0063')).toBeTruthy();
    expect(screen.getByText('RU-2026-0069')).toBeTruthy();
    expect(screen.getByText('1 linked candidate')).toBeTruthy();
    expect(screen.getByText(/Showing 3 of 3 duplicate links across 2 complaints/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Link Status/i), {
      target: { value: 'confirmed_duplicate' },
    });

    expect(
      await screen.findByText(/Showing 0 of 0 duplicate links across 0 complaints/i)
    ).toBeTruthy();
  });

  it('triggers both duplicate-check and ai-suggestions POST calls after successful complaint insert and network recovery', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 202,
    });

    const fakeSupabase = {
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: { session: { user: { id: CITIZEN_ID }, access_token: 'citizen-jwt-123' } },
          error: null,
        }),
      },
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: {
                id: COMPLAINT_ID,
                complaint_number: 'RU-2026-0102',
                status: 'submitted',
                title: 'Water leakage on lane 2',
                category: 'water_leakage',
              },
              error: null,
            }),
          }),
        }),
      }),
    };

    const result = await createComplaint({
      title: 'Water leakage on lane 2',
      category: 'water_leakage',
      ward: 'Ward 4',
      location: 'Lane 2 Corner',
      description: 'Clean water leaking continuously near lane 2 valve.',
      uploadedStoragePath: `${CITIZEN_ID}/${IDEMPOTENCY_KEY}.jpg`,
      idempotencyKey: IDEMPOTENCY_KEY,
      supabaseClient: fakeSupabase,
    });

    expect(result.error).toBeNull();
    expect(result.data?.id).toBe(COMPLAINT_ID);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const calledUrls = fetchSpy.mock.calls.map(([url]) => url);
    expect(calledUrls).toContain(`http://localhost:8000/api/citizen/complaints/${COMPLAINT_ID}/ai-suggestions`);
    expect(calledUrls).toContain(`http://localhost:8000/api/citizen/complaints/${COMPLAINT_ID}/duplicate-check`);
    for (const [, init] of fetchSpy.mock.calls) {
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer citizen-jwt-123');
      expect(init.keepalive).toBeUndefined();
    }
  });

  it('complaint creation stays unblocked and logs console.warn if duplicate-check or ai-suggestions fail', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network offline'));

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
                complaint_number: 'RU-2026-0102',
                status: 'submitted',
                title: 'Water leakage on lane 2',
                category: 'water_leakage',
              },
              error: null,
            }),
          }),
        }),
      }),
    };

    const result = await createComplaint({
      title: 'Water leakage on lane 2',
      category: 'water_leakage',
      ward: 'Ward 4',
      location: 'Lane 2 Corner',
      description: 'Clean water leaking continuously near lane 2 valve.',
      uploadedStoragePath: `${CITIZEN_ID}/${IDEMPOTENCY_KEY}.jpg`,
      idempotencyKey: IDEMPOTENCY_KEY,
      supabaseClient: fakeSupabase,
    });

    expect(result.error).toBeNull();
    expect(result.data?.id).toBe(COMPLAINT_ID);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalled();
  });
});
