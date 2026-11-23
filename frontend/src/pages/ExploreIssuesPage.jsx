import React, { useState, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Filter, RefreshCw, AlertCircle, Layers } from 'lucide-react';
import SearchBar from '../components/common/SearchBar';
import FilterDropdown from '../components/issues/FilterDropdown';
import IssueCard from '../components/issues/IssueCard';
import Button from '../components/common/Button';
import { ISSUE_CATEGORIES, WARDS } from '../data/categories';
import { useComplaints } from '../context/ComplaintContext';

export default function ExploreIssuesPage() {
  const { complaints } = useComplaints();
  const [searchParams, setSearchParams] = useSearchParams();

  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState(searchParams.get('category') || 'all');
  const [selectedStatus, setSelectedStatus] = useState('all');
  const [selectedWard, setSelectedWard] = useState('all');
  const [sortBy, setSortBy] = useState('newest');

  useEffect(() => {
    const cat = searchParams.get('category');
    if (cat) {
      setSelectedCategory(cat);
    }
  }, [searchParams]);

  const handleCategoryChange = (catId) => {
    setSelectedCategory(catId);
    if (catId === 'all') {
      searchParams.delete('category');
      setSearchParams(searchParams);
    } else {
      setSearchParams({ category: catId });
    }
  };

  const clearAllFilters = () => {
    setSearchTerm('');
    setSelectedCategory('all');
    setSelectedStatus('all');
    setSelectedWard('all');
    setSortBy('newest');
    setSearchParams({});
  };

  const filteredComplaints = useMemo(() => {
    return complaints.filter((item) => {
      // Search
      const searchLower = searchTerm.toLowerCase().trim();
      const matchesSearch =
        !searchLower ||
        item.title.toLowerCase().includes(searchLower) ||
        item.id.toLowerCase().includes(searchLower) ||
        item.location.toLowerCase().includes(searchLower) ||
        item.description.toLowerCase().includes(searchLower);

      // Category
      const matchesCategory =
        selectedCategory === 'all' || item.category === selectedCategory;

      // Status
      const matchesStatus =
        selectedStatus === 'all' || item.status.toLowerCase() === selectedStatus.toLowerCase();

      // Ward
      const matchesWard =
        selectedWard === 'all' || item.ward === selectedWard;

      return matchesSearch && matchesCategory && matchesStatus && matchesWard;
    }).sort((a, b) => {
      if (sortBy === 'newest') {
        return new Date(b.reportedDate) - new Date(a.reportedDate);
      } else if (sortBy === 'oldest') {
        return new Date(a.reportedDate) - new Date(b.reportedDate);
      }
      return 0;
    });
  }, [complaints, searchTerm, selectedCategory, selectedStatus, selectedWard, sortBy]);

  const statusOptions = [
    { value: 'all', label: 'All Statuses' },
    { value: 'pending', label: 'Pending' },
    { value: 'in progress', label: 'In Progress' },
    { value: 'resolved', label: 'Resolved' },
  ];

  const wardOptions = [
    { value: 'all', label: 'All Wards' },
    ...WARDS.map((w) => ({ value: w, label: w })),
  ];

  const sortOptions = [
    { value: 'newest', label: 'Newest First' },
    { value: 'oldest', label: 'Oldest First' },
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 lg:py-16">
      
      {/* Header */}
      <div className="max-w-3xl mb-8">
        <span className="text-xs font-semibold text-blue-600 uppercase tracking-wider">
          Public Grievance Registry
        </span>
        <h1 className="text-3xl sm:text-4xl font-extrabold text-slate-900 tracking-tight mt-1">
          Explore Reported Issues
        </h1>
        <p className="text-sm text-slate-600 mt-2">
          Monitor civic grievances reported by citizens across your city. Track repair progress, review assigned municipal divisions, and verify completions.
        </p>
      </div>

      {/* Search and Filters Bar */}
      <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 shadow-2xs mb-8 space-y-4">
        
        {/* Top Search Line */}
        <div className="flex flex-col md:flex-row gap-3 items-center">
          <SearchBar
            value={searchTerm}
            onChange={setSearchTerm}
            placeholder="Search by title, location, landmark, or Complaint ID (e.g. RU-2026-1042)..."
          />
          <div className="flex items-center gap-2 w-full md:w-auto shrink-0">
            <FilterDropdown
              value={selectedStatus}
              onChange={setSelectedStatus}
              options={statusOptions}
              className="w-1/2 md:w-40"
            />
            <FilterDropdown
              value={selectedWard}
              onChange={setSelectedWard}
              options={wardOptions}
              className="w-1/2 md:w-48"
            />
            <FilterDropdown
              value={sortBy}
              onChange={setSortBy}
              options={sortOptions}
              className="hidden sm:block w-36"
            />
          </div>
        </div>

        {/* Category Pills Line */}
        <div className="pt-2 border-t border-slate-100 flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
          <button
            type="button"
            onClick={() => handleCategoryChange('all')}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-colors ${
              selectedCategory === 'all'
                ? 'bg-blue-600 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            All Categories ({complaints.length})
          </button>
          {ISSUE_CATEGORIES.map((cat) => {
            const count = complaints.filter((c) => c.category === cat.id).length;
            const isSelected = selectedCategory === cat.id;
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => handleCategoryChange(cat.id)}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-colors ${
                  isSelected
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {cat.name} ({count})
              </button>
            );
          })}
        </div>

      </div>

      {/* Results Header */}
      <div className="flex items-center justify-between mb-6">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
          Showing {filteredComplaints.length} {filteredComplaints.length === 1 ? 'Complaint' : 'Complaints'}
        </p>
        {(searchTerm || selectedCategory !== 'all' || selectedStatus !== 'all' || selectedWard !== 'all') && (
          <button
            type="button"
            onClick={clearAllFilters}
            className="text-xs text-blue-600 hover:text-blue-800 font-semibold inline-flex items-center gap-1"
          >
            <RefreshCw className="w-3 h-3" /> Reset Filters
          </button>
        )}
      </div>

      {/* Grid of Issues */}
      {filteredComplaints.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredComplaints.map((complaint) => (
            <IssueCard key={complaint.id} complaint={complaint} />
          ))}
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center max-w-lg mx-auto shadow-2xs">
          <div className="w-12 h-12 rounded-xl bg-slate-100 text-slate-400 flex items-center justify-center mx-auto mb-4">
            <Layers className="w-6 h-6" />
          </div>
          <h3 className="text-base font-bold text-slate-900 mb-1">
            No complaints match your criteria
          </h3>
          <p className="text-xs text-slate-500 mb-6 leading-relaxed">
            Try adjusting your search terms, changing the ward selector, or resetting category filters.
          </p>
          <Button variant="primary" size="sm" onClick={clearAllFilters}>
            Clear All Filters
          </Button>
        </div>
      )}

    </div>
  );
}
