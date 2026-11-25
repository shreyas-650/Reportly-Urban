import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Info,
  MapPin,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react';
import Button from '../components/common/Button';
import IssueCard from '../components/issues/IssueCard';
import { buildMapSearchParams } from '../utils/publicMapUtils';
import {
  PUBLIC_CATEGORY_OPTIONS,
  PUBLIC_PAGE_SIZE,
  PUBLIC_STATUS_OPTIONS,
  buildExplorerSearchParams,
  fetchPublicComplaints,
  fetchPublicWardNames,
  formatSuppressedExplorerTotal,
  isValidUuid,
  parseExplorerSearchParams,
} from '../services/publicService';

export default function ExploreIssuesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  // Derive validated state directly from URL query params (single source of truth)
  const parsedUrl = useMemo(
    () => parseExplorerSearchParams(searchParams),
    [searchParams]
  );
  const { category, status, ward, page, sanitizedSearchParams, hadInvalidParams } = parsedUrl;

  // Strip invalid/unknown URL params once on load/change without triggering duplicate API calls
  useEffect(() => {
    if (hadInvalidParams) {
      setSearchParams(sanitizedSearchParams, { replace: true });
    }
  }, [hadInvalidParams, sanitizedSearchParams, setSearchParams]);

  // Ward dropdown names (loaded from /api/public/wards/names)
  const [wardNames, setWardNames] = useState([]);
  const [wardsLoading, setWardsLoading] = useState(true);

  // Complaint list API state
  const [items, setItems] = useState([]);
  const [totalCount, setTotalCount] = useState(null);
  const [countSuppressed, setCountSuppressed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errorState, setErrorState] = useState(null); // { status, message }

  // Look up by public reference input
  const [referenceInput, setReferenceInput] = useState('');
  const [referenceError, setReferenceError] = useState('');

  // Cancellation and stale-response protection
  const listAbortRef = useRef(null);
  const requestSeqRef = useRef(0);

  // Load allowed ward names once on mount
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
        // Ward list stays gracefully empty; category/status filters remain usable
        setWardNames([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setWardsLoading(false);
        }
      });

    return () => controller.abort();
  }, []);

  const loadComplaints = useCallback(async () => {
    if (listAbortRef.current) {
      listAbortRef.current.abort();
    }
    const controller = new AbortController();
    listAbortRef.current = controller;
    const seq = ++requestSeqRef.current;

    setLoading(true);
    setErrorState(null);

    try {
      const result = await fetchPublicComplaints(
        { category, status, ward, page, pageSize: PUBLIC_PAGE_SIZE },
        { signal: controller.signal }
      );

      if (controller.signal.aborted || seq !== requestSeqRef.current) {
        return;
      }

      setItems(result.items);
      setTotalCount(result.total_count);
      setCountSuppressed(result.count_suppressed);
    } catch (err) {
      if (err.name === 'AbortError' || seq !== requestSeqRef.current) {
        return;
      }
      let message = err.message || 'Unable to load public complaints.';
      if (err.status === 429) {
        message = 'Too many requests, try again shortly.';
      } else if (err.status === 503) {
        message = 'Public complaints service is temporarily unavailable. Please try again shortly.';
      } else if (err.status === 400) {
        message = 'One or more filter parameters were invalid. Please adjust or clear your filters.';
      }
      setErrorState({ status: err.status || 500, message });
    } finally {
      if (!controller.signal.aborted && seq === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, [category, status, ward, page]);

  useEffect(() => {
    loadComplaints();
    return () => {
      if (listAbortRef.current) {
        listAbortRef.current.abort();
      }
    };
  }, [loadComplaints]);

  const updateFilter = (patch) => {
    const next = buildExplorerSearchParams({
      category: patch.category !== undefined ? patch.category : category,
      status: patch.status !== undefined ? patch.status : status,
      ward: patch.ward !== undefined ? patch.ward : ward,
      page: 1, // Reset to page 1 on any filter change
    });
    setSearchParams(next);
  };

  const handlePageChange = (nextPage) => {
    if (nextPage < 1) return;
    const next = buildExplorerSearchParams({ category, status, ward, page: nextPage });
    setSearchParams(next);
  };

  const handleClearFilters = () => {
    setReferenceError('');
    setSearchParams(new URLSearchParams());
  };

  const handleReferenceLookup = (e) => {
    e.preventDefault();
    const cleaned = referenceInput.trim();
    if (!isValidUuid(cleaned)) {
      setReferenceError(
        'Enter a valid public reference UUID (e.g. 550e8400-e29b-41d4-a716-446655440000).'
      );
      return;
    }
    setReferenceError('');
    const currentSearch = buildExplorerSearchParams({
      category,
      status,
      ward,
      page,
    }).toString();
    navigate(`/issues/${encodeURIComponent(cleaned)}`, {
      state: { fromSearch: currentSearch ? `?${currentSearch}` : '' },
    });
  };

  const wardDropdownOptions = useMemo(() => {
    const set = new Set(wardNames);
    if (ward && !set.has(ward)) {
      set.add(ward);
    }
    return Array.from(set).sort();
  }, [wardNames, ward]);

  const hasActiveFilters = Boolean(category || status || ward);
  const totalSummary = formatSuppressedExplorerTotal(totalCount, countSuppressed);
  const totalPages =
    !totalSummary.suppressed && totalSummary.count > 0
      ? Math.ceil(totalSummary.count / PUBLIC_PAGE_SIZE)
      : 1;
  const showPager = !loading && !errorState && !totalSummary.suppressed && totalPages > 1;
  const currentQueryString = useMemo(() => {
    const str = buildExplorerSearchParams({ category, status, ward, page }).toString();
    return str ? `?${str}` : '';
  }, [category, status, ward, page]);

  const viewOnMapUrl = useMemo(() => {
    const qs = buildMapSearchParams({ ward, category }).toString();
    return qs ? `/map?${qs}` : '/map';
  }, [ward, category]);

  return (
    <div className="min-h-screen bg-slate-50 py-8 sm:py-10">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6">
        {/* Header */}
        <div className="bg-slate-900 text-white rounded-2xl p-6 sm:p-8 shadow-sm border border-slate-800 flex flex-col lg:flex-row lg:items-end justify-between gap-6">
          <div className="space-y-2 max-w-2xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-800 border border-slate-700 text-xs font-medium text-teal-300">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Public Civic Explorer</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
              Public Complaint Explorer
            </h1>
            <p className="text-sm text-slate-300">
              Browse non-rejected municipal issues by category, status, and ward, or open a record directly using its public reference.
            </p>
          </div>

          {/* Look up by reference */}
          <form
            onSubmit={handleReferenceLookup}
            noValidate
            className="w-full lg:w-[430px] bg-slate-800/80 border border-slate-700 rounded-xl p-3.5 space-y-2"
          >
            <label
              htmlFor="reference-lookup"
              className="block text-xs font-semibold text-slate-200"
            >
              Look up by public reference
            </label>
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="reference-lookup"
                  type="text"
                  value={referenceInput}
                  onChange={(e) => {
                    setReferenceInput(e.target.value);
                    if (referenceError) setReferenceError('');
                  }}
                  placeholder="Paste reference UUID..."
                  aria-invalid={Boolean(referenceError)}
                  aria-describedby={referenceError ? 'reference-lookup-error' : undefined}
                  className="w-full pl-9 pr-3 py-2 text-xs rounded-lg bg-slate-900 border border-slate-600 text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-400"
                />
              </div>
              <button
                type="submit"
                className="px-3.5 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-teal-300 shrink-0 cursor-pointer"
              >
                Open Record
              </button>
            </div>
            {referenceError && (
              <p
                id="reference-lookup-error"
                role="alert"
                className="text-[11px] text-rose-300 font-medium"
              >
                {referenceError}
              </p>
            )}
          </form>
        </div>

        {/* Privacy Notice */}
        <div className="bg-slate-100 border border-slate-200 rounded-xl px-4 py-3 flex items-start gap-2.5 text-xs text-slate-700">
          <Info className="w-4 h-4 text-slate-600 shrink-0 mt-0.5" />
          <p>
            <strong>Privacy protection:</strong> Titles are generic by design, locations are shown at ward/area level only, and rejected reports are not listed.
          </p>
        </div>

        {/* Filters */}
        <section
          aria-label="Filter public complaints"
          className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 shadow-2xs space-y-4"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {/* Category filter */}
            <div>
              <label
                htmlFor="explorer-category-filter"
                className="block text-xs font-semibold text-slate-600 mb-1"
              >
                Category
              </label>
              <select
                id="explorer-category-filter"
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

            {/* Status filter */}
            <div>
              <label
                htmlFor="explorer-status-filter"
                className="block text-xs font-semibold text-slate-600 mb-1"
              >
                Status
              </label>
              <select
                id="explorer-status-filter"
                value={status}
                onChange={(e) => updateFilter({ status: e.target.value })}
                className="w-full bg-white border border-slate-300 text-slate-800 text-sm rounded-lg px-3 py-2 font-medium focus:outline-none focus:ring-2 focus:ring-slate-900"
              >
                <option value="">All Statuses</option>
                {PUBLIC_STATUS_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Ward filter */}
            <div>
              <label
                htmlFor="explorer-ward-filter"
                className="block text-xs font-semibold text-slate-600 mb-1"
              >
                Ward
              </label>
              <select
                id="explorer-ward-filter"
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
              {!wardsLoading && wardDropdownOptions.length === 0 && (
                <p className="mt-1 text-[11px] text-slate-500">
                  No ward groups currently meet the public reporting threshold.
                </p>
              )}
            </div>
          </div>

          <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
            <div aria-live="polite">
              {loading ? (
                <span>Loading matching complaints...</span>
              ) : errorState ? (
                <span>Unable to calculate totals</span>
              ) : (
                <span className="font-semibold text-slate-800">{totalSummary.label}</span>
              )}
            </div>

            <div className="flex items-center gap-4">
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={handleClearFilters}
                  className="text-xs font-semibold text-teal-700 hover:text-teal-800 underline focus:outline-none focus:ring-2 focus:ring-teal-500 rounded cursor-pointer"
                >
                  Clear filters
                </button>
              )}
              <Link
                to={viewOnMapUrl}
                className="inline-flex items-center gap-1 text-xs font-semibold text-slate-800 hover:text-teal-700 underline focus:outline-none focus:ring-2 focus:ring-teal-500 rounded"
              >
                <MapPin className="w-3.5 h-3.5" />
                <span>View on map</span>
              </Link>
            </div>
          </div>
        </section>

        {/* Results Region */}
        {loading ? (
          <div
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5"
            aria-busy="true"
            aria-label="Loading public complaints"
          >
            {[...Array(6)].map((_, idx) => (
              <div
                key={idx}
                className="bg-white rounded-xl border border-slate-200 p-5 h-44 animate-pulse space-y-3"
              >
                <div className="flex justify-between">
                  <div className="h-4 w-24 bg-slate-200 rounded" />
                  <div className="h-5 w-20 bg-slate-200 rounded-full" />
                </div>
                <div className="h-5 w-3/4 bg-slate-200 rounded" />
                <div className="h-4 w-1/2 bg-slate-100 rounded" />
                <div className="h-4 w-1/3 bg-slate-100 rounded" />
              </div>
            ))}
          </div>
        ) : errorState ? (
          <div
            role="alert"
            className="bg-rose-50 border border-rose-200 rounded-2xl p-6 text-center max-w-xl mx-auto space-y-3"
          >
            <div className="w-11 h-11 rounded-xl bg-rose-100 text-rose-700 flex items-center justify-center mx-auto">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <h2 className="text-base font-bold text-rose-950">
              {errorState.status === 429
                ? 'Rate Limit Reached'
                : errorState.status === 503
                  ? 'Service Temporarily Unavailable'
                  : 'Unable to Load Complaints'}
            </h2>
            <p className="text-xs text-rose-800">{errorState.message}</p>
            <div className="flex justify-center gap-3 pt-1">
              <Button variant="primary" size="sm" icon={RefreshCw} onClick={loadComplaints}>
                Retry
              </Button>
              {hasActiveFilters && (
                <Button variant="outline" size="sm" onClick={handleClearFilters}>
                  Clear filters
                </Button>
              )}
            </div>
          </div>
        ) : items.length === 0 ? (
          <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center max-w-lg mx-auto space-y-3">
            <div className="w-11 h-11 rounded-xl bg-slate-100 text-slate-600 flex items-center justify-center mx-auto">
              <AlertCircle className="w-6 h-6" />
            </div>
            <h2 className="text-base font-bold text-slate-900">
              No public complaints match these filters
            </h2>
            <p className="text-xs text-slate-500">
              Try broadening your category, status, or ward filters to view available public records.
            </p>
            {hasActiveFilters && (
              <div className="pt-1">
                <Button variant="outline" size="sm" onClick={handleClearFilters}>
                  Clear filters
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {items.map((item) => (
              <IssueCard
                key={item.public_reference}
                complaint={item}
                fromSearch={currentQueryString}
              />
            ))}
          </div>
        )}

        {/* Keyboard-Navigable Pager (hidden when suppressed or single page) */}
        {showPager && (
          <nav
            aria-label="Pagination"
            className="flex flex-wrap items-center justify-between gap-3 bg-white border border-slate-200 rounded-xl px-4 py-3"
          >
            <span className="text-xs text-slate-600">
              Page <strong className="text-slate-900">{page}</strong> of{' '}
              <strong className="text-slate-900">{totalPages}</strong>
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => handlePageChange(page - 1)}
                aria-label="Previous page"
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold text-slate-700 bg-white hover:bg-slate-50 disabled:opacity-45 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-slate-900 cursor-pointer"
              >
                <ChevronLeft className="w-4 h-4" />
                <span>Previous</span>
              </button>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => handlePageChange(page + 1)}
                aria-label="Next page"
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold text-slate-700 bg-white hover:bg-slate-50 disabled:opacity-45 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-slate-900 cursor-pointer"
              >
                <span>Next</span>
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </nav>
        )}
      </div>
    </div>
  );
}
