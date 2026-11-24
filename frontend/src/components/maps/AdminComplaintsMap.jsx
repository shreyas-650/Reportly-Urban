import React, { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { Link } from 'react-router-dom';
import {
  MapPin,
  Layers,
  ExternalLink,
  AlertCircle,
  Filter,
} from 'lucide-react';
import {
  MAPBOX_PUBLIC_TOKEN,
  isMapboxTokenConfigured,
  isValidCoordinate,
} from '../../services/mapboxService';

// Status color tokens conforming to ReportlyUrban design system
const STATUS_COLORS = {
  submitted: '#dc2626',      // Red
  under_review: '#d97706',   // Amber
  in_progress: '#2563eb',    // Blue
  resolved: '#16a34a',       // Green
  rejected: '#64748b',       // Slate
};

const STATUS_LABELS = {
  submitted: 'Submitted',
  under_review: 'Under Review',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  rejected: 'Rejected',
};

export default function AdminComplaintsMap({ complaints = [] }) {
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const markersRef = useRef([]);

  const tokenConfigured = isMapboxTokenConfigured();
  const [selectedComplaint, setSelectedComplaint] = useState(null);

  // Filter complaints that possess valid coordinate pairs
  const geocodedComplaints = complaints.filter(
    (c) => c && isValidCoordinate(c.latitude, c.longitude)
  );

  const missingCoordsCount = complaints.length - geocodedComplaints.length;

  useEffect(() => {
    if (!tokenConfigured || !mapContainerRef.current) return;

    mapboxgl.accessToken = MAPBOX_PUBLIC_TOKEN;

    // Calculate bounds or center
    let initialCenter = [77.5946, 12.9716];
    let initialZoom = 11;

    if (geocodedComplaints.length > 0) {
      initialCenter = [Number(geocodedComplaints[0].longitude), Number(geocodedComplaints[0].latitude)];
      initialZoom = 12;
    }

    try {
      const map = new mapboxgl.Map({
        container: mapContainerRef.current,
        style: 'mapbox://styles/mapbox/streets-v12',
        center: initialCenter,
        zoom: initialZoom,
      });

      map.addControl(new mapboxgl.NavigationControl(), 'top-right');

      map.on('load', () => {
        // Fit bounds if multiple geocoded items exist
        if (geocodedComplaints.length > 1) {
          const bounds = new mapboxgl.LngLatBounds();
          geocodedComplaints.forEach((c) => {
            bounds.extend([Number(c.longitude), Number(c.latitude)]);
          });
          map.fitBounds(bounds, { padding: 50, maxZoom: 15 });
        }
      });

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
  }, [tokenConfigured]);

  // Synchronize Mapbox markers with geocoded complaints
  useEffect(() => {
    if (!mapInstanceRef.current) return;
    const map = mapInstanceRef.current;

    // Clear existing markers
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    geocodedComplaints.forEach((c) => {
      const color = STATUS_COLORS[c.status] || '#64748b';
      const statusLabel = STATUS_LABELS[c.status] || c.status;

      // Custom DOM marker
      const el = document.createElement('div');
      el.className = 'admin-map-pin';
      el.innerHTML = `
        <div style="
          width: 28px;
          height: 28px;
          background: ${color};
          border: 2px solid #ffffff;
          border-radius: 50% 50% 50% 0;
          transform: rotate(-45deg);
          box-shadow: 0 3px 8px rgba(0, 0, 0, 0.25);
          cursor: pointer;
          transition: transform 0.15s ease;
        ">
        </div>
      `;

      el.addEventListener('mouseenter', () => {
        el.firstElementChild.style.transform = 'rotate(-45deg) scale(1.15)';
      });

      el.addEventListener('mouseleave', () => {
        el.firstElementChild.style.transform = 'rotate(-45deg) scale(1)';
      });

      // Construct privacy-safe popup (Strictly no citizen PII or internal notes)
      const popupHtml = `
        <div style="font-family: 'Google Sans', sans-serif; padding: 4px; max-width: 240px;">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
            <span style="font-family: monospace; font-size: 11px; font-weight: 700; color: #1e293b; background: #f1f5f9; padding: 2px 6px; border-radius: 4px;">
              ${c.complaint_number || 'CIVIC'}
            </span>
            <span style="font-size: 10px; font-weight: 700; color: #ffffff; background: ${color}; padding: 2px 6px; border-radius: 4px; text-transform: uppercase;">
              ${statusLabel}
            </span>
          </div>
          <div style="font-size: 12px; font-weight: 700; color: #0f172a; margin-bottom: 4px; line-height: 1.3;">
            ${(c.title || 'Untitled Grievance').replace(/</g, '&lt;')}
          </div>
          <div style="font-size: 11px; color: #64748b; margin-bottom: 2px;">
            <strong>Ward:</strong> ${(c.ward || 'General').replace(/</g, '&lt;')}
          </div>
          <div style="font-size: 11px; color: #64748b; margin-bottom: 8px;">
            <strong>Category:</strong> ${(c.category || 'General').replace(/_/g, ' ')}
          </div>
          <a href="/admin/complaints/${c.id}" style="
            display: inline-block;
            width: 100%;
            text-align: center;
            padding: 6px 10px;
            background: #2563eb;
            color: #ffffff;
            font-size: 11px;
            font-weight: 600;
            border-radius: 6px;
            text-decoration: none;
          ">
            View Complaint Dossier →
          </a>
        </div>
      `;

      const popup = new mapboxgl.Popup({ offset: 25, closeButton: false }).setHTML(popupHtml);

      const marker = new mapboxgl.Marker({ element: el })
        .setLngLat([Number(c.longitude), Number(c.latitude)])
        .setPopup(popup)
        .addTo(map);

      markersRef.current.push(marker);
    });
  }, [geocodedComplaints]);

  if (!tokenConfigured) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center space-y-3">
        <AlertCircle className="w-8 h-8 text-amber-500 mx-auto" />
        <h3 className="text-sm font-bold text-slate-800">Geospatial Map Unavailable</h3>
        <p className="text-xs text-slate-500 max-w-md mx-auto">
          Mapbox access token is not configured in the application environment. Please switch to Table View to manage complaints.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden space-y-0">
      {/* Informational Header & Status Legend */}
      <div className="p-4 bg-slate-50/80 border-b border-slate-200/80 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-blue-600" />
          <span className="font-bold text-slate-900">Geospatial Distribution</span>
          <span className="px-2 py-0.5 bg-blue-100/70 text-blue-800 rounded-full font-semibold text-[11px]">
            {geocodedComplaints.length} Mapped
          </span>
          {missingCoordsCount > 0 && (
            <span className="text-[11px] text-slate-400">
              ({missingCoordsCount} address-only)
            </span>
          )}
        </div>

        {/* Status Color Legend */}
        <div className="flex flex-wrap items-center gap-3 text-[11px] font-semibold text-slate-600">
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full bg-red-600" /> Submitted
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-600" /> Under Review
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full bg-blue-600" /> In Progress
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-600" /> Resolved
          </span>
        </div>
      </div>

      {/* Map Canvas */}
      <div
        ref={mapContainerRef}
        className="w-full h-96 sm:h-[480px] bg-slate-100"
        style={{ minHeight: '380px' }}
      />
    </div>
  );
}
