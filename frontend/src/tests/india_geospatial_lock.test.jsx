import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import {
  INDIA_COUNTRY_CODE,
  INDIA_GEO_BBOX_ARRAY,
  INDIA_GEO_BOUNDS,
  INDIA_MAP_MAX_BOUNDS,
  INDIA_MAP_MIN_ZOOM,
  INDIA_OUTSIDE_ERROR,
  isIndiaBoundsDbError,
  isOutsideIndiaGeocodeContext,
  isWithinIndiaBounds,
} from '../utils/indiaGeoBounds';
import {
  isValidPublicMapCoordinate,
  sanitizeAndValidateMapPoints,
} from '../utils/publicMapUtils';
import {
  createComplaint,
  validateComplaintInput,
} from '../services/complaintService';
import * as mapboxService from '../services/mapboxService';
import LocationPickerMap from '../components/maps/LocationPickerMap';
import PublicComplaintsMap from '../components/maps/PublicComplaintsMap';

const { mockMapCalls, mockMapInstances } = vi.hoisted(() => ({
  mockMapCalls: [],
  mockMapInstances: [],
}));

vi.mock('mapbox-gl', () => {
  class MockLngLatBounds {
    extend() {
      return this;
    }
  }

  class MockMarker {
    setLngLat() {
      return this;
    }
    addTo() {
      return this;
    }
    on() {
      return this;
    }
    remove() {}
  }

  class MockNavigationControl {}

  class MockMap {
    constructor(options) {
      mockMapCalls.push(options);
      this.options = options;
      this.handlers = {};
      mockMapInstances.push(this);
    }
    addControl() {}
    on(event, fn) {
      this.handlers[event] = fn;
      if (event === 'load') {
        fn();
      }
    }
    off(event, fn) {
      if (this.handlers[event] === fn) {
        delete this.handlers[event];
      }
    }
    getZoom() {
      return 12;
    }
    easeTo = vi.fn();
    flyTo = vi.fn();
    remove = vi.fn();
    resize = vi.fn();
    isStyleLoaded = () => true;
    getSource = () => null;
    addSource = vi.fn();
    addLayer = vi.fn();
    getCanvas = () => ({ style: {} });
    triggerClick(lng, lat) {
      return this.handlers.click?.({ lngLat: { lng, lat } });
    }
  }

  return {
    default: {
      accessToken: '',
      Map: MockMap,
      Marker: MockMarker,
      NavigationControl: MockNavigationControl,
      LngLatBounds: MockLngLatBounds,
    },
  };
});

