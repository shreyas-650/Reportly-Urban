import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Clock, Send } from 'lucide-react';
import {
  fetchCitizenReviewAppealStatus,
  submitCitizenReviewAppeal,
} from '../../services/slaApiService';

export default function CitizenReviewAppealCard({
  complaintId,
  api = null,
}) {
  const fetchStatusFn = api?.fetchStatus || fetchCitizenReviewAppealStatus;
  const submitFn = api?.submitAppeal || submitCitizenReviewAppeal;

  const [statusData, setStatusData] = useState(null);
  const [appealText, setAppealText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [submittedNotice, setSubmittedNotice] = useState(false);

  const loadStatus = useCallback(async () => {
    if (!complaintId) return;
    try {
      const res = await fetchStatusFn(complaintId);
      setStatusData(res);
    } catch {
      setStatusData(null);
    }
  }, [complaintId, fetchStatusFn]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  if (!statusData) {
    return null;
  }

  const { eligible, has_open_appeal, appeal_status } = statusData;

  if (!eligible && !has_open_appeal && appeal_status !== 'reviewed') {
    return null;
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    const cleaned = appealText.trim();
    if (cleaned.length < 10) {
      setSubmitError('Please write at least 10 characters explaining why you are requesting a manual review.');
      return;
    }
    if (cleaned.length > 500) {
      setSubmitError('Review request message cannot exceed 500 characters.');
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      await submitFn(complaintId, cleaned);
      setSubmittedNotice(true);
      setAppealText('');
      await loadStatus();
    } catch (err) {
      setSubmitError(err?.message || 'Unable to submit review request right now.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section
      aria-label="Administrative Review Request"
      className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs space-y-3 text-xs"
    >
      <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
        <Clock className="w-4 h-4 text-blue-600" />
        Administrative Review Request
      </h3>

      {has_open_appeal || submittedNotice ? (
        <div role="status" className="p-3.5 rounded-xl bg-blue-50 border border-blue-200 text-blue-900 flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
          <span>
            Your review request has been logged and is awaiting municipal staff review.
          </span>
        </div>
      ) : eligible ? (
        <form onSubmit={handleSubmit} className="space-y-3">
          <p className="text-slate-600 leading-relaxed">
            If your submitted report has been awaiting initial review longer than expected, you may submit a brief note for municipal staff.
          </p>

          {submitError && (
            <div role="alert" className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{submitError}</span>
            </div>
          )}

          <div>
            <label htmlFor="citizen-review-appeal-text" className="block font-semibold text-slate-700 mb-1">
              Review Note (10 to 500 characters)
            </label>
            <textarea
              id="citizen-review-appeal-text"
              value={appealText}
              onChange={(e) => setAppealText(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="Provide any context for staff reviewing your pending submission..."
              className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 focus:bg-white text-slate-900"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold disabled:opacity-50 transition"
          >
            <Send className="w-3.5 h-3.5" />
            {submitting ? 'Submitting...' : 'Request Review'}
          </button>
        </form>
      ) : (
        <p className="text-slate-500">
          Your prior review request has been recorded by municipal staff.
        </p>
      )}
    </section>
  );
}
