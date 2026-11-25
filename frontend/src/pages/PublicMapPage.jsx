import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Calendar,
  Info,
  List,
  MapPin,
  RefreshCw,
} from 'lucide-react';
import Button from '../components/common/Button';
import StatusBadge from '../components/common/StatusBadge';
import PublicComplaintsMap, { MapErrorBoundary } from '../components/maps/PublicComplaintsMap';
import { formatDate } from '../utils/formatters';
import {
  PUBLIC_CATEGORY_OPTIONS,
  fetchPublicMapPoints,
  fetchPublicWardNames,
  getCategoryLabel,
  isValidUuid,
} from '../services/publicService';
import {
  PUBLIC_MAP_STATUS_META,
  PUBLIC_MAP_TEXT_LIST_LIMIT,
  buildMapSearchParams,
  getMapTransparencyMessages,
  parseMapSearchParams,
  sanitizeAndValidateMapPoints,
} from '../utils/publicMapUtils';

export default function PublicMapPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const parsedUrl = useMemo(() => parseMapSearchParams(searchParams), [searchParams]);
  const { ward, category, sanitizedSearchParams, hadInvalidParams } = parsedUrl;

  useEffect(() => {
    if (hadInvalidParams) {
      setSearchParams(sanitizedSearchParams, { replace: true });
    }
  }, [hadInvalidParams, sanitizedSearchParams, setSearchParams]);

  const [wardNames, setWardNames] = useState([]);
  const [wardsLoading, setWardsLoading] = useState(true);

  const [validPoints, setValidPoints] = useState([]);
  const [meta, setMeta] = useState({
    truncated: false,
    total_count: null,
    unmapped_count: 0,
    count_suppressed: false,
  });
  const [loading, setLoading] = useState(true);
  const [errorState, setErrorState] = useState(null);
  const [showAllTextItems, setShowAllTextItems] = useState(false);

  const mapAbortRef = useRef(null);
  const requestSeqRef = useRef(0);

  // Load ward filter options (>= 5 complaints)
  useEffect(() => {
    const controller = new AbortController();
    setWardsLoading(true);
    fetchPublicWardNames({ signal: controller.signal })
      .then((names) => {
        if (!controller.signal.aborted) {
          setWardNames(names);
        }
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        setWardNames([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setWardsLoading(false);
        }
      });
    return () => controller.abort();
  }, []);

  const loadMapPoints = useCallback(async () => {
    if (mapAbortRef.current) {
      mapAbortRef.current.abort();
    }
    const controller = new AbortController();
    mapAbortRef.current = controller;
    const seq = ++requestSeqRef.current;

    setLoading(true);
    setErrorState(null);
    setShowAllTextItems(false);

    try {
      const result = await fetchPublicMapPoints(
        { ward, category },
        { signal: controller.signal }
      );

      if (controller.signal.aborted || seq !== requestSeqRef.current) return;

      const cleanedPoints = sanitizeAndValidateMapPoints(result.points);
      setValidPoints(cleanedPoints);
      setMeta({
        truncated: result.truncated,
        total_count: result.total_count,
        unmapped_count: result.unmapped_count,
        count_suppressed: result.count_suppressed,
      });
    } catch (err) {
      if (err.name === 'AbortError' || seq !== requestSeqRef.current) return;

      let message = err.message || 'Unable to load public map complaints.';
      if (err.status === 429) {
        message = 'Too many requests, try again shortly.';
      } else if (err.status === 503) {
        message = 'Public map service is temporarily unavailable. Please try again shortly.';
      } else if (err.status === 400) {
        message = 'Invalid ward or category filter. Please adjust or clear filters.';
      }
      setErrorState({ status: err.status || 500, message });
    } finally {
      if (!controller.signal.aborted && seq === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, [ward, category]);

  useEffect(() => {
    loadMapPoints();
    return () => {
      if (mapAbortRef.current) {
        mapAbortRef.current.abort();
      }
    };
  }, [loadMapPoints]);

  const updateFilter = (patch) => {
    const next = buildMapSearchParams({
      ward: patch.ward !== undefined ? patch.ward : ward,
      category: patch.category !== undefined ? patch.category : category,
    });
    setSearchParams(next);
  };

  const handleClearFilters = () => {
    setSearchParams(new URLSearchParams());
  };

  const filterQueryString = useMemo(() => {
    const qs = buildMapSearchParams({ ward, category }).toString();
    return qs ? `?${qs}` : '';
  }, [ward, category]);

  const listLinkUrl = `/issues${filterQueryString}`;

  const wardDropdownOptions = useMemo(() => {
    const set = new Set(wardNames);
    if (ward && !set.has(ward)) {
      set.add(ward);
    }
    return Array.from(set).sort();
  }, [wardNames, ward]);

  const transparency = useMemo(
    () =>
      getMapTransparencyMessages({
        truncated: meta.truncated,
        pointCount: validPoints.length,
        unmappedCount: meta.unmapped_count,
        countSuppressed: meta.count_suppressed,
        totalCount: meta.total_count,
      }),
    [meta, validPoints.length]
  );

  const visibleTextPoints = showAllTextItems
    ? validPoints
    : validPoints.slice(0, PUBLIC_MAP_TEXT_LIST_LIMIT);
  const hasMoreTextItems = validPoints.length > visibleTextPoints.length;
  const hasActiveFilters = Boolean(ward || category);

  const handleNavigateToDetail = useCallback(
    (publicRef) => {
      if (!isValidUuid(publicRef || '')) return;
      navigate(`/issues/${encodeURIComponent(publicRef)}`, {
        state: { fromSearch: filterQueryString },
      });
    },
    [navigate, filterQueryString]
  );

  return (
    <div className="min-h-screen bg-slate-50 py-8 sm:py-10">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6">
        {/* Header */}
        <div className="bg-slate-900 text-white rounded-2xl p-6 sm:p-8 shadow-sm border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-2 max-w-2xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-800 border border-slate-700 text-xs font-medium text-teal-300">
              <MapPin className="w-3.5 h-3.5" />
              <span>Area-Level Civic Map</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
              Public Issue Map
            </h1>
            <p className="text-sm text-slate-300">
              Explore approximate locations of non-rejected civic reports. Click any marker group to view reports in that area.
            </p>
          </div>

          <Link
            to={listLinkUrl}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-teal-600 hover:bg-teal-500 text-white text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-teal-300 transition-colors shrink-0 self-start sm:self-auto"
          >
            <List className="w-4 h-4" />
            <span>View as list</span>
          </Link>
        </div>

        {/* Privacy Notice */}
        <div className="bg-slate-100 border border-slate-200 rounded-xl px-4 py-3 flex items-start gap-2.5 text-xs text-slate-700">
          <Info className="w-4 h-4 text-slate-600 shrink-0 mt-0.5" />
          <p>
            <strong>Privacy protection:</strong> Locations are approximate (about 100 m), titles are generic, and rejected reports are not shown.
          </p>
        </div>

        {/* Filter Bar + Status Legend */}
        <section
          aria-label="Filter public map complaints"
          className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 shadow-2xs space-y-4"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Category Filter */}
            <div>
              <label
                htmlFor="map-category-filter"
                className="block text-xs font-semibold text-slate-600 mb-1"
              >
                Category
              </label>
              <select
                id="map-category-filter"
                value={category}
                onChange={(e) => updateFilter({ category: e.target.value })}
                className="w-full bg-white border border-slate-300 text-slate-800 text-sm rounded-lg px-3 py-2 font-medium focus:outline-none focus:ring-2 focus:ring-slate-900"
              >
                <option value="">All Categories</option>
                {PUBLIC_CATEGORY_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Ward Filter */}
            <div>
              <label
                htmlFor="map-ward-filter"
                className="block text-xs font-semibold text-slate-600 mb-1"
              >
                Ward
              </label>
              <select
                id="map-ward-filter"
                value={ward}
                disabled={wardsLoading && wardDropdownOptions.length === 0}
                onChange={(e) => updateFilter({ ward: e.target.value })}
                className="w-full bg-white border border-slate-300 text-slate-800 text-sm rounded-lg px-3 py-2 font-medium focus:outline-none focus:ring-2 focus:ring-slate-900 disabled:bg-slate-100 disabled:text-slate-500"
              >
                <option value="">
                  {wardsLoading && wardDropdownOptions.length === 0
                    ? 'Loading wards...'
                    : 'All Wards'}
                </option>
                {wardDropdownOptions.map((wardName) => (
                  <option key={wardName} value={wardName}>
                    {wardName}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-slate-500">
                {!wardsLoading && wardDropdownOptions.length === 0
                  ? 'Small wards cannot be filtered individually until 5 or more public complaints are recorded.'
                  : 'Only wards with 5 or more public complaints appear in this filter.'}
              </p>
            </div>
          </div>

          {/* Counts, Transparency Notes & Clear */}
          <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-700">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1" aria-live="polite">
              {loading ? (
                <span>Loading mapped complaints...</span>
              ) : errorState ? (
                <span>Unable to load map metrics</span>
              ) : (
                <>
                  <span className="font-semibold text-slate-900">
                    {transparency.countText}
                  </span>
                  {transparency.truncatedText && (
                    <span className="px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200 text-[11px] font-medium">
                      {transparency.truncatedText}
                    </span>
                  )}
                  {transparency.unmappedText && (
                    <span className="text-slate-600">
                      {transparency.unmappedText}
                    </span>
                  )}
                </>
              )}
            </div>

            {hasActiveFilters && (
              <button
                type="button"
                onClick={handleClearFilters}
                className="text-xs font-semibold text-teal-700 hover:text-teal-800 underline focus:outline-none focus:ring-2 focus:ring-teal-500 rounded cursor-pointer"
              >
                Clear filters
              </button>
            )}
          </div>

          {/* Color + Shape/Symbol Status Legend */}
          <div
            aria-label="Map marker status legend"
            className="pt-3 border-t border-slate-100 flex flex-wrap items-center gap-4 text-xs text-slate-700"
          >
            <span className="font-semibold text-slate-600">Status Legend:</span>
            {Object.values(PUBLIC_MAP_STATUS_META).map((item) => (
              <span key={item.id} className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-flex items-center justify-center w-5 h-5 rounded-full text-white text-[10px] font-bold border border-white shadow-2xs"
                  style={{ backgroundColor: item.color }}
                >
                  {item.markerText}
                </span>
                <span className="font-medium">{item.label}</span>
              </span>
            ))}
          </div>
        </section>

        {/* Map Display States */}
        {loading ? (
          <div
            className="w-full h-[420px] sm:h-[520px] rounded-2xl border border-slate-200 bg-white p-6 flex flex-col justify-center items-center gap-3 animate-pulse"
            aria-busy="true"
            aria-label="Loading public complaint map"
          >
            <div className="w-12 h-12 rounded-2xl bg-slate-200" />
            <div className="h-4 w-48 bg-slate-200 rounded" />
            <div className="h-3 w-64 bg-slate-100 rounded" />
          </div>
        ) : errorState ? (
          <div
            role="alert"
            className="bg-rose-50 border border-rose-200 rounded-2xl p-8 text-center max-w-xl mx-auto space-y-3"
          >
            <div className="w-11 h-11 rounded-xl bg-rose-100 text-rose-700 flex items-center justify-center mx-auto">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <h2 className="text-base font-bold text-rose-950">
              {errorState.status === 429
                ? 'Rate Limit Reached'
                : errorState.status === 503
                  ? 'Service Temporarily Unavailable'
                  : 'Unable to Load Map Data'}
            </h2>
            <p className="text-xs text-rose-800">{errorState.message}</p>
            <div className="flex justify-center gap-3 pt-1">
              <Button variant="primary" size="sm" icon={RefreshCw} onClick={loadMapPoints}>
                Retry
              </Button>
              {hasActiveFilters && (
                <Button variant="outline" size="sm" onClick={handleClearFilters}>
                  Clear filters
                </Button>
              )}
            </div>
          </div>
        ) : validPoints.length === 0 ? (
          <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center max-w-lg mx-auto space-y-3">
            <div className="w-11 h-11 rounded-xl bg-slate-100 text-slate-600 flex items-center justify-center mx-auto">
              <AlertCircle className="w-6 h-6" />
            </div>
            <h2 className="text-base font-bold text-slate-900">
              No mapped complaints for these filters
            </h2>
            <p className="text-xs text-slate-500">
              {transparency.unmappedText
                ? `${transparency.unmappedText}. You can switch to the list view or clear filters to browse other areas.`
                : 'Try adjusting or clearing your ward and category filters.'}
            </p>
            <div className="flex justify-center gap-3 pt-1">
              {hasActiveFilters && (
                <Button variant="outline" size="sm" onClick={handleClearFilters}>
                  Clear filters
                </Button>
              )}
              <Link to={listLinkUrl}>
                <Button variant="primary" size="sm" icon={List}>
                  View as list
                </Button>
              </Link>
            </div>
          </div>
        ) : (
          <>
            {/* Interactive Mapbox Clustered Map */}
            <MapErrorBoundary resetKey={`${ward}|${category}`}>
              <PublicComplaintsMap
                points={validPoints}
                onNavigateToDetail={handleNavigateToDetail}
              />
            </MapErrorBoundary>

            {/* Accessible Text Alternative List (max 50 initially with Show more / Explorer link) */}
            <section
              aria-labelledby="mapped-list-heading"
              className="bg-white rounded-2xl border border-slate-200/90 shadow-2xs overflow-hidden"
            >
              <div className="p-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 id="mapped-list-heading" className="text-base font-bold text-slate-900">
                    Mapped Complaints List
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Accessible text listing of the mapped reports shown above.
                  </p>
                </div>
                <Link
                  to={listLinkUrl}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-teal-700 hover:text-teal-800 underline"
                >
                  <span>Open full Explorer with these filters</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              </div>

              <ul className="divide-y divide-slate-100">
                {visibleTextPoints.map((pt) => (
                  <li
                    key={pt.public_reference}
                    className="p-4 sm:px-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50/70 transition-colors"
                  >
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-teal-700">
                          {getCategoryLabel(pt.category)}
                        </span>
                        <StatusBadge status={pt.status} size="sm" />
                      </div>
                      <h3 className="text-sm font-bold text-slate-900">{pt.title}</h3>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="w-3.5 h-3.5 text-slate-400" />
                          {pt.ward || 'Unspecified'}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Calendar className="w-3.5 h-3.5 text-slate-400" />
                          Submitted {formatDate(pt.submitted_date)}
                        </span>
                      </div>
                    </div>

                    {isValidUuid(pt.public_reference || '') && (
                      <Link
                        to={`/issues/${encodeURIComponent(pt.public_reference)}`}
                        state={{ fromSearch: filterQueryString }}
                        className="inline-flex items-center gap-1 text-xs font-semibold text-slate-800 hover:text-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-500 rounded px-2 py-1 shrink-0"
                      >
                        <span>View details</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </Link>
                    )}
                  </li>
                ))}
              </ul>

              {(hasMoreTextItems || meta.truncated) && (
                <div className="p-4 border-t border-slate-100 bg-slate-50/60 flex flex-wrap items-center justify-between gap-3">
                  {hasMoreTextItems && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowAllTextItems(true)}
                    >
                      Show more mapped complaints
                    </Button>
                  )}
                  <Link
                    to={listLinkUrl}
                    className="text-xs font-semibold text-teal-700 hover:text-teal-800 underline ml-auto"
                  >
                    View all matching reports in Explorer
                  </Link>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