describe('India Geospatial Bounds Lock', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockMapCalls.length = 0;
    mockMapInstances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('indiaGeoBounds utilities', () => {
    it('accepts major Indian cities and exact bounding-box corners', () => {
      expect(isWithinIndiaBounds(12.9716, 77.5946)).toBe(true); // Bengaluru
      expect(isWithinIndiaBounds(28.6139, 77.209)).toBe(true); // New Delhi
      expect(isWithinIndiaBounds(19.076, 72.8777)).toBe(true); // Mumbai
      expect(isWithinIndiaBounds(INDIA_GEO_BOUNDS.minLat, INDIA_GEO_BOUNDS.minLng)).toBe(true);
      expect(isWithinIndiaBounds(INDIA_GEO_BOUNDS.maxLat, INDIA_GEO_BOUNDS.maxLng)).toBe(true);
    });

    it('rejects coordinates outside India and invalid coordinate types', () => {
      expect(isWithinIndiaBounds(51.5074, -0.1278)).toBe(false); // London
      expect(isWithinIndiaBounds(40.7128, -74.006)).toBe(false); // New York
      expect(isWithinIndiaBounds(35.6762, 139.6503)).toBe(false); // Tokyo
      expect(isWithinIndiaBounds(5.999, 77.5)).toBe(false);
      expect(isWithinIndiaBounds(37.601, 77.5)).toBe(false);
      expect(isWithinIndiaBounds(12.9, 67.999)).toBe(false);
      expect(isWithinIndiaBounds(12.9, 97.601)).toBe(false);
      expect(isWithinIndiaBounds(null, null)).toBe(false);
      expect(isWithinIndiaBounds('12.97', '77.59')).toBe(false);
      expect(isWithinIndiaBounds(NaN, 77.59)).toBe(false);
    });

    it('detects explicit non-in Mapbox country context while allowing missing country metadata', () => {
      expect(
        isOutsideIndiaGeocodeContext([{ id: 'country.456', short_code: 'pk', text: 'Pakistan' }])
      ).toBe(true);
      expect(
        isOutsideIndiaGeocodeContext([{ id: 'country.789', short_code: 'bd', text: 'Bangladesh' }])
      ).toBe(true);
      expect(
        isOutsideIndiaGeocodeContext([{ id: 'country.123', short_code: 'IN', text: 'India' }])
      ).toBe(false);
      expect(isOutsideIndiaGeocodeContext([])).toBe(false);
      expect(isOutsideIndiaGeocodeContext(undefined)).toBe(false);
      expect(
        isOutsideIndiaGeocodeContext([{ id: 'region.11', short_code: 'KA', text: 'Karnataka' }])
      ).toBe(false);
    });

    it('recognizes PostgreSQL INDIA_BOUNDS_VIOLATION error markers', () => {
      expect(
        isIndiaBoundsDbError({
          code: '22023',
          message: 'INDIA_BOUNDS_VIOLATION: Coordinates must lie within India',
        })
      ).toBe(true);
      expect(isIndiaBoundsDbError({ code: '23505', message: 'duplicate key' })).toBe(false);
    });
  });

  describe('/map legacy out-of-India filtering (Decision 2)', () => {
    it('filters non-India legacy coordinates from public map display without failing', () => {
      expect(isValidPublicMapCoordinate(12.9716, 77.5946)).toBe(true);
      expect(isValidPublicMapCoordinate(51.5074, -0.1278)).toBe(false);

      const points = sanitizeAndValidateMapPoints([
        {
          public_reference: 'CMP-1001',
          title: 'Bengaluru pothole',
          category: 'potholes',
          status: 'submitted',
          ward: 'Ward 1 - Indiranagar',
          latitude: 12.9716,
          longitude: 77.5946,
          submitted_date: '2026-11-20',
        },
        {
          public_reference: 'CMP-1002',
          title: 'Legacy non-India test row',
          category: 'potholes',
          status: 'submitted',
          ward: 'Ward 1 - Indiranagar',
          latitude: 51.5074,
          longitude: -0.1278,
          submitted_date: '2026-11-20',
        },
      ]);

      expect(points).toHaveLength(1);
      expect(points[0].public_reference).toBe('CMP-1001');
    });
  });

  describe('complaintService validation & DB error mapping', () => {
    const baseInput = {
      title: 'Deep road crater near junction',
      category: 'potholes',
      ward: 'Ward 4 - Koramangala',
      location: '80 Feet Road near signal',
      description: 'Severe pothole affecting morning commuters for three days.',
      uploadedStoragePath:
        '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.jpg',
    };

    it('allows both-null or India coordinates and rejects out-of-India or solitary coordinates', () => {
      expect(validateComplaintInput(baseInput).valid).toBe(true);
      expect(
        validateComplaintInput({ ...baseInput, latitude: 12.9716, longitude: 77.5946 }).valid
      ).toBe(true);

      const nonIndiaResult = validateComplaintInput({
        ...baseInput,
        latitude: 40.7128,
        longitude: -74.006,
      });
      expect(nonIndiaResult.valid).toBe(false);
      expect(nonIndiaResult.error).toBe(INDIA_OUTSIDE_ERROR);

      const solitaryResult = validateComplaintInput({
        ...baseInput,
        latitude: 12.9716,
        longitude: null,
      });
      expect(solitaryResult.valid).toBe(false);
    });

    it('maps PostgreSQL INDIA_BOUNDS_VIOLATION error to the shared friendly message', async () => {
      const mockSupabase = {
        auth: {
          getSession: vi.fn().mockResolvedValue({
            data: {
              session: {
                user: { id: '11111111-1111-4111-8111-111111111111' },
                access_token: 'tok',
              },
            },
            error: null,
          }),
        },
        from: vi.fn().mockReturnValue({
          insert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: null,
                error: {
                  code: '22023',
                  message: 'INDIA_BOUNDS_VIOLATION: Coordinates must lie within India',
                },
              }),
            }),
          }),
        }),
      };

      const res = await createComplaint({
        ...baseInput,
        latitude: 12.9716,
        longitude: 77.5946,
        idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        supabaseClient: mockSupabase,
      });

      expect(res.data).toBeNull();
      expect(res.error?.message).toBe(INDIA_OUTSIDE_ERROR);
    });
  });

  describe('Map initialization bounds, geocoder lock, and border-location rejection', () => {
    it('configures LocationPickerMap and PublicComplaintsMap with India maxBounds, minZoom > 3.5, and renderWorldCopies: false', () => {
      expect(INDIA_MAP_MIN_ZOOM).toBeGreaterThan(3.5);

      vi.spyOn(mapboxService, 'isMapboxTokenConfigured').mockReturnValue(true);

      render(<LocationPickerMap onLocationSelect={vi.fn()} />);
      expect(mockMapCalls[0]).toMatchObject({
        maxBounds: INDIA_MAP_MAX_BOUNDS,
        minZoom: INDIA_MAP_MIN_ZOOM,
        renderWorldCopies: false,
      });

      render(
        <PublicComplaintsMap
          points={[]}
          mapboxToken="pk.test_mapbox_public_token_india_bounds_123456"
        />
      );
      expect(mockMapCalls[1]).toMatchObject({
        maxBounds: INDIA_MAP_MAX_BOUNDS,
        minZoom: INDIA_MAP_MIN_ZOOM,
        renderWorldCopies: false,
      });
    });

    it('passes country=in and India bbox to searchAddress when searching in LocationPickerMap', async () => {
      vi.spyOn(mapboxService, 'isMapboxTokenConfigured').mockReturnValue(true);
      const searchSpy = vi.spyOn(mapboxService, 'searchAddress').mockResolvedValue({
        data: [],
        error: null,
      });

      render(<LocationPickerMap onLocationSelect={vi.fn()} />);

      const input = screen.getByPlaceholderText(/Search road, landmark, or area/i);
      fireEvent.change(input, { target: { value: 'MG Road Bengaluru' } });

      await waitFor(
        () => {
          expect(searchSpy).toHaveBeenCalledWith(
            'MG Road Bengaluru',
            expect.anything(),
            expect.objectContaining({
              country: INDIA_COUNTRY_CODE,
              bbox: INDIA_GEO_BBOX_ARRAY,
            })
          );
        },
        { timeout: 1500 }
      );
    });

    it('accepts an Indian location click when Mapbox reports country in', async () => {
      vi.spyOn(mapboxService, 'isMapboxTokenConfigured').mockReturnValue(true);
      vi.spyOn(mapboxService, 'reverseGeocode').mockResolvedValue({
        data: {
          placeName: 'MG Road, Bengaluru, Karnataka, India',
          streetAddress: 'MG Road',
          context: [{ id: 'country.1', short_code: 'in', text: 'India' }],
        },
        error: null,
      });

      const onLocationSelect = vi.fn();
      render(<LocationPickerMap onLocationSelect={onLocationSelect} />);

      await act(async () => {
        await mockMapInstances[0].triggerClick(77.5946, 12.9716);
      });

      expect(onLocationSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          latitude: 12.9716,
          longitude: 77.5946,
          address: 'MG Road',
        })
      );
      expect(screen.queryByText(INDIA_OUTSIDE_ERROR)).toBeNull();
    });

    it('rejects a coordinate outside the India bounding box without reverse-geocoding', async () => {
      vi.spyOn(mapboxService, 'isMapboxTokenConfigured').mockReturnValue(true);
      const reverseSpy = vi.spyOn(mapboxService, 'reverseGeocode');
      const onLocationSelect = vi.fn();

      render(<LocationPickerMap onLocationSelect={onLocationSelect} />);

      await act(async () => {
        await mockMapInstances[0].triggerClick(-0.1278, 51.5074); // London
      });

      expect(reverseSpy).not.toHaveBeenCalled();
      expect(screen.getByText(INDIA_OUTSIDE_ERROR)).toBeTruthy();
      expect(onLocationSelect).toHaveBeenCalledWith({
        latitude: null,
        longitude: null,
        address: '',
        placeName: '',
      });
    });

    it('rejects a border location inside the India bounding box when mocked Mapbox returns a non-in country code (Amendment D)', async () => {
      vi.spyOn(mapboxService, 'isMapboxTokenConfigured').mockReturnValue(true);
      // Lahore (31.5204, 74.3587) lies numerically inside 6.0..37.6 x 68.0..97.6
      const reverseSpy = vi.spyOn(mapboxService, 'reverseGeocode').mockResolvedValue({
        data: {
          placeName: 'Mall Road, Lahore, Punjab, Pakistan',
          streetAddress: 'Mall Road',
          context: [{ id: 'country.456', short_code: 'pk', text: 'Pakistan' }],
        },
        error: null,
      });

      const onLocationSelect = vi.fn();
      render(<LocationPickerMap onLocationSelect={onLocationSelect} />);

      await act(async () => {
        await mockMapInstances[0].triggerClick(74.3587, 31.5204);
      });

      expect(reverseSpy).toHaveBeenCalledWith(74.3587, 31.5204);
      expect(screen.getByText(INDIA_OUTSIDE_ERROR)).toBeTruthy();
      expect(onLocationSelect).not.toHaveBeenCalledWith(
        expect.objectContaining({
          latitude: 31.5204,
          longitude: 74.3587,
        })
      );
      expect(onLocationSelect).toHaveBeenCalledWith({
        latitude: null,
        longitude: null,
        address: '',
        placeName: '',
      });
    });

    it('allows an inside-box point when Mapbox country context is missing (Decision 3 fallback)', async () => {
      vi.spyOn(mapboxService, 'isMapboxTokenConfigured').mockReturnValue(true);
      vi.spyOn(mapboxService, 'reverseGeocode').mockResolvedValue({
        data: {
          placeName: 'Location at 28.61390, 77.20900',
          streetAddress: 'Near coordinates (28.61390, 77.20900)',
          context: [],
        },
        error: null,
      });

      const onLocationSelect = vi.fn();
      render(<LocationPickerMap onLocationSelect={onLocationSelect} />);

      await act(async () => {
        await mockMapInstances[0].triggerClick(77.209, 28.6139);
      });

      expect(onLocationSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          latitude: 28.6139,
          longitude: 77.209,
        })
      );
      expect(screen.queryByText(INDIA_OUTSIDE_ERROR)).toBeNull();
    });

    it('rejects out-of-India browser GPS coordinates cleanly', async () => {
      vi.spyOn(mapboxService, 'isMapboxTokenConfigured').mockReturnValue(true);
      const origGeo = navigator.geolocation;
      Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: {
          getCurrentPosition: (success) =>
            success({ coords: { latitude: 35.6762, longitude: 139.6503, accuracy: 25 } }),
        },
      });

      try {
        const onLocationSelect = vi.fn();
        render(<LocationPickerMap onLocationSelect={onLocationSelect} />);
        fireEvent.click(screen.getByRole('button', { name: /Detect Current GPS/i }));

        await waitFor(() => {
          expect(screen.getByText(INDIA_OUTSIDE_ERROR)).toBeTruthy();
        });
        expect(onLocationSelect).toHaveBeenCalledWith({
          latitude: null,
          longitude: null,
          address: '',
          placeName: '',
        });
      } finally {
        Object.defineProperty(navigator, 'geolocation', {
          configurable: true,
          value: origGeo,
        });
      }
    });
  });
});
