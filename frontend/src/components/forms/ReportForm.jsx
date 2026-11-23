import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, X, CheckCircle, AlertCircle, MapPin, Building, Image as ImageIcon, FileText } from 'lucide-react';
import Button from '../common/Button';
import { ISSUE_CATEGORIES, WARDS } from '../../data/categories';
import { useComplaints } from '../../context/ComplaintContext';

export default function ReportForm() {
  const { addComplaint } = useComplaints();
  const navigate = useNavigate();

  const [formData, setFormData] = useState({
    title: '',
    category: '',
    description: '',
    location: '',
    ward: '',
    imagePreview: '',
    imageFileName: '',
  });

  const [errors, setErrors] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createdComplaint, setCreatedComplaint] = useState(null);

  const validate = () => {
    const newErrors = {};
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

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleImageChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 8 * 1024 * 1024) {
        setErrors((prev) => ({ ...prev, image: 'Image size should not exceed 8MB.' }));
        return;
      }
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
    setFormData((prev) => ({
      ...prev,
      imagePreview: '',
      imageFileName: '',
    }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!validate()) return;

    setIsSubmitting(true);

    setTimeout(() => {
      const complaint = addComplaint(formData);
      setIsSubmitting(false);
      setCreatedComplaint(complaint);
    }, 600);
  };

  if (createdComplaint) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-8 shadow-sm text-center max-w-xl mx-auto animate-in fade-in zoom-in duration-200">
        <div className="w-16 h-16 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mx-auto mb-5 shadow-xs">
          <CheckCircle className="w-8 h-8" />
        </div>

        <span className="text-xs font-semibold uppercase tracking-wider text-emerald-700 bg-emerald-50 px-3 py-1 rounded-full border border-emerald-200">
          Mock Report Successfully Generated
        </span>

        <h3 className="text-2xl font-extrabold text-slate-900 mt-3 mb-2">
          Grievance Registered
        </h3>

        <p className="text-sm text-slate-600 mb-6 leading-relaxed">
          Your civic issue has been logged into our local demonstration system with the unique tracking reference below.
        </p>

        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 mb-6 text-left space-y-2">
          <div className="flex justify-between items-center text-xs">
            <span className="text-slate-500">Complaint Reference ID:</span>
            <span className="font-mono font-bold text-blue-600 text-sm">{createdComplaint.id}</span>
          </div>
          <div className="flex justify-between items-center text-xs">
            <span className="text-slate-500">Department:</span>
            <span className="font-medium text-slate-800">{createdComplaint.department}</span>
          </div>
          <div className="flex justify-between items-center text-xs">
            <span className="text-slate-500">Ward:</span>
            <span className="font-medium text-slate-800">{createdComplaint.ward}</span>
          </div>
        </div>

        <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-xs text-left mb-6 leading-relaxed">
          <span className="font-semibold">Civic Prototype Notice:</span> This is a frontend demonstration. No physical dispatch order has been sent to the municipal corporation.
        </div>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Button
            variant="primary"
            size="md"
            onClick={() => navigate(`/issues/${createdComplaint.id}`)}
          >
            Track Status Timeline
          </Button>
          <Button
            variant="outline"
            size="md"
            onClick={() => navigate('/dashboard')}
          >
            View in Dashboard
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 shadow-xs">
      <div className="space-y-6">
        
        {/* Issue Title */}
        <div>
          <label className="block text-sm font-semibold text-slate-800 mb-1.5">
            Issue Title <span className="text-rose-500">*</span>
          </label>
          <input
            type="text"
            value={formData.title}
            onChange={(e) => setFormData({ ...formData, title: e.target.value })}
            placeholder="e.g., Deep pothole causing skidding near Metro Gate 3"
            className={`w-full px-3.5 py-2.5 text-sm bg-white border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all ${
              errors.title ? 'border-rose-400 bg-rose-50/20' : 'border-slate-200'
            }`}
          />
          {errors.title && (
            <p className="mt-1 text-xs text-rose-500 flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" /> {errors.title}
            </p>
          )}
        </div>

        {/* Category & Ward selection grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          {/* Category */}
          <div>
            <label className="block text-sm font-semibold text-slate-800 mb-1.5">
              Civic Category <span className="text-rose-500">*</span>
            </label>
            <select
              value={formData.category}
              onChange={(e) => setFormData({ ...formData, category: e.target.value })}
              className={`w-full px-3.5 py-2.5 text-sm bg-white border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all cursor-pointer ${
                errors.category ? 'border-rose-400 bg-rose-50/20' : 'border-slate-200'
              }`}
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

          {/* Ward */}
          <div>
            <label className="block text-sm font-semibold text-slate-800 mb-1.5">
              Municipal Ward / Area <span className="text-rose-500">*</span>
            </label>
            <select
              value={formData.ward}
              onChange={(e) => setFormData({ ...formData, ward: e.target.value })}
              className={`w-full px-3.5 py-2.5 text-sm bg-white border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all cursor-pointer ${
                errors.ward ? 'border-rose-400 bg-rose-50/20' : 'border-slate-200'
              }`}
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

        {/* Location / Address */}
        <div>
          <label className="block text-sm font-semibold text-slate-800 mb-1.5">
            Exact Location or Landmark <span className="text-rose-500">*</span>
          </label>
          <div className="relative">
            <MapPin className="absolute left-3.5 top-3 w-4 h-4 text-slate-400" />
            <input
              type="text"
              value={formData.location}
              onChange={(e) => setFormData({ ...formData, location: e.target.value })}
              placeholder="e.g., 4th Cross Road, opposite Community Hall"
              className={`w-full pl-10 pr-3.5 py-2.5 text-sm bg-white border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all ${
                errors.location ? 'border-rose-400 bg-rose-50/20' : 'border-slate-200'
              }`}
            />
          </div>
          {errors.location && (
            <p className="mt-1 text-xs text-rose-500 flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" /> {errors.location}
            </p>
          )}
        </div>

        {/* Description */}
        <div>
          <label className="block text-sm font-semibold text-slate-800 mb-1.5">
            Detailed Description <span className="text-rose-500">*</span>
          </label>
          <textarea
            rows={4}
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            placeholder="Describe the severity, how long this issue has persisted, and any safety hazards..."
            className={`w-full px-3.5 py-2.5 text-sm bg-white border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all ${
              errors.description ? 'border-rose-400 bg-rose-50/20' : 'border-slate-200'
            }`}
          />
          {errors.description && (
            <p className="mt-1 text-xs text-rose-500 flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" /> {errors.description}
            </p>
          )}
        </div>

        {/* Photo Upload & Preview */}
        <div>
          <label className="block text-sm font-semibold text-slate-800 mb-1.5">
            Attach Photograph <span className="text-xs text-slate-500 font-normal">(Optional for mock report)</span>
          </label>

          {formData.imagePreview ? (
            <div className="relative rounded-xl border border-slate-200 overflow-hidden bg-slate-50 p-2 flex items-center gap-4">
              <img
                src={formData.imagePreview}
                alt="Selected preview"
                className="w-24 h-20 object-cover rounded-lg border border-slate-200"
              />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-slate-800 truncate">
                  {formData.imageFileName || 'Uploaded photograph'}
                </p>
                <p className="text-[11px] text-emerald-600 mt-0.5">Ready for submission</p>
              </div>
              <button
                type="button"
                onClick={removeImage}
                className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-slate-200 rounded-lg transition-colors mr-2"
                title="Remove photo"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <label className="border-2 border-dashed border-slate-200 hover:border-blue-400 bg-slate-50/50 hover:bg-blue-50/30 rounded-xl p-6 flex flex-col items-center justify-center cursor-pointer transition-colors">
              <div className="w-10 h-10 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center mb-2">
                <Upload className="w-5 h-5" />
              </div>
              <span className="text-xs font-semibold text-slate-700">Click to upload photo or drag & drop</span>
              <span className="text-[11px] text-slate-400 mt-1">PNG, JPG, or WEBP up to 8MB</span>
              <input
                type="file"
                accept="image/*"
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

        {/* Disclaimer Note */}
        <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-slate-600 text-xs leading-relaxed">
          <strong>Notice:</strong> Complaints submitted during this phase are stored locally in your browser state for demonstration purposes.
        </div>

        {/* Submit Button */}
        <div className="pt-2">
          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="w-full"
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Registering Grievance...' : 'Submit Grievance Report'}
          </Button>
        </div>

      </div>
    </form>
  );
}
