import React, { useEffect, useRef, useState, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import {
  MapPin,
  Crosshair,
  Search,
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  X,
  Navigation,
} from 'lucide-react';
import {
  MAPBOX_PUBLIC_TOKEN,
  isMapboxTokenConfigured,
  isValidCoordinate,
  searchAddress,
  reverseGeocode,
  formatCoordinatesText,
} from '../../services/mapboxService';
import {
  INDIA_COUNTRY_CODE,
  INDIA_GEO_BBOX_ARRAY,
  INDIA_MAP_MAX_BOUNDS,
  INDIA_MAP_MIN_ZOOM,
  INDIA_OUTSIDE_ERROR,
  isOutsideIndiaGeocodeContext,
  isWithinIndiaBounds,
} from '../../utils/indiaGeoBounds';

// Default center: Bengaluru municipal hub [lng, lat] (or general urban coordinate)
const DEFAULT_CENTER = [77.5946, 12.9716];
const DEFAULT_ZOOM = 12;

export default function LocationPickerMap({
  coordinates = null,
  onLocationSelect,
  initialAddress = '',
  disabled = false,
}) {
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const markerRef = useRef(null);
  const requestIdRef = useRef(0);

  const [tokenConfigured] = useState(() => isMapboxTokenConfigured());
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapError, setMapError] = useState(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // GPS state
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsError, setGpsError] = useState(null);
  const [gpsAccuracy, setGpsAccuracy] = useState(null);

  // Active pin state
  const [selectedCoords, setSelectedCoords] = useState(() => {
    if (
      coordinates &&
      isValidCoordinate(coordinates.latitude, coordinates.longitude) &&
      isWithinIndiaBounds(Number(coordinates.latitude), Number(coordinates.longitude))
    ) {
      return [Number(coordinates.longitude), Number(coordinates.latitude)];
    }
    return null;
  });

  const [resolvedAddress, setResolvedAddress] = useState(initialAddress || '');
  const [isReverseGeocoding, setIsReverseGeocoding] = useState(false);

  // ---------------------------------------------------------------------------
  // Initialize Mapbox Map Canvas
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!tokenConfigured || !mapContainerRef.current) return;

    mapboxgl.accessToken = MAPBOX_PUBLIC_TOKEN;

    try {
      const initialCenter = selectedCoords || DEFAULT_CENTER;
      const initialZoom = selectedCoords ? 15 : DEFAULT_ZOOM;

      const map = new mapboxgl.Map({
        container: mapContainerRef.current,
        style: 'mapbox://styles/mapbox/streets-v12',
        center: initialCenter,
        zoom: initialZoom,
        minZoom: INDIA_MAP_MIN_ZOOM,
        maxBounds: INDIA_MAP_MAX_BOUNDS,
        renderWorldCopies: false,
        attributionControl: true,
      });

      // Add navigation controls (zoom in/out)
      map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');

      map.on('load', () => {
        setMapLoaded(true);
      });

      map.on('error', (e) => {
        // Suppress non-fatal tile errors; report auth failures
        if (e?.error?.status === 401 || e?.error?.status === 403) {
          setMapError('Invalid Mapbox access token. Please check configuration.');
        }
      });

      mapInstanceRef.current = map;

      return () => {
        if (mapInstanceRef.current) {
          mapInstanceRef.current.remove();
          mapInstanceRef.current = null;
        }
      };
    } catch (err) {
      setMapError('Failed to initialize interactive map canvas.');
    }
  }, [tokenConfigured]);

  // ---------------------------------------------------------------------------
  // Handle Marker Creation & Drag Events
  // ---------------------------------------------------------------------------
  const rejectOutsideIndia = useCallback(() => {
    requestIdRef.current += 1;
    setIsReverseGeocoding(false);
    setSelectedCoords(null);
    setResolvedAddress('');
    setGpsAccuracy(null);
    setGpsError(INDIA_OUTSIDE_ERROR);

    if (typeof onLocationSelect === 'function') {
      onLocationSelect({
        latitude: null,
        longitude: null,
        address: '',
        placeName: '',
      });
    }
  }, [onLocationSelect]);

  const handleMarkerDragEnd = useCallback(
    async (lngLat) => {
      const lng = lngLat.lng;
      const lat = lngLat.lat;

      if (!isWithinIndiaBounds(lat, lng)) {
        rejectOutsideIndia();
        return false;
      }

      setGpsError(null);

      // Perform reverse geocoding with sequential request cancellation
      const reqId = ++requestIdRef.current;
      setIsReverseGeocoding(true);

      const { data } = await reverseGeocode(lng, lat);

      if (reqId !== requestIdRef.current) {
        return false;
      }

      setIsReverseGeocoding(false);

      if (isOutsideIndiaGeocodeContext(data?.context)) {
        rejectOutsideIndia();
        return false;
      }

      setSelectedCoords([lng, lat]);

      const newAddress = data?.streetAddress || data?.placeName || '';
      if (newAddress) {
        setResolvedAddress(newAddress);
      }

      if (typeof onLocationSelect === 'function') {
        onLocationSelect({
          latitude: Number(lat.toFixed(6)),
          longitude: Number(lng.toFixed(6)),
          address: newAddress,
          placeName: data?.placeName || '',
        });
      }

      return true;
    },
    [onLocationSelect, rejectOutsideIndia]
  );

  // Sync Marker with selectedCoords
  useEffect(() => {
    if (!mapLoaded || !mapInstanceRef.current) return;

    const map = mapInstanceRef.current;

    if (selectedCoords) {
      if (!markerRef.current) {
        // Create custom styled marker element
        const el = document.createElement('div');
        el.className = 'civic-map-marker';
        el.innerHTML = `
          <div style="
            width: 32px;
            height: 32px;
            background: #2563eb;
            border: 3px solid #ffffff;
            border-radius: 50% 50% 50% 0;
            transform: rotate(-45deg);
            box-shadow: 0 4px 10px rgba(0, 0, 0, 0.3);
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: grab;
          ">
            <div style="width: 10px; height: 10px; background: #ffffff; border-radius: 50%;"></div>
          </div>
        `;

        const marker = new mapboxgl.Marker({
          element: el,
          draggable: !disabled,
        })
          .setLngLat(selectedCoords)
          .addTo(map);

        marker.on('dragend', () => {
          const pos = marker.getLngLat();
          handleMarkerDragEnd(pos);
        });

        markerRef.current = marker;
      } else {
        markerRef.current.setLngLat(selectedCoords);
        markerRef.current.setDraggable(!disabled);
      }
    } else if (markerRef.current) {
      markerRef.current.remove();
      markerRef.current = null;
    }
  }, [selectedCoords, mapLoaded, disabled, handleMarkerDragEnd]);

  // Click on map to place or move marker
  useEffect(() => {
    if (!mapLoaded || !mapInstanceRef.current || disabled) return;

    const map = mapInstanceRef.current;

    const handleMapClick = async (e) => {
      const { lng, lat } = e.lngLat;
      const accepted = await handleMarkerDragEnd({ lng, lat });
      if (accepted) {
        map.easeTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 15) });
      }
    };

    map.on('click', handleMapClick);

    return () => {
      map.off('click', handleMapClick);
    };
  }, [mapLoaded, disabled, handleMarkerDragEnd]);

  // ---------------------------------------------------------------------------
  // GPS Detection Handler
  // ---------------------------------------------------------------------------
  const handleDetectGps = () => {
    if (disabled || gpsLoading) return;

    if (!navigator.geolocation) {
      setGpsError('Geolocation is not supported by your browser.');
      return;
    }

    setGpsLoading(true);
    setGpsError(null);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGpsLoading(false);
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;

        if (!isWithinIndiaBounds(lat, lng)) {
          rejectOutsideIndia();
          return;
        }

        setGpsAccuracy(Math.round(pos.coords.accuracy));

        handleMarkerDragEnd({ lng, lat }).then((accepted) => {
          if (accepted && mapInstanceRef.current) {
            mapInstanceRef.current.flyTo({
              center: [lng, lat],
              zoom: 16,
              essential: true,
            });
          }
        });
      },
      (err) => {
        setGpsLoading(false);
        let msg = 'Unable to retrieve your location.';
        if (err.code === err.PERMISSION_DENIED) {
          msg = 'GPS permission denied. Please search your address or click directly on the map to pin the problem location.';
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          msg = 'Location information is currently unavailable.';
        } else if (err.code === err.TIMEOUT) {
          msg = 'Location request timed out. Please try again or pin location manually.';
        }
        setGpsError(msg);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 30000,
      }
    );
  };

  // ---------------------------------------------------------------------------
  // Address Search Handler (Debounced)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!searchQuery.trim() || searchQuery.trim().length < 3) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearching(true);
      const proximity = selectedCoords || DEFAULT_CENTER;
      const { data, error } = await searchAddress(searchQuery, MAPBOX_PUBLIC_TOKEN, {
        proximity,
        country: INDIA_COUNTRY_CODE,
        bbox: INDIA_GEO_BBOX_ARRAY,
      });

      setIsSearching(false);
      if (!error && Array.isArray(data)) {
        setSearchResults(data);
        setShowSuggestions(data.length > 0);
      } else {
        setSearchResults([]);
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [searchQuery, selectedCoords]);

  const handleSelectSuggestion = (item) => {
    if (!item.coordinates) return;
    const [lng, lat] = item.coordinates;

    if (!isWithinIndiaBounds(lat, lng) || isOutsideIndiaGeocodeContext(item.context)) {
      setSearchQuery('');
      setShowSuggestions(false);
      rejectOutsideIndia();
      return;
    }

    setSelectedCoords([lng, lat]);
    setResolvedAddress(item.placeName);
    setSearchQuery('');
    setShowSuggestions(false);
    setGpsError(null);

    if (mapInstanceRef.current) {
      mapInstanceRef.current.flyTo({
        center: [lng, lat],
        zoom: 16,
        essential: true,
      });
    }

    if (typeof onLocationSelect === 'function') {
      onLocationSelect({
        latitude: Number(lat.toFixed(6)),
        longitude: Number(lng.toFixed(6)),
        address: item.text || item.placeName,
        placeName: item.placeName,
      });
    }
  };

  const handleClearPin = () => {
    setSelectedCoords(null);
    setResolvedAddress('');
    setGpsAccuracy(null);
    setGpsError(null);

    if (typeof onLocationSelect === 'function') {
      onLocationSelect({
        latitude: null,
        longitude: null,
        address: '',
        placeName: '',
      });
    }
  };

  // ---------------------------------------------------------------------------
  // Render: Graceful Fallback if Token is Not Configured
  // ---------------------------------------------------------------------------
  if (!tokenConfigured || mapError) {
    return (
      <div className="rounded-xl border border-amber-200/90 bg-amber-50/60 p-4 text-xs text-amber-900 space-y-2">
        <div className="flex items-center gap-2 font-bold text-amber-800">
          <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
          <span>Interactive Map Preview Unavailable</span>
        </div>
        <p className="text-slate-600 leading-relaxed">
          {mapError || 'Mapbox public token is not configured. You can still report issues using the manual street address and ward fields below.'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Search Bar & GPS Button Header */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 relative">
        {/* Address Search Input */}
        <div className="relative flex-1">
          <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
          <input
            type="text"
            disabled={disabled}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onFocus={() => {
              if (searchResults.length > 0) setShowSuggestions(true);
            }}
            placeholder="Search road, landmark, or area..."
            className="w-full pl-9 pr-8 py-2 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all placeholder:text-slate-400"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => {
                setSearchQuery('');
                setShowSuggestions(false);
              }}
              className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}

          {/* Autocomplete Suggestions Dropdown */}
          {showSuggestions && searchResults.length > 0 && (
            <div className="absolute z-20 left-0 right-0 top-full mt-1 bg-white border border-slate-200 rounded-xl shadow-lg max-h-56 overflow-y-auto divide-y divide-slate-100 text-xs">
              {searchResults.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => handleSelectSuggestion(item)}
                  className="w-full p-2.5 text-left hover:bg-blue-50/70 transition-colors flex items-start gap-2"
                >
                  <MapPin className="w-3.5 h-3.5 text-blue-600 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold text-slate-800">{item.text}</div>
                    <div className="text-[11px] text-slate-400 line-clamp-1">{item.placeName}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* GPS Button */}
        <button
          type="button"
          disabled={disabled || gpsLoading}
          onClick={handleDetectGps}
          className="inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-slate-100 hover:bg-slate-200/80 text-slate-700 text-xs font-semibold rounded-lg transition-colors border border-slate-200/80 disabled:opacity-60 disabled:cursor-not-allowed shrink-0"
        >
          {gpsLoading ? (
            <>
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-600" />
              <span>Detecting GPS...</span>
            </>
          ) : (
            <>
              <Crosshair className="w-3.5 h-3.5 text-blue-600" />
              <span>Detect Current GPS</span>
            </>
          )}
        </button>
      </div>

      {/* GPS Notice / Error Banner */}
      {gpsError && (
        <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-700 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
          <p className="leading-relaxed">{gpsError}</p>
        </div>
      )}

      {/* Mapbox Canvas Container */}
      <div className="relative rounded-xl border border-slate-200 overflow-hidden shadow-2xs">
        <div
          ref={mapContainerRef}
          className="w-full h-64 sm:h-72 bg-slate-100"
          style={{ minHeight: '256px' }}
        />

        {/* Floating Instruction Overlay */}
        {!selectedCoords && (
          <div className="absolute top-2 left-2 pointer-events-none bg-slate-900/80 backdrop-blur-xs text-white text-[11px] font-medium px-2.5 py-1.5 rounded-lg shadow-sm flex items-center gap-1.5">
            <Navigation className="w-3 h-3 text-blue-400" />
            <span>Click map or drag pin to position the issue</span>
          </div>
        )}

        {isReverseGeocoding && (
          <div className="absolute bottom-2 left-2 bg-white/90 backdrop-blur-xs text-slate-700 text-[11px] font-semibold px-2.5 py-1 rounded-md shadow-sm border border-slate-200 flex items-center gap-1.5">
            <RefreshCw className="w-3 h-3 text-blue-600 animate-spin" />
            <span>Resolving street address...</span>
          </div>
        )}
      </div>

      {/* Selected Position Confirmation Card */}
      {selectedCoords ? (
        <div className="p-3.5 bg-blue-50/70 border border-blue-200/80 rounded-xl text-xs space-y-1.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 font-bold text-blue-900">
              <CheckCircle2 className="w-4 h-4 text-blue-600" />
              <span>Active Problem Pin Confirmed</span>
            </div>
            {!disabled && (
              <button
                type="button"
                onClick={handleClearPin}
                className="text-[11px] font-semibold text-slate-500 hover:text-rose-600 transition-colors"
              >
                Clear Pin
              </button>
            )}
          </div>

          <div className="text-slate-700 font-medium">
            {resolvedAddress || 'Coordinates selected on map.'}
          </div>

          <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500 font-mono">
            <span>Lat: {selectedCoords[1].toFixed(6)}</span>
            <span>•</span>
            <span>Lng: {selectedCoords[0].toFixed(6)}</span>
            {gpsAccuracy && (
              <>
                <span>•</span>
                <span className="font-sans text-slate-400">Accuracy: ±{gpsAccuracy}m</span>
              </>
            )}
          </div>

          <p className="text-[11px] text-slate-500 italic pt-1 border-t border-blue-100">
            * Drag the marker on the map if the problem is situated further down the street.
          </p>
        </div>
      ) : (
        <p className="text-[11px] text-slate-400 italic">
          No GPS pin placed. You can still report your complaint by providing the street name below.
        </p>
      )}
    </div>
  );
}
