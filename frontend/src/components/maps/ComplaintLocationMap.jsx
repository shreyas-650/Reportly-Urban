import React, { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import {
  MapPin,
  ExternalLink,
  Copy,
  Check,
  Navigation,
  Compass,
} from 'lucide-react';
import {
  MAPBOX_PUBLIC_TOKEN,
  isMapboxTokenConfigured,
  isValidCoordinate,
  generateGoogleMapsDirectionsUrl,
  generateAppleMapsDirectionsUrl,
  formatCoordinatesText,
} from '../../services/mapboxService';

export default function ComplaintLocationMap({
  latitude,
  longitude,
  locationName = '',
  ward = '',
  complaintNumber = '',
  showDirections = true,
  heightClass = 'h-56 sm:h-64',
}) {
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const [copied, setCopied] = useState(false);

  const hasValidCoords = isValidCoordinate(latitude, longitude);
  const tokenConfigured = isMapboxTokenConfigured();

  useEffect(() => {
    if (!hasValidCoords || !tokenConfigured || !mapContainerRef.current) return;

    mapboxgl.accessToken = MAPBOX_PUBLIC_TOKEN;

    const center = [Number(longitude), Number(latitude)];

    try {
      const map = new mapboxgl.Map({
        container: mapContainerRef.current,
        style: 'mapbox://styles/mapbox/streets-v12',
        center,
        zoom: 15,
        attributionControl: false,
      });

      map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');

      // Create Custom Styled Pin
      const el = document.createElement('div');
      el.className = 'civic-view-marker';
      el.innerHTML = `
        <div style="
          width: 32px;
          height: 32px;
          background: #dc2626;
          border: 3px solid #ffffff;
          border-radius: 50% 50% 50% 0;
          transform: rotate(-45deg);
          box-shadow: 0 4px 10px rgba(0, 0, 0, 0.3);
          display: flex;
          align-items: center;
          justify-content: center;
        ">
          <div style="width: 10px; height: 10px; background: #ffffff; border-radius: 50%;"></div>
        </div>
      `;

      new mapboxgl.Marker({ element: el })
        .setLngLat(center)
        .addTo(map);

      mapInstanceRef.current = map;

      return () => {
        if (mapInstanceRef.current) {
          mapInstanceRef.current.remove();
          mapInstanceRef.current = null;
        }
      };
    } catch {
      // Graceful fallback
    }
  }, [latitude, longitude, hasValidCoords, tokenConfigured]);

  const handleCopyCoords = () => {
    if (!hasValidCoords) return;
    const text = formatCoordinatesText(latitude, longitude);
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Fallback for complaints without coordinates
  if (!hasValidCoords) {
    return (
      <div className="p-4 bg-slate-50 rounded-xl border border-slate-200/80 text-xs space-y-2">
        <div className="flex items-center gap-1.5 font-bold text-slate-800">
          <MapPin className="w-4 h-4 text-slate-500" />
          <span>Location Information</span>
        </div>
        <div className="text-slate-700 font-semibold">{locationName || 'Location not specified'}</div>
        {ward && <div className="text-slate-500">Ward: {ward}</div>}
        <p className="text-[11px] text-slate-400 italic pt-1 border-t border-slate-200/60">
          No GPS coordinates recorded for this submission.
        </p>
      </div>
    );
  }

  const googleMapsUrl = generateGoogleMapsDirectionsUrl(latitude, longitude, locationName);
  const appleMapsUrl = generateAppleMapsDirectionsUrl(latitude, longitude, locationName);

  return (
    <div className="rounded-2xl border border-slate-200 overflow-hidden bg-white shadow-2xs space-y-0">
      {/* Mapbox Canvas */}
      {tokenConfigured ? (
        <div ref={mapContainerRef} className={`w-full ${heightClass} bg-slate-100`} />
      ) : (
        <div className="p-6 bg-slate-50 text-center text-xs text-slate-500">
          Map preview unavailable (Mapbox token not set).
        </div>
      )}

      {/* Location Details & Actions Panel */}
      <div className="p-4 space-y-3 bg-white border-t border-slate-100">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1 text-xs">
            <div className="font-bold text-slate-900 flex items-center gap-1.5">
              <MapPin className="w-4 h-4 text-rose-600 shrink-0" />
              <span>{locationName || 'Incident Site'}</span>
            </div>
            {ward && <div className="text-slate-500">Municipal Jurisdiction: {ward}</div>}
            <div className="font-mono text-[11px] text-slate-400">
              Coordinates: {Number(latitude).toFixed(6)}, {Number(longitude).toFixed(6)}
            </div>
          </div>

          {/* Copy Coordinates Button */}
          <button
            type="button"
            onClick={handleCopyCoords}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-slate-50 hover:bg-slate-100 text-slate-600 text-[11px] font-semibold rounded-lg border border-slate-200 transition-colors shrink-0"
            title="Copy coordinates to clipboard"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-600" />
                <span className="text-emerald-700">Copied</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5 text-slate-400" />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>

        {/* Navigation Actions for Field Officers & Citizens */}
        {showDirections && (
          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100 text-xs">
            <a
              href={googleMapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 font-semibold rounded-lg transition-colors border border-blue-200/80 text-[11px]"
            >
              <Navigation className="w-3.5 h-3.5 text-blue-600" />
              <span>Navigate in Google Maps</span>
              <ExternalLink className="w-3 h-3 opacity-60" />
            </a>

            <a
              href={appleMapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 hover:bg-slate-100 text-slate-700 font-semibold rounded-lg transition-colors border border-slate-200 text-[11px]"
            >
              <Compass className="w-3.5 h-3.5 text-slate-500" />
              <span>Apple Maps</span>
              <ExternalLink className="w-3 h-3 opacity-60" />
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
