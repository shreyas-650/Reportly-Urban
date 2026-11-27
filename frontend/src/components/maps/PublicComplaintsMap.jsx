import React, { useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import Button from '../common/Button';
import { MAPBOX_PUBLIC_TOKEN } from '../../services/mapboxService';
import {
  PUBLIC_MAP_DEFAULT_CENTER,
  PUBLIC_MAP_MAX_ZOOM,
  PUBLIC_MAP_STATUS_META,
  buildMapGeoJson,
  buildPopupDomElement,
  buildPopupModel,
  groupPointsAtLocation,
  validatePublicMapboxToken,
} from '../../utils/publicMapUtils';
import {
  INDIA_MAP_MAX_BOUNDS,
  INDIA_MAP_MIN_ZOOM,
} from '../../utils/indiaGeoBounds';

const SOURCE_ID = 'public-complaints-source';
const CLUSTER_LAYER_ID = 'public-complaints-clusters';
const CLUSTER_COUNT_LAYER_ID = 'public-complaints-cluster-count';
const POINT_LAYER_ID = 'public-complaints-unclustered';
const POINT_SYMBOL_LAYER_ID = 'public-complaints-status-symbol';

const ALL_LAYER_IDS = [
  POINT_SYMBOL_LAYER_ID,
  POINT_LAYER_ID,
  CLUSTER_COUNT_LAYER_ID,
  CLUSTER_LAYER_ID,
];

function fitBoundsToPoints(map, mapboxglLib, points) {
  if (!map || !mapboxglLib?.LngLatBounds || !Array.isArray(points) || points.length === 0) {
    return;
  }
  try {
    if (points.length === 1) {
      map.easeTo?.({
        center: [points[0].longitude, points[0].latitude],
        zoom: 13,
        duration: 400,
      });
      return;
    }
    const bounds = new mapboxglLib.LngLatBounds();
    for (const pt of points) {
      bounds.extend([pt.longitude, pt.latitude]);
    }
    map.fitBounds?.(bounds, { padding: 48, maxZoom: 14 });
  } catch {
    // Ignore transient bounds calculation issues
  }
}

export class MapErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidUpdate(prevProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          className="bg-rose-50 border border-rose-200 rounded-2xl p-8 text-center space-y-3"
        >
          <AlertTriangle className="w-8 h-8 text-rose-600 mx-auto" />
          <h2 className="text-base font-bold text-rose-950">
            Interactive Map Unavailable
          </h2>
          <p className="text-xs text-rose-800 max-w-md mx-auto">
            The interactive map could not be displayed in this browser session. You can still browse all mapped complaints in the accessible list below.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function PublicComplaintsMap({
  points = [],
  mapboxToken = MAPBOX_PUBLIC_TOKEN,
  mapboxglLib = mapboxgl,
  onNavigateToDetail,
  onRetryInit,
}) {
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const popupRef = useRef(null);
  const styleReadyRef = useRef(false);
  const lastAppliedGeoJsonRef = useRef(null);
  const latestPointsRef = useRef(points);
  const latestGeoJsonRef = useRef({ type: 'FeatureCollection', features: [] });
  const latestNavigateRef = useRef(onNavigateToDetail);

  const [initAttempt, setInitAttempt] = useState(0);
  const [mapInitError, setMapInitError] = useState('');

  const tokenCheck = useMemo(
    () => validatePublicMapboxToken(mapboxToken),
    [mapboxToken]
  );

  const geoJson = useMemo(() => buildMapGeoJson(points), [points]);
  latestPointsRef.current = points;
  latestGeoJsonRef.current = geoJson;

  useEffect(() => {
    latestNavigateRef.current = onNavigateToDetail;
  }, [onNavigateToDetail]);

  // Initialize Mapbox instance once per mount (or retry), never on filter change
  useEffect(() => {
    if (!tokenCheck.valid || !mapContainerRef.current) {
      return undefined;
    }

    let isDisposed = false;
    let map = null;
    let resizeObserver = null;
    let onWindowResize = null;

    setMapInitError('');
    styleReadyRef.current = false;

    const handleClusterClick = (e) => {
      if (!map) return;
      const features = map.queryRenderedFeatures?.(e.point, {
        layers: [CLUSTER_LAYER_ID],
      });
      if (!features || features.length === 0) return;
      const clusterFeature = features[0];
      const clusterId = clusterFeature.properties?.cluster_id;
      const source = map.getSource?.(SOURCE_ID);
      if (!source || typeof source.getClusterExpansionZoom !== 'function') return;

      source.getClusterExpansionZoom(clusterId, (err, zoom) => {
        if (err || isDisposed) return;
        map.easeTo?.({
          center: clusterFeature.geometry.coordinates,
          zoom: Math.min(Number(zoom) || 12, PUBLIC_MAP_MAX_ZOOM),
        });
      });
    };

    const handlePointClick = (e) => {
      if (!map || !e?.features || e.features.length === 0) return;
      const clickedFeature = e.features[0];
      const coordKey = clickedFeature.properties?.coordKey;
      const coordinates = clickedFeature.geometry?.coordinates?.slice?.();
      if (!coordinates || coordinates.length < 2) return;

      const stackedPoints = groupPointsAtLocation(latestPointsRef.current, coordKey);
      const effectivePoints =
        stackedPoints.length > 0
          ? stackedPoints
          : [
              {
                public_reference: clickedFeature.properties?.public_reference,
                title: clickedFeature.properties?.title,
                category: clickedFeature.properties?.category,
                ward: clickedFeature.properties?.ward,
                status: clickedFeature.properties?.status,
                submitted_date: clickedFeature.properties?.submitted_date,
              },
            ];

      const popupModel = buildPopupModel(effectivePoints);
      const popupDom = buildPopupDomElement(
        popupModel,
        (ref) => latestNavigateRef.current?.(ref)
      );

      if (popupRef.current) {
        popupRef.current.remove();
        popupRef.current = null;
      }

      if (typeof mapboxglLib.Popup === 'function') {
        const popup = new mapboxglLib.Popup({
          offset: 14,
          maxWidth: '310px',
          closeButton: true,
        })
          .setLngLat(coordinates)
          .setDOMContent(popupDom)
          .addTo(map);
        popupRef.current = popup;
      }
    };

    const handlePointerEnter = () => {
      if (map?.getCanvas?.()) {
        map.getCanvas().style.cursor = 'pointer';
      }
    };

    const handlePointerLeave = () => {
      if (map?.getCanvas?.()) {
        map.getCanvas().style.cursor = '';
      }
    };

    const handleMapError = () => {
      if (!isDisposed && !styleReadyRef.current) {
        setMapInitError(
          'Unable to initialize the map tiles right now. Please try again or use the text list below.'
        );
      }
    };

    const handleMapLoad = () => {
      if (isDisposed || !map) return;

      try {
        map.addSource(SOURCE_ID, {
          type: 'geojson',
          data: latestGeoJsonRef.current,
          cluster: true,
          clusterMaxZoom: 14,
          clusterRadius: 45,
        });

        map.addLayer({
          id: CLUSTER_LAYER_ID,
          type: 'circle',
          source: SOURCE_ID,
          filter: ['has', 'point_count'],
          paint: {
            'circle-color': [
              'step',
              ['get', 'point_count'],
              '#0f766e',
              25,
              '#0369a1',
              100,
              '#0f172a',
            ],
            'circle-radius': [
              'step',
              ['get', 'point_count'],
              18,
              25,
              24,
              100,
              30,
            ],
            'circle-stroke-width': 2.5,
            'circle-stroke-color': '#ffffff',
          },
        });

        map.addLayer({
          id: CLUSTER_COUNT_LAYER_ID,
          type: 'symbol',
          source: SOURCE_ID,
          filter: ['has', 'point_count'],
          layout: {
            'text-field': ['get', 'point_count_abbreviated'],
            'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
            'text-size': 12,
          },
          paint: {
            'text-color': '#ffffff',
          },
        });

        map.addLayer({
          id: POINT_LAYER_ID,
          type: 'circle',
          source: SOURCE_ID,
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-color': [
              'match',
              ['get', 'status'],
              'submitted',
              PUBLIC_MAP_STATUS_META.submitted.color,
              'under_review',
              PUBLIC_MAP_STATUS_META.under_review.color,
              'in_progress',
              PUBLIC_MAP_STATUS_META.in_progress.color,
              'resolved',
              PUBLIC_MAP_STATUS_META.resolved.color,
              '#475569',
            ],
            'circle-radius': 11,
            'circle-stroke-width': 2.5,
            'circle-stroke-color': '#ffffff',
          },
        });

        // Non-color symbol overlay ('S', 'R', 'P', '✓') so status never relies on color alone
        map.addLayer({
          id: POINT_SYMBOL_LAYER_ID,
          type: 'symbol',
          source: SOURCE_ID,
          filter: ['!', ['has', 'point_count']],
          layout: {
            'text-field': ['get', 'statusMarkerText'],
            'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
            'text-size': 11,
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: {
            'text-color': '#ffffff',
          },
        });

        map.on('click', CLUSTER_LAYER_ID, handleClusterClick);
        map.on('click', POINT_LAYER_ID, handlePointClick);
        map.on('click', POINT_SYMBOL_LAYER_ID, handlePointClick);

        for (const layerId of [CLUSTER_LAYER_ID, POINT_LAYER_ID, POINT_SYMBOL_LAYER_ID]) {
          map.on('mouseenter', layerId, handlePointerEnter);
          map.on('mouseleave', layerId, handlePointerLeave);
        }

        styleReadyRef.current = true;
        lastAppliedGeoJsonRef.current = latestGeoJsonRef.current;
        fitBoundsToPoints(map, mapboxglLib, latestPointsRef.current);
      } catch {
        setMapInitError('Failed to render public complaint layers on the map.');
      }
    };

    try {
      mapboxglLib.accessToken = mapboxToken.trim();
      const firstPt = latestPointsRef.current[0];
      const initialCenter = firstPt
        ? [firstPt.longitude, firstPt.latitude]
        : [...PUBLIC_MAP_DEFAULT_CENTER];

      map = new mapboxglLib.Map({
        container: mapContainerRef.current,
        style: 'mapbox://styles/mapbox/streets-v12',
        center: initialCenter,
        zoom: 11,
        minZoom: INDIA_MAP_MIN_ZOOM,
        maxZoom: PUBLIC_MAP_MAX_ZOOM,
        maxBounds: INDIA_MAP_MAX_BOUNDS,
        renderWorldCopies: false,
      });

      if (typeof mapboxglLib.NavigationControl === 'function') {
        map.addControl?.(new mapboxglLib.NavigationControl(), 'top-right');
      }

      map.on('load', handleMapLoad);
      map.on('error', handleMapError);
      mapInstanceRef.current = map;

      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => {
          if (!isDisposed) {
            try {
              map?.resize?.();
            } catch {
              // Ignore resize during teardown
            }
          }
        });
        resizeObserver.observe(mapContainerRef.current);
      } else if (typeof window !== 'undefined') {
        onWindowResize = () => {
          if (!isDisposed) {
            try {
              map?.resize?.();
            } catch {
              // Ignore resize during teardown
            }
          }
        };
        window.addEventListener('resize', onWindowResize);
      }
    } catch {
      setMapInitError(
        'Map initialization failed in this browser environment (WebGL may be disabled). Use the accessible complaint list below.'
      );
      return undefined;
    }

    return () => {
      isDisposed = true;
      styleReadyRef.current = false;
      lastAppliedGeoJsonRef.current = null;

      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
      if (onWindowResize && typeof window !== 'undefined') {
        window.removeEventListener('resize', onWindowResize);
      }
      if (popupRef.current) {
        try {
          popupRef.current.remove();
        } catch {
          // Ignore popup cleanup errors
        }
        popupRef.current = null;
      }

      if (map) {
        try {
          map.off?.('load', handleMapLoad);
          map.off?.('error', handleMapError);
          map.off?.('click', CLUSTER_LAYER_ID, handleClusterClick);
          map.off?.('click', POINT_LAYER_ID, handlePointClick);
          map.off?.('click', POINT_SYMBOL_LAYER_ID, handlePointClick);
          for (const layerId of [CLUSTER_LAYER_ID, POINT_LAYER_ID, POINT_SYMBOL_LAYER_ID]) {
            map.off?.('mouseenter', layerId, handlePointerEnter);
            map.off?.('mouseleave', layerId, handlePointerLeave);
          }

          if (map.getStyle?.()) {
            for (const layerId of ALL_LAYER_IDS) {
              if (map.getLayer?.(layerId)) {
                map.removeLayer(layerId);
              }
            }
            if (map.getSource?.(SOURCE_ID)) {
              map.removeSource(SOURCE_ID);
            }
          }
        } catch {
          // Safe cleanup even if style never finished loading
        }

        try {
          map.remove();
        } catch {
          // Safe teardown
        }
      }

      mapInstanceRef.current = null;
    };
  }, [tokenCheck.valid, mapboxToken, mapboxglLib, initAttempt]);

  // Update GeoJSON data on filter changes without re-creating the Map instance
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !styleReadyRef.current) return;
    if (lastAppliedGeoJsonRef.current === geoJson) return;

    if (popupRef.current) {
      popupRef.current.remove();
      popupRef.current = null;
    }

    try {
      const source = map.getSource?.(SOURCE_ID);
      if (source && typeof source.setData === 'function') {
        source.setData(geoJson);
        lastAppliedGeoJsonRef.current = geoJson;
      }
      if (points.length > 0) {
        fitBoundsToPoints(map, mapboxglLib, points);
      }
    } catch {
      // Ignore source update error if map is disposing
    }
  }, [geoJson, points, mapboxglLib]);

  const handleRetry = () => {
    setMapInitError('');
    setInitAttempt((n) => n + 1);
    onRetryInit?.();
  };

  if (!tokenCheck.valid) {
    return (
      <div
        role="alert"
        className="bg-amber-50 border border-amber-200 rounded-2xl p-8 text-center space-y-3"
      >
        <AlertTriangle className="w-8 h-8 text-amber-600 mx-auto" />
        <h2 className="text-base font-bold text-amber-950">
          Interactive Map Configuration Error
        </h2>
        <p className="text-xs text-amber-900 max-w-md mx-auto leading-relaxed">
          {tokenCheck.reason === 'secret_forbidden'
            ? 'An invalid private map credential was detected and blocked. Only public client map tokens are permitted.'
            : 'The public Mapbox access token is missing or invalid. Please review the complaint list below while map configuration is updated.'}
        </p>
      </div>
    );
  }

  if (mapInitError) {
    return (
      <div
        role="alert"
        className="bg-rose-50 border border-rose-200 rounded-2xl p-8 text-center space-y-3"
      >
        <AlertTriangle className="w-8 h-8 text-rose-600 mx-auto" />
        <h2 className="text-base font-bold text-rose-950">
          Could Not Display Interactive Map
        </h2>
        <p className="text-xs text-rose-800 max-w-md mx-auto">{mapInitError}</p>
        <div className="pt-1">
          <Button variant="primary" size="sm" icon={RefreshCw} onClick={handleRetry}>
            Retry Map
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-[420px] sm:h-[520px] rounded-2xl overflow-hidden border border-slate-200 bg-slate-100 shadow-2xs">
      <div
        ref={mapContainerRef}
        aria-label="Interactive public complaint map"
        className="w-full h-full"
      />
    </div>
  );
}
