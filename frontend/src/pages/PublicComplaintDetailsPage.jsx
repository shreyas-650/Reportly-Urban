import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Calendar,
  Check,
  Copy,
  Info,
  MapPin,
  RefreshCw,
  ShieldAlert,
  Tag,
} from 'lucide-react';
import Button from '../components/common/Button';
import StatusBadge from '../components/common/StatusBadge';
import { formatDate } from '../utils/formatters';
import {
  applyNoIndexMetaTag,
  copyTextToClipboard,
  fetchPublicComplaintDetail,
  getCategoryLabel,
  getPublicStatusDescription,
  isValidUuid,
} from '../services/publicService';

export default function PublicComplaintDetailsPage() {
  const { reference } = useParams();
  const location = useLocation();

  const [complaint, setComplaint] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errorState, setErrorState] = useState(null); // { status, message }

  const [copyStatus, setCopyStatus] = useState('idle'); // 'idle' | 'copied' | 'failed'
  const copyTimerRef = useRef(null);
  const abortRef = useRef(null);
  const requestSeqRef = useRef(0);

  // Determine preserved explorer return path cleanly
  const fromSearch =
    typeof location.state?.fromSearch === 'string' &&
    location.state.fromSearch.startsWith('?')
      ? location.state.fromSearch
      : '';
  const backToExplorerPath = `/issues${fromSearch}`;

  // Attach <meta name="robots" content="noindex, nofollow"> on mount; remove/restore on unmount
  useEffect(() => {
    return applyNoIndexMetaTag();
  }, []);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const loadDetail = useCallback(async () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }

    const seq = ++requestSeqRef.current;

    // Client-side UUID syntax guard produces the exact same generic not-found view as 404
    if (!isValidUuid(reference || '')) {
      setComplaint(null);
      setErrorState(null);
      setNotFound(true);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setNotFound(false);
    setErrorState(null);

    try {
      const data = await fetchPublicComplaintDetail(reference, {
        signal: controller.signal,
      });
      if (controller.signal.aborted || seq !== requestSeqRef.current) return;
      setComplaint(data);
    } catch (err) {
      if (err.name === 'AbortError' || seq !== requestSeqRef.current) return;

      if (err.status === 404) {
        setComplaint(null);
        setNotFound(true);
      } else if (err.status === 429) {
        setErrorState({
          status: 429,
          message: 'Too many requests, try again shortly.',
        });
      } else if (err.status === 503) {
        setErrorState({
          status: 503,
          message: 'Public complaint service is temporarily unavailable. Please try again shortly.',
        });
      } else {
        setErrorState({
          status: err.status || 500,
          message: err.message || 'Unable to load public complaint details.',
        });
      }
    } finally {
      if (!controller.signal.aborted && seq === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, [reference]);

  useEffect(() => {
    loadDetail();
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, [loadDetail]);

  const handleCopyLink = async () => {
    if (copyTimerRef.current) {
      clearTimeout(copyTimerRef.current);
    }
    const currentUrl =
      typeof window !== 'undefined' && window.location ? window.location.href : '';
    const succeeded = await copyTextToClipboard(currentUrl);
    setCopyStatus(succeeded ? 'copied' : 'failed');
    copyTimerRef.current = setTimeout(() => {
      setCopyStatus('idle');
    }, 3500);
  };

  return (
    <div className="min-h-screen bg-slate-50 py-8 sm:py-10">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 space-y-6">
        {/* Back link preserving explorer filters if navigated from /issues */}
        <div>
          <Link
            to={backToExplorerPath}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900 rounded px-1 py-0.5 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back to complaints</span>
          </Link>
        </div>

        {/* Loading State */}
        {loading && (
          <div
            className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 space-y-5 animate-pulse"
            aria-busy="true"
            aria-label="Loading public complaint record"
          >
            <div className="flex justify-between">
              <div className="h-5 w-32 bg-slate-200 rounded" />
              <div className="h-6 w-24 bg-slate-200 rounded-full" />
            </div>
            <div className="h-8 w-3/4 bg-slate-200 rounded" />
            <div className="h-16 bg-slate-100 rounded-xl" />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="h-16 bg-slate-100 rounded-xl" />
              <div className="h-16 bg-slate-100 rounded-xl" />
            </div>
          </div>
        )}

        {/* Unified Generic Not-Found State (identical for malformed, unknown, and rejected references) */}
        {!loading && notFound && (
          <div className="bg-white rounded-2xl border border-slate-200 p-8 sm:p-10 text-center space-y-4 shadow-2xs">
            <div className="w-14 h-14 rounded-2xl bg-slate-100 text-slate-700 flex items-center justify-center mx-auto border border-slate-200">
              <ShieldAlert className="w-7 h-7" />
            </div>
            <h1 className="text-xl sm:text-2xl font-bold text-slate-900">
              Public Complaint Record Not Found
            </h1>
            <p className="text-xs sm:text-sm text-slate-600 max-w-md mx-auto leading-relaxed">
              No public complaint record is available at this reference. The link may be incorrect or the report is not publicly listed.
            </p>
            <div className="pt-2">
              <Link to={backToExplorerPath}>
                <Button variant="primary" size="md" icon={ArrowLeft}>
                  Back to complaints
                </Button>
              </Link>
            </div>
          </div>
        )}

        {/* Service / Rate-Limit Error State */}
        {!loading && errorState && (
          <div
            role="alert"
            className="bg-rose-50 border border-rose-200 rounded-2xl p-6 sm:p-8 text-center space-y-3"
          >
            <div className="w-12 h-12 rounded-xl bg-rose-100 text-rose-700 flex items-center justify-center mx-auto">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <h1 className="text-lg font-bold text-rose-950">
              {errorState.status === 429
                ? 'Rate Limit Reached'
                : 'Unable to Load Public Record'}
            </h1>
            <p className="text-xs text-rose-800 max-w-md mx-auto">{errorState.message}</p>
            <div className="flex justify-center gap-3 pt-1">
              <Button variant="primary" size="sm" icon={RefreshCw} onClick={loadDetail}>
                Retry
              </Button>
              <Link to={backToExplorerPath}>
                <Button variant="outline" size="sm">
                  Back to complaints
                </Button>
              </Link>
            </div>
          </div>
        )}

        {/* Loaded Public Record (Strict allow-list: title, category, ward, status + explanation, submitted_date, public_reference ONLY) */}
        {!loading && !notFound && !errorState && complaint && (
          <article className="bg-white rounded-2xl border border-slate-200/90 shadow-2xs overflow-hidden">
            <div className="bg-slate-900 text-white px-6 py-5 sm:px-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="space-y-1">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-teal-300">
                  Public Civic Record
                </span>
                <h1 className="text-xl sm:text-2xl font-bold tracking-tight">
                  {complaint.title}
                </h1>
              </div>
              <div className="shrink-0">
                <StatusBadge status={complaint.status} size="md" />
              </div>
            </div>

            <div className="p-6 sm:p-8 space-y-6">
              {/* Plain-language Status Explanation */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-teal-700 shrink-0 mt-0.5" />
                <div>
                  <h2 className="text-xs font-semibold text-slate-900 uppercase tracking-wider">
                    Current Public Status
                  </h2>
                  <p className="text-sm text-slate-700 mt-1">
                    {getPublicStatusDescription(complaint.status)}
                  </p>
                </div>
              </div>

              {/* Allow-listed Metadata Grid (No coordinates, no images, no descriptions, no officer/department/deadline) */}
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="border border-slate-200 rounded-xl p-4">
                  <dt className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    <Tag className="w-3.5 h-3.5 text-slate-400" />
                    <span>Category</span>
                  </dt>
                  <dd className="mt-1.5 text-sm font-semibold text-slate-900">
                    {getCategoryLabel(complaint.category)}
                  </dd>
                </div>

                <div className="border border-slate-200 rounded-xl p-4">
                  <dt className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    <MapPin className="w-3.5 h-3.5 text-slate-400" />
                    <span>Area / Ward</span>
                  </dt>
                  <dd className="mt-1.5 text-sm font-semibold text-slate-900">
                    {complaint.ward || 'Unspecified'}
                  </dd>
                </div>

                <div className="border border-slate-200 rounded-xl p-4">
                  <dt className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    <Calendar className="w-3.5 h-3.5 text-slate-400" />
                    <span>Submission Date</span>
                  </dt>
                  <dd className="mt-1.5 text-sm font-semibold text-slate-900">
                    {formatDate(complaint.submitted_date)}
                  </dd>
                </div>

                <div className="border border-slate-200 rounded-xl p-4">
                  <dt className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    Public Reference
                  </dt>
                  <dd className="mt-1.5 text-xs font-mono font-semibold text-slate-800 break-all">
                    {complaint.public_reference}
                  </dd>
                </div>
              </dl>

              {/* Share / Copy Link Bar */}
              <div className="pt-4 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleCopyLink}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-900 cursor-pointer transition-colors"
                  >
                    {copyStatus === 'copied' ? (
                      <Check className="w-4 h-4 text-emerald-600" />
                    ) : (
                      <Copy className="w-4 h-4 text-slate-500" />
                    )}
                    <span>Copy link</span>
                  </button>

                  {copyStatus === 'copied' && (
                    <span
                      role="status"
                      className="text-xs font-semibold text-emerald-700"
                    >
                      Link copied to clipboard
                    </span>
                  )}
                  {copyStatus === 'failed' && (
                    <span
                      role="alert"
                      className="text-xs font-semibold text-rose-700"
                    >
                      Could not copy link automatically. Please copy the URL from your address bar.
                    </span>
                  )}
                </div>

                <Link
                  to={backToExplorerPath}
                  className="text-xs font-semibold text-teal-700 hover:text-teal-800 underline"
                >
                  Browse more public complaints
                </Link>
              </div>

              {/* Public Reference & Privacy Note */}
              <div className="bg-slate-100 border border-slate-200 rounded-xl p-3.5 flex items-start gap-2.5 text-xs text-slate-700">
                <Info className="w-4 h-4 text-slate-600 shrink-0 mt-0.5" />
                <p>
                  This public reference is a shareable public link identifier, not a secret credential. Personal details, internal notes, and private records are never shown on public pages.
                </p>
              </div>
            </div>
          </article>
        )}
      </div>
    </div>
  );
}
