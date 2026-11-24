import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Upload,
  X,
  CheckCircle,
  AlertCircle,
  MapPin,
  Building,
  Image as ImageIcon,
  FileText,
  Lock,
  PlusCircle,
  ArrowLeft,
  RefreshCw,
  UserX,
} from 'lucide-react';
import Button from '../common/Button';
import LocationPickerMap from '../maps/LocationPickerMap';
import { ISSUE_CATEGORIES, WARDS } from '../../data/categories';
import { useAuth } from '../../context/AuthContext';
import { createComplaint, UUID_V4_REGEX } from '../../services/complaintService';

const PENDING_SUBMISSION_KEY = 'reportly_pending_submission';

function loadPendingSubmission() {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return null;

    const stored = window.sessionStorage.getItem(PENDING_SUBMISSION_KEY);
    if (!stored) return null;

    const parsed = JSON.parse(stored);
    if (
      parsed &&
      typeof parsed.idempotencyKey === 'string' &&
      UUID_V4_REGEX.test(parsed.idempotencyKey) &&
      typeof parsed.citizenId === 'string' &&
      parsed.payload &&
      typeof parsed.payload.title === 'string' &&
      typeof parsed.payload.category === 'string' &&
      typeof parsed.payload.ward === 'string' &&
      typeof parsed.payload.location === 'string' &&
      typeof parsed.payload.description === 'string'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function savePendingSubmission(pending) {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return false;

    const serialized = JSON.stringify(pending);
    window.sessionStorage.setItem(PENDING_SUBMISSION_KEY, serialized);

    const check = window.sessionStorage.getItem(PENDING_SUBMISSION_KEY);
    return check === serialized;
  } catch {
    return false;
  }
}

function clearPendingSubmission() {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      window.sessionStorage.removeItem(PENDING_SUBMISSION_KEY);
    }
  } catch {
    // Safe to ignore
  }
}

