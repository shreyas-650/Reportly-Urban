import React, { createContext, useContext, useState, useEffect } from 'react';
import { INITIAL_COMPLAINTS } from '../data/mockComplaints';
import { generateComplaintId } from '../utils/formatters';
import { ISSUE_CATEGORIES } from '../data/categories';

const ComplaintContext = createContext(null);
const STORAGE_KEY = 'reportly_urban_complaints';

export function ComplaintProvider({ children }) {
  const [complaints, setComplaints] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (e) {
      console.error('Failed to load complaints from localStorage', e);
    }
    return INITIAL_COMPLAINTS;
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(complaints));
    } catch (e) {
      console.error('Failed to save complaints to localStorage', e);
    }
  }, [complaints]);

  const addComplaint = (newIssueData) => {
    const matchedCategory = ISSUE_CATEGORIES.find(c => c.id === newIssueData.category);
    const id = generateComplaintId();
    const now = new Date();
    
    const formattedDate = now.toISOString().split('T')[0];
    const formattedTime = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    const fullDateStr = now.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

    const newComplaint = {
      id,
      title: newIssueData.title.trim(),
      category: newIssueData.category,
      categoryName: matchedCategory ? matchedCategory.name : 'General Issue',
      description: newIssueData.description.trim(),
      location: newIssueData.location.trim(),
      ward: newIssueData.ward,
      reportedDate: formattedDate,
      reportedTime: formattedTime,
      status: 'Pending',
      department: matchedCategory ? matchedCategory.department : 'Municipal Administration',
      assignedOfficer: 'Pending Assignment',
      priority: 'Normal',
      image: newIssueData.imagePreview || 'https://images.unsplash.com/photo-1515162816999-a0c47dc192f7?auto=format&fit=crop&w=800&q=80',
      isUserReport: true,
      timeline: [
        {
          stage: 'Submitted',
          title: 'Report Registered',
          date: `${fullDateStr}, ${formattedTime}`,
          completed: true,
          notes: 'Complaint logged successfully by citizen.'
        },
        {
          stage: 'Under Review',
          title: 'Municipal Verification',
          date: 'In Queue',
          completed: false,
          notes: 'Assigned to central municipal triage desk for validation.'
        },
        {
          stage: 'Officer Assigned',
          title: 'Assigned to Ward Engineer',
          date: 'Pending',
          completed: false,
          notes: 'Designation of ward field officer.'
        },
        {
          stage: 'In Progress',
          title: 'Field Work Underway',
          date: 'Pending',
          completed: false,
          notes: 'Remediation work in progress.'
        },
        {
          stage: 'Resolved',
          title: 'Resolution & Citizen Sign-off',
          date: 'Pending',
          completed: false,
          notes: 'Completion photographic verification.'
        }
      ]
    };

    setComplaints(prev => [newComplaint, ...prev]);
    return newComplaint;
  };

  const getComplaintById = (id) => {
    return complaints.find(c => c.id.toLowerCase() === id?.toLowerCase());
  };

  const resetToSampleData = () => {
    setComplaints(INITIAL_COMPLAINTS);
    localStorage.removeItem(STORAGE_KEY);
  };

  const stats = {
    total: complaints.length,
    resolved: complaints.filter(c => c.status.toLowerCase() === 'resolved').length,
    inProgress: complaints.filter(c => c.status.toLowerCase() === 'in progress').length,
    pending: complaints.filter(c => c.status.toLowerCase() === 'pending').length,
    userReportsCount: complaints.filter(c => c.isUserReport).length,
  };

  return (
    <ComplaintContext.Provider
      value={{
        complaints,
        addComplaint,
        getComplaintById,
        resetToSampleData,
        stats,
      }}
    >
      {children}
    </ComplaintContext.Provider>
  );
}

export function useComplaints() {
  const context = useContext(ComplaintContext);
  if (!context) {
    throw new Error('useComplaints must be used within a ComplaintProvider');
  }
  return context;
}
