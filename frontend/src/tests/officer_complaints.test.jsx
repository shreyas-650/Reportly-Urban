import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import OfficerNotificationsPage from '../pages/officer/OfficerNotificationsPage';
import OfficerComplaintDetailsPage from '../pages/officer/OfficerComplaintDetailsPage';

const mockUseAuth = vi.fn();

vi.mock('../context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('../components/maps/ComplaintLocationMap', () => ({
  default: () => <div data-testid="complaint-location-map" />,
}));

describe('Officer Assigned Complaints List & Photo Display', () => {
  beforeEach(() => {
    mockUseAuth.mockReset();
    mockUseAuth.mockReturnValue({
      officerRecord: { id: 'off-1' },
    });
  });

  it('renders My Assigned Complaints above notifications with thumbnail, status filter, and detail link', async () => {
    const fetchComplaints = vi.fn().mockResolvedValue({
      items: [
        {
          id: 'c-10',
          complaint_reference: 'RU-2026-00110',
          title: 'Broken Streetlight',
          category: 'streetlights',
          ward: 'Ward 4',
          status: 'in_progress',
          priority: 'high',
          created_at: '2026-11-25T08:00:00Z',
          sla_deadline: '2026-11-27T08:00:00Z',
          thumbnail_url: 'https://signed.example/thumb.jpg',
        },
      ],
      page: 1,
      page_size: 20,
      total: 1,
      total_pages: 1,
    });

    const api = {
      fetchComplaints,
      fetchReminders: vi.fn().mockResolvedValue({ items: [] }),
      fetchEscalations: vi.fn().mockResolvedValue({ items: [] }),
      fetchNotifications: vi.fn().mockResolvedValue({ items: [], unread_count: 0 }),
      markRead: vi.fn(),
    };

    render(
      <MemoryRouter>
        <OfficerNotificationsPage api={api} />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('My Assigned Complaints')).toBeInTheDocument();
      expect(screen.getByText('RU-2026-00110')).toBeInTheDocument();
    });

    const thumb = screen.getByAltText('Thumbnail for RU-2026-00110');
    expect(thumb).toHaveAttribute('src', 'https://signed.example/thumb.jpg');

    const links = screen.getAllByRole('link');
    expect(links.some((l) => l.getAttribute('href') === '/officer/complaints/c-10')).toBe(true);

    fireEvent.change(screen.getByLabelText('Status:'), { target: { value: 'resolved' } });
    await waitFor(() => {
      expect(fetchComplaints).toHaveBeenLastCalledWith({
        status: 'resolved',
        page: 1,
        page_size: 20,
      });
    });
  });

  it('renders empty and error+retry states for My Assigned Complaints', async () => {
    const fetchComplaints = vi
      .fn()
      .mockRejectedValueOnce(new Error('Database unavailable'))
      .mockResolvedValueOnce({ items: [], page: 1, page_size: 20, total: 0, total_pages: 1 });

    const api = {
      fetchComplaints,
      fetchReminders: vi.fn().mockResolvedValue({ items: [] }),
      fetchEscalations: vi.fn().mockResolvedValue({ items: [] }),
      fetchNotifications: vi.fn().mockResolvedValue({ items: [], unread_count: 0 }),
      markRead: vi.fn(),
    };

    render(
      <MemoryRouter>
        <OfficerNotificationsPage api={api} />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Unable to load assigned complaints')).toBeInTheDocument();
      expect(screen.getByText('Database unavailable')).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole('button', { name: /Retry/i })[0]);

    await waitFor(() => {
      expect(screen.getByText('No assigned complaints found')).toBeInTheDocument();
    });
  });

  it('renders problem and completion photos on OfficerComplaintDetailsPage when signed URLs exist', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      id: 'c-10',
      complaint_reference: 'RU-2026-00110',
      title: 'Broken Streetlight',
      category: 'streetlights',
      description: 'Pole 4 is dark.',
      location: 'Market Road',
      ward: 'Ward 4',
      status: 'resolved',
      priority: 'high',
      assigned_officer_id: 'off-1',
      signed_image_url: 'https://signed.example/problem.jpg',
      signed_completion_url: 'https://signed.example/completion.jpg',
      timeline: [],
      escalations: [],
    });

    render(
      <MemoryRouter initialEntries={['/officer/complaints/c-10']}>
        <Routes>
          <Route
            path="/officer/complaints/:id"
            element={<OfficerComplaintDetailsPage fetcher={fetcher} />}
          />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByAltText('Problem Evidence')).toHaveAttribute(
        'src',
        'https://signed.example/problem.jpg'
      );
      expect(screen.getByAltText('Completion Evidence')).toHaveAttribute(
        'src',
        'https://signed.example/completion.jpg'
      );
    });
  });

  it('shows fallback when no problem photo is attached', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      id: 'c-11',
      complaint_reference: 'RU-2026-00111',
      title: 'Water leak',
      category: 'water_leakage',
      description: 'Pipe leaking.',
      location: '2nd Cross',
      ward: 'Ward 7',
      status: 'in_progress',
      priority: 'normal',
      assigned_officer_id: 'off-1',
      signed_image_url: null,
      signed_completion_url: null,
      timeline: [],
      escalations: [],
    });

    render(
      <MemoryRouter initialEntries={['/officer/complaints/c-11']}>
        <Routes>
          <Route
            path="/officer/complaints/:id"
            element={<OfficerComplaintDetailsPage fetcher={fetcher} />}
          />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('No problem photograph attached.')).toBeInTheDocument();
      expect(screen.queryByAltText('Completion Evidence')).not.toBeInTheDocument();
    });
  });
});