export default function ReportForm() {
  const { isAuthenticated, user } = useAuth();
  const navigate = useNavigate();

  const submissionLockRef = useRef(false);

  // Synchronous lazy state restoration from sessionStorage
  const [pendingSubmission, setPendingSubmission] = useState(() => loadPendingSubmission());

  const [formData, setFormData] = useState(() => {
    const restored = loadPendingSubmission();
    if (restored?.payload) {
      return {
        title: restored.payload.title || '',
        category: restored.payload.category || '',
        description: restored.payload.description || '',
        location: restored.payload.location || '',
        ward: restored.payload.ward || '',
        latitude: typeof restored.payload.latitude === 'number' ? restored.payload.latitude : null,
        longitude: typeof restored.payload.longitude === 'number' ? restored.payload.longitude : null,
        imagePreview: '',
        imageFileName: restored.storagePath ? restored.storagePath.split('/').pop() : '',
      };
    }
    return {
      title: '',
      category: '',
      description: '',
      location: '',
      ward: '',
      latitude: null,
      longitude: null,
      imagePreview: '',
      imageFileName: '',
    };
  });

  const [selectedFile, setSelectedFile] = useState(null);
  const [uploadedStoragePath, setUploadedStoragePath] = useState(() => {
    const restored = loadPendingSubmission();
    return restored?.storagePath || null;
  });

  const [errors, setErrors] = useState({});
  const [submissionError, setSubmissionError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createdComplaint, setCreatedComplaint] = useState(null);

  // Determine if a pending submission belongs to a different citizen account
  const isAccountMismatch = Boolean(
    pendingSubmission && (!user?.id || user.id !== pendingSubmission.citizenId)
  );

  // Form remains locked whenever an unresolved submission is pending
  const isFormLocked = pendingSubmission !== null;

  // Never delete unresolved pending submission data during logout or account switching.
  // Preserve it in sessionStorage and UI state, but inform the user if mismatched.
  useEffect(() => {
    if (pendingSubmission && (!user?.id || user.id !== pendingSubmission.citizenId)) {
      setSubmissionError(
        'A pending submission exists for a different citizen account. Submission data is preserved, but retries are blocked until the original citizen signs in.'
      );
    } else if (pendingSubmission && user?.id === pendingSubmission.citizenId) {
      setSubmissionError(null);
    }
  }, [user?.id, pendingSubmission]);

  const validate = () => {
    const newErrors = {};

    if (!isAuthenticated) {
      newErrors.auth = 'You must be signed in as an authenticated citizen to submit a complaint.';
    }

    if (!formData.title.trim()) {
      newErrors.title = 'Please provide a clear title for the issue.';
    } else if (formData.title.trim().length < 5) {
      newErrors.title = 'Title should be at least 5 characters.';
    }

    if (!formData.category) {
      newErrors.category = 'Please select a civic category.';
    }

    if (!formData.ward) {
      newErrors.ward = 'Please specify the affected municipal ward.';
    }

    if (!formData.location.trim()) {
      newErrors.location = 'Specific street address or landmark is required.';
    }

    if (!formData.description.trim()) {
      newErrors.description = 'Please describe the problem and its impact on the locality.';
    } else if (formData.description.trim().length < 15) {
      newErrors.description = 'Description should be at least 15 characters.';
    }

    if (!selectedFile && !uploadedStoragePath) {
      newErrors.image = 'A clear photograph of the issue is required for verification.';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleImageChange = (e) => {
    if (isFormLocked) return;

    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 8 * 1024 * 1024) {
        setErrors((prev) => ({ ...prev, image: 'Image size should not exceed 8MB.' }));
        return;
      }

      const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
      if (!allowedTypes.includes(file.type)) {
        setErrors((prev) => ({
          ...prev,
          image: 'Unsupported format. Only JPG, PNG, and WebP images are allowed.',
        }));
        return;
      }

      setSelectedFile(file);
      setUploadedStoragePath(null);

      const reader = new FileReader();
      reader.onloadend = () => {
        setFormData((prev) => ({
          ...prev,
          imagePreview: reader.result,
          imageFileName: file.name,
        }));
        setErrors((prev) => ({ ...prev, image: null }));
      };
      reader.readAsDataURL(file);
    }
  };

  const removeImage = () => {
    if (isFormLocked) return;

    setSelectedFile(null);
    setUploadedStoragePath(null);
    setFormData((prev) => ({
      ...prev,
      imagePreview: '',
      imageFileName: '',
    }));
  };

  const handleFieldChange = (field, value) => {
    if (isFormLocked) return;
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (submissionLockRef.current) return;
    submissionLockRef.current = true;

    setSubmissionError(null);

    // Synchronous Identity Check: Never allow submission/retry if user ID does not match citizenId
    if (pendingSubmission && (!user?.id || user.id !== pendingSubmission.citizenId)) {
      setSubmissionError(
        'Security Block: The pending submission belongs to a different citizen account. Please sign in as the original citizen to retry or verify this complaint.'
      );
      submissionLockRef.current = false;
      return;
    }

    let submissionKey;
    let submissionPayload;
    let submissionStoragePath;
    let submissionFile;

    try {
      if (pendingSubmission) {
        // Retry path uses immutable snapshot with exact matched citizenId
        submissionKey = pendingSubmission.idempotencyKey;
        submissionPayload = pendingSubmission.payload;
        submissionStoragePath = pendingSubmission.storagePath;
        submissionFile = null;
      } else {
        if (!validate()) {
          submissionLockRef.current = false;
          return;
        }

        if (!user?.id) {
          setSubmissionError('Authentication session not ready. Please sign in again.');
          submissionLockRef.current = false;
          return;
        }

        submissionKey = crypto.randomUUID();
        submissionPayload = {
          title: formData.title.trim(),
          category: formData.category,
          ward: formData.ward.trim(),
          location: formData.location.trim(),
          description: formData.description.trim(),
          latitude: typeof formData.latitude === 'number' ? formData.latitude : null,
          longitude: typeof formData.longitude === 'number' ? formData.longitude : null,
        };
        submissionStoragePath = uploadedStoragePath;
        submissionFile = selectedFile;

        // Persist before any network operation
        const initialPending = {
          idempotencyKey: submissionKey,
          citizenId: user.id,
          payload: submissionPayload,
          storagePath: submissionStoragePath || null,
        };

        const persisted = savePendingSubmission(initialPending);
        if (!persisted) {
          setSubmissionError(
            'Unable to safely persist submission recovery state in your browser. Database submission aborted to prevent unrecoverable requests.'
          );
          submissionLockRef.current = false;
          return;
        }

        setPendingSubmission(initialPending);
      }

      setIsSubmitting(true);

      const result = await createComplaint({
        title: submissionPayload.title,
        category: submissionPayload.category,
        ward: submissionPayload.ward,
        location: submissionPayload.location,
        description: submissionPayload.description,
        latitude: submissionPayload.latitude,
        longitude: submissionPayload.longitude,
        file: submissionFile,
        uploadedStoragePath: submissionStoragePath,
        idempotencyKey: submissionKey,
        onStorageUploaded: async (newPath) => {
          const updatedPending = {
            idempotencyKey: submissionKey,
            citizenId: user.id,
            payload: submissionPayload,
            storagePath: newPath,
          };
          const ok = savePendingSubmission(updatedPending);
          if (!ok) {
            throw new Error(
              'Failed to persist uploaded storage path in browser recovery storage before database submission.'
            );
          }
          setPendingSubmission(updatedPending);
          setUploadedStoragePath(newPath);
          return true;
        },
      });

      // Confirmed success
      if (result.data) {
        clearPendingSubmission();
        setPendingSubmission(null);
        setCreatedComplaint(result.data);
        return;
      }

      // Unresolved outcome
      if (result.isUnresolved) {
        const activePath = result.orphanedStoragePath || submissionStoragePath;
        const currentPending = {
          idempotencyKey: submissionKey,
          citizenId: user.id,
          payload: submissionPayload,
          storagePath: activePath,
        };
        savePendingSubmission(currentPending);
        setPendingSubmission(currentPending);
        if (activePath) setUploadedStoragePath(activePath);
        setSubmissionError(
          result.error?.message ||
            'Submission outcome uncertain. Your complaint may be registered. Please retry to verify.'
        );
        return;
      }

      // Definitive failure
      clearPendingSubmission();
      setPendingSubmission(null);
      if (result.orphanedStoragePath) {
        setUploadedStoragePath(result.orphanedStoragePath);
      }
      setSubmissionError(
        result.error?.message || 'Database registration failed. Please review your details and retry.'
      );
    } catch (err) {
      setSubmissionError(
        err instanceof Error ? err.message : 'An unexpected error occurred during submission.'
      );
    } finally {
      setIsSubmitting(false);
      submissionLockRef.current = false;
    }
  };

  const handleResetForm = () => {
    clearPendingSubmission();
    setPendingSubmission(null);
    setFormData({
      title: '',
      category: '',
      description: '',
      location: '',
      ward: '',
      latitude: null,
      longitude: null,
      imagePreview: '',
      imageFileName: '',
    });
    setSelectedFile(null);
    setUploadedStoragePath(null);
    setErrors({});
    setSubmissionError(null);
    setCreatedComplaint(null);
  };

  if (createdComplaint) {
    const matchedCategory = ISSUE_CATEGORIES.find((c) => c.id === createdComplaint.category);
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-8 shadow-sm text-center max-w-xl mx-auto animate-in fade-in zoom-in duration-200">
        <div className="w-16 h-16 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mx-auto mb-5 shadow-xs">
          <CheckCircle className="w-8 h-8" />
        </div>

        <span className="text-xs font-semibold uppercase tracking-wider text-emerald-700 bg-emerald-50 px-3 py-1 rounded-full border border-emerald-200">
          ReportlyUrban System
        </span>

        <h3 className="text-2xl font-extrabold text-slate-900 mt-3 mb-2">
          Complaint Registered Successfully
        </h3>

        <p className="text-sm text-slate-600 mb-6 leading-relaxed">
          Your civic issue has been saved to the ReportlyUrban system and is awaiting municipal review.
        </p>

        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 mb-6 text-left space-y-2.5">
          <div className="flex justify-between items-center text-xs">
            <span className="text-slate-500">Complaint Reference ID:</span>
            <span className="font-mono font-bold text-blue-600 text-sm tracking-wide">
              {createdComplaint.complaint_number}
            </span>
          </div>
          <div className="flex justify-between items-center text-xs">
            <span className="text-slate-500">Status:</span>
            <span className="font-semibold text-amber-700">
              Awaiting municipal review
            </span>
          </div>
          <div className="flex justify-between items-center text-xs">
            <span className="text-slate-500">Category:</span>
            <span className="font-medium text-slate-800">
              {matchedCategory?.name || createdComplaint.category}
            </span>
          </div>
          <div className="flex justify-between items-center text-xs">
            <span className="text-slate-500">Department:</span>
            <span className="font-medium text-slate-500 italic">
              Not yet assigned
            </span>
          </div>
          <div className="flex justify-between items-center text-xs">
            <span className="text-slate-500">Ward:</span>
            <span className="font-medium text-slate-800">{createdComplaint.ward}</span>
          </div>
          {createdComplaint.latitude != null && createdComplaint.longitude != null && (
            <div className="flex justify-between items-center text-xs">
              <span className="text-slate-500">Geospatial Coordinates:</span>
              <span className="font-mono text-slate-700">
                {Number(createdComplaint.latitude).toFixed(5)}, {Number(createdComplaint.longitude).toFixed(5)}
              </span>
            </div>
          )}
          <div className="flex justify-between items-center text-xs">
            <span className="text-slate-500">Registered At:</span>
            <span className="font-medium text-slate-800">
              {new Date(createdComplaint.created_at).toLocaleString('en-IN', {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </span>
          </div>
        </div>

        <div className="p-3.5 bg-blue-50 border border-blue-200 rounded-xl text-blue-900 text-xs text-left mb-6 leading-relaxed flex items-start gap-2.5">
          <CheckCircle className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
          <span>
            <strong>System Notice:</strong> Your complaint details and photograph are securely recorded under reference <strong>{createdComplaint.complaint_number}</strong>. Live timeline tracking and municipal dashboards will connect in upcoming platform phases.
          </span>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Button
            variant="primary"
            size="md"
            className="flex items-center justify-center gap-1.5"
            onClick={handleResetForm}
          >
            <PlusCircle className="w-4 h-4" />
            File Another Complaint
          </Button>
          <Button
            variant="outline"
            size="md"
            className="flex items-center justify-center gap-1.5"
            onClick={() => navigate('/')}
          >
            <ArrowLeft className="w-4 h-4" />
            Return to Home
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 shadow-xs">
      {!isAuthenticated && (
        <div className="mb-6 p-4 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-3">
          <Lock className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="text-xs text-amber-800">
            <span className="font-bold">Citizen Authentication Required:</span> You are currently viewing this form as a guest. Please sign in or register with your citizen account using the <strong>Sign In</strong> button in the top navigation bar to submit a complaint.
          </div>
        </div>
      )}

      {/* Account Mismatch Notice */}
      {isAccountMismatch && (
        <div className="mb-6 p-4 rounded-xl bg-rose-50 border border-rose-300 flex items-start gap-3">
          <UserX className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
          <div className="text-xs text-rose-900 leading-relaxed">
            <span className="font-bold">Account Mismatch Warning:</span> An unresolved submission is preserved in this browser for a different citizen account. Retries and modifications are blocked until the original citizen account signs in.
          </div>
        </div>
      )}

      {/* Unresolved Submission Banner */}
      {isFormLocked && !isAccountMismatch && (
        <div className="mb-6 p-4 rounded-xl bg-amber-50 border border-amber-300 flex items-start gap-3">
          <RefreshCw className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="text-xs text-amber-900">
            <span className="font-bold">Pending Submission Verification:</span> A previous submission is awaiting confirmation. Your complaint data and photograph are securely preserved. Click <strong>Retry Pending Submission</strong> below to verify its status. Do not close this tab or alter your details.
          </div>
        </div>
      )}

      {/* Submission Error Banner */}
      {submissionError && (
        <div className="mb-6 p-4 rounded-xl bg-rose-50 border border-rose-200 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
          <div className="text-xs text-rose-800">
            <span className="font-bold">Submission Notice:</span> {submissionError}
            {uploadedStoragePath && !isFormLocked && (
              <p className="mt-1 text-[11px] text-slate-600">
                (Your photographic evidence was uploaded securely. Clicking submit again will reuse it without re-uploading).
              </p>
            )}
          </div>
        </div>
      )}

      {errors.auth && (
        <p className="mb-4 text-xs font-semibold text-rose-600 flex items-center gap-1.5">
          <AlertCircle className="w-4 h-4" /> {errors.auth}
        </p>
      )}

      <div className="space-y-6">
        <div>
          <label className="block text-sm font-semibold text-slate-800 mb-1.5">
            Issue Title <span className="text-rose-500">*</span>
          </label>
          <input
            type="text"
            disabled={isSubmitting || isFormLocked}
            value={formData.title}
            onChange={(e) => handleFieldChange('title', e.target.value)}
            placeholder="e.g., Deep pothole causing skidding near Metro Gate 3"
            className={`w-full px-3.5 py-2.5 text-sm bg-white border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all ${
              errors.title ? 'border-rose-400 bg-rose-50/20' : 'border-slate-200'
            } ${isFormLocked ? 'bg-slate-50 text-slate-500 cursor-not-allowed' : ''}`}
          />
          {errors.title && (
            <p className="mt-1 text-xs text-rose-500 flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" /> {errors.title}
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div>
            <label className="block text-sm font-semibold text-slate-800 mb-1.5">
              Civic Category <span className="text-rose-500">*</span>
            </label>
            <select
              disabled={isSubmitting || isFormLocked}
              value={formData.category}
              onChange={(e) => handleFieldChange('category', e.target.value)}
              className={`w-full px-3.5 py-2.5 text-sm bg-white border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all cursor-pointer ${
                errors.category ? 'border-rose-400 bg-rose-50/20' : 'border-slate-200'
              } ${isFormLocked ? 'bg-slate-50 text-slate-500 cursor-not-allowed' : ''}`}
            >
              <option value="">Select Category</option>
              {ISSUE_CATEGORIES.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
            </select>
            {errors.category && (
              <p className="mt-1 text-xs text-rose-500 flex items-center gap-1">
                <AlertCircle className="w-3.5 h-3.5" /> {errors.category}
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-800 mb-1.5">
              Municipal Ward / Area <span className="text-rose-500">*</span>
            </label>
            <select
              disabled={isSubmitting || isFormLocked}
              value={formData.ward}
              onChange={(e) => handleFieldChange('ward', e.target.value)}
              className={`w-full px-3.5 py-2.5 text-sm bg-white border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all cursor-pointer ${
                errors.ward ? 'border-rose-400 bg-rose-50/20' : 'border-slate-200'
              } ${isFormLocked ? 'bg-slate-50 text-slate-500 cursor-not-allowed' : ''}`}
            >
              <option value="">Select Ward</option>
              {WARDS.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
            {errors.ward && (
              <p className="mt-1 text-xs text-rose-500 flex items-center gap-1">
                <AlertCircle className="w-3.5 h-3.5" /> {errors.ward}
              </p>
            )}
          </div>
        </div>

        <div>
          <label className="block text-sm font-semibold text-slate-800 mb-1">
            Pin Location on Map (Optional GPS / Search)
          </label>
          <p className="text-xs text-slate-500 mb-2.5">
            Pin the issue on the interactive map or use GPS detection to record precise coordinates for field workers.
          </p>
          <div className="mb-4">
            <LocationPickerMap
              coordinates={
                formData.latitude != null && formData.longitude != null
                  ? { latitude: formData.latitude, longitude: formData.longitude }
                  : null
              }
              initialAddress={formData.location}
              disabled={isSubmitting || isFormLocked}
              onLocationSelect={({ latitude, longitude, address }) => {
                setFormData((prev) => ({
                  ...prev,
                  latitude,
                  longitude,
                  location: prev.location.trim() ? prev.location : (address || prev.location),
                }));
                if (address && !formData.location.trim()) {
                  setErrors((prev) => ({ ...prev, location: null }));
                }
              }}
            />
          </div>

          <label className="block text-sm font-semibold text-slate-800 mb-1.5">
            Exact Location or Landmark <span className="text-rose-500">*</span>
          </label>
          <div className="relative">
            <MapPin className="absolute left-3.5 top-3 w-4 h-4 text-slate-400" />
            <input
              type="text"
              disabled={isSubmitting || isFormLocked}
              value={formData.location}
              onChange={(e) => handleFieldChange('location', e.target.value)}
              placeholder="e.g., 4th Cross Road, opposite Community Hall"
              className={`w-full pl-10 pr-3.5 py-2.5 text-sm bg-white border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all ${
                errors.location ? 'border-rose-400 bg-rose-50/20' : 'border-slate-200'
              } ${isFormLocked ? 'bg-slate-50 text-slate-500 cursor-not-allowed' : ''}`}
            />
          </div>
          {errors.location && (
            <p className="mt-1 text-xs text-rose-500 flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" /> {errors.location}
            </p>
          )}
        </div>

        <div>
          <label className="block text-sm font-semibold text-slate-800 mb-1.5">
            Detailed Description <span className="text-rose-500">*</span>
          </label>
          <textarea
            rows={4}
            disabled={isSubmitting || isFormLocked}
            value={formData.description}
            onChange={(e) => handleFieldChange('description', e.target.value)}
            placeholder="Describe the severity, how long this issue has persisted, and any safety hazards..."
            className={`w-full px-3.5 py-2.5 text-sm bg-white border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all ${
              errors.description ? 'border-rose-400 bg-rose-50/20' : 'border-slate-200'
            } ${isFormLocked ? 'bg-slate-50 text-slate-500 cursor-not-allowed' : ''}`}
          />
          {errors.description && (
            <p className="mt-1 text-xs text-rose-500 flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" /> {errors.description}
            </p>
          )}
        </div>

        <div>
          <label className="block text-sm font-semibold text-slate-800 mb-1.5">
            Attach Photograph <span className="text-rose-500">*</span>
          </label>

          {formData.imagePreview || (isFormLocked && uploadedStoragePath) ? (
            <div className="relative rounded-xl border border-slate-200 overflow-hidden bg-slate-50 p-2 flex items-center gap-4">
              {formData.imagePreview ? (
                <img
                  src={formData.imagePreview}
                  alt="Selected preview"
                  className="w-24 h-20 object-cover rounded-lg border border-slate-200"
                />
              ) : (
                <div className="w-24 h-20 rounded-lg border border-slate-200 bg-slate-100 flex items-center justify-center">
                  <ImageIcon className="w-8 h-8 text-slate-300" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-slate-800 truncate">
                  {formData.imageFileName || 'Previously uploaded photograph'}
                </p>
                <p className="text-[11px] text-emerald-600 mt-0.5">
                  {uploadedStoragePath ? 'Securely stored — Ready for submission' : 'Ready for upload'}
                </p>
              </div>
              {!isFormLocked && (
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={removeImage}
                  className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-slate-200 rounded-lg transition-colors mr-2 disabled:opacity-50"
                  title="Remove photo"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          ) : (
            <label
              className={`border-2 border-dashed border-slate-200 hover:border-blue-400 bg-slate-50/50 hover:bg-blue-50/30 rounded-xl p-6 flex flex-col items-center justify-center transition-colors ${
                isFormLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
              }`}
            >
              <div className="w-10 h-10 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center mb-2">
                <Upload className="w-5 h-5" />
              </div>
              <span className="text-xs font-semibold text-slate-700">Click to upload photo or drag & drop</span>
              <span className="text-[11px] text-slate-400 mt-1">PNG, JPG, or WEBP up to 8MB (Required)</span>
              <input
                type="file"
                disabled={isSubmitting || isFormLocked}
                accept="image/jpeg,image/png,image/webp"
                onChange={handleImageChange}
                className="hidden"
              />
            </label>
          )}
          {errors.image && (
            <p className="mt-1 text-xs text-rose-500 flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" /> {errors.image}
            </p>
          )}
        </div>

        <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-slate-600 text-xs leading-relaxed">
          <strong>Notice:</strong> Complaints submitted here are recorded in the ReportlyUrban civic database.
        </div>

        <div className="pt-2">
          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="w-full flex items-center justify-center gap-2"
            disabled={isSubmitting || isAccountMismatch}
          >
            {isSubmitting ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                <span>
                  {isFormLocked
                    ? 'Verifying Pending Submission...'
                    : 'Registering Complaint in ReportlyUrban...'}
                </span>
              </>
            ) : isAccountMismatch ? (
              <>
                <UserX className="w-4 h-4" />
                Pending for Another Citizen
              </>
            ) : isFormLocked ? (
              <>
                <RefreshCw className="w-4 h-4" />
                Retry Pending Submission
              </>
            ) : (
              'Submit Grievance Report'
            )}
          </Button>
        </div>
      </div>
    </form>
  );
}