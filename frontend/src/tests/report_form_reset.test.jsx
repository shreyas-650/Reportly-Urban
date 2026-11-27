import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Navbar from '../components/common/Navbar';
import ReportIssuePage from '../pages/ReportIssuePage';
import ProtectedRoute from '../components/common/ProtectedRoute';
import * as authCtx from '../context/AuthContext';
import * as complaintSvc from '../services/complaintService';

vi.mock('../components/common/NotificationBell', () => ({
  default: () => <div data-testid="notification-bell" />,
}));

vi.mock('../components/maps/LocationPickerMap', () => ({
  default: ({ coordinates, onLocationSelect }) => (
    <div data-testid="mock-location-map" data-has-coords={Boolean(coordinates)}>
      <button
        type="button"
        onClick={() =>
          onLocationSelect({
            latitude: 12.9716,
            longitude: 77.5946,
            address: 'MG Road Junction',
          })
        }
      >
        Pick Mock Location
      </button>
    </div>
  ),
}));

async function fillAndSubmitValidForm(container, titleText) {
  fireEvent.change(screen.getByPlaceholderText(/Deep pothole causing skidding/i), {
    target: { value: titleText },
  });

  const selects = container.querySelectorAll('select');
  fireEvent.change(selects[0], { target: { value: 'potholes' } });
  const firstWardOption = selects[1].querySelectorAll('option')[1]?.value || '';
  fireEvent.change(selects[1], { target: { value: firstWardOption } });

  fireEvent.change(screen.getByPlaceholderText(/4th Cross Road/i), {
    target: { value: '4th Cross Road Near Bus Stand' },
  });
  fireEvent.change(screen.getByPlaceholderText(/Describe the severity/i), {
    target: {
      value: 'Large deep pothole obstructing two-wheeler traffic since three days.',
    },
  });

  const fileInput = container.querySelector('input[type="file"]');
  const file = new File(['fake-image-bytes'], 'pothole.jpg', { type: 'image/jpeg' });
  fireEvent.change(fileInput, { target: { files: [file] } });

  await waitFor(() => {
    expect(screen.getByAltText('Selected preview')).toBeTruthy();
  });

  fireEvent.click(screen.getByRole('button', { name: /Submit Grievance Report/i }));

  await waitFor(() => {
    expect(screen.getByText(/Complaint Registered Successfully/i)).toBeTruthy();
  });
}

describe('Report Issue Reset Flow & Fresh Idempotency Keys', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
    vi.spyOn(authCtx, 'useAuth').mockReturnValue({
      isAuthenticated: true,
      loading: false,
      profileLoading: false,
      role: 'citizen',
      isOfficer: false,
      isAdmin: false,
      isCitizen: true,
      user: { id: 'cit-uuid-1', email: 'asha@example.com' },
      citizenInfo: {
        fullName: 'Asha Citizen',
        email: 'asha@example.com',
        ward: 'Ward 4 - Koramangala',
      },
      signOut: vi.fn(),
    });
  });

  it('clicking Navbar Report an Issue after submit resets success state to a fresh empty form with a new idempotencyKey', async () => {
    const seenKeys = [];
    vi.spyOn(complaintSvc, 'createComplaint').mockImplementation(async (args) => {
      seenKeys.push(args.idempotencyKey);
      return {
        data: {
          id: `cmp-${seenKeys.length}`,
          complaint_number: `URB-2026-000${seenKeys.length}`,
          status: 'submitted',
          category: args.category,
          ward: args.ward,
          created_at: '2026-11-27T10:00:00Z',
        },
        error: null,
        orphanedStoragePath: null,
        isUnresolved: false,
      };
    });

    const { container } = render(
      <MemoryRouter initialEntries={['/report']}>
        <Navbar />
        <Routes>
          <Route
            path="/report"
            element={
              <ProtectedRoute allowedRoles={['citizen']} strictRoleMatch={true}>
                <ReportIssuePage />
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>
    );

    await fillAndSubmitValidForm(container, 'First Pothole Report Title');
    expect(screen.getAllByText('URB-2026-0001').length).toBeGreaterThanOrEqual(1);
    expect(seenKeys).toHaveLength(1);

    // Click Navbar Report an Issue while already on /report
    fireEvent.click(screen.getByRole('link', { name: /Report an Issue/i }));

    await waitFor(() => {
      expect(screen.queryByText(/Complaint Registered Successfully/i)).toBeNull();
    });

    const titleInput = screen.getByPlaceholderText(/Deep pothole causing skidding/i);
    expect(titleInput.value).toBe('');
    expect(screen.queryByAltText('Selected preview')).toBeNull();
    expect(screen.getByTestId('mock-location-map').getAttribute('data-has-coords')).toBe('false');

    // Submit a second report and confirm a new idempotency key is generated
    await fillAndSubmitValidForm(container, 'Second Water Leakage Report');
    expect(screen.getAllByText('URB-2026-0002').length).toBeGreaterThanOrEqual(1);
    expect(seenKeys).toHaveLength(2);
    expect(seenKeys[0]).not.toBe(seenKeys[1]);
  });

  it('"Report another issue" button on the success card resets the form and uses a new idempotencyKey on next submit', async () => {
    const seenKeys = [];
    vi.spyOn(complaintSvc, 'createComplaint').mockImplementation(async (args) => {
      seenKeys.push(args.idempotencyKey);
      return {
        data: {
          id: `cmp-${seenKeys.length}`,
          complaint_number: `URB-2026-100${seenKeys.length}`,
          status: 'submitted',
          category: args.category,
          ward: args.ward,
          created_at: '2026-11-27T10:00:00Z',
        },
        error: null,
        orphanedStoragePath: null,
        isUnresolved: false,
      };
    });

    const { container } = render(
      <MemoryRouter initialEntries={['/report']}>
        <Routes>
          <Route
            path="/report"
            element={
              <ProtectedRoute allowedRoles={['citizen']} strictRoleMatch={true}>
                <ReportIssuePage />
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>
    );

    await fillAndSubmitValidForm(container, 'First Success Card Test Title');

    fireEvent.click(screen.getByRole('button', { name: /Report another issue/i }));

    await waitFor(() => {
      expect(screen.queryByText(/Complaint Registered Successfully/i)).toBeNull();
    });
    expect(screen.getByPlaceholderText(/Deep pothole causing skidding/i).value).toBe('');

    await fillAndSubmitValidForm(container, 'Second Report After Success Button');
    expect(seenKeys).toHaveLength(2);
    expect(seenKeys[0]).not.toBe(seenKeys[1]);
  });
});
