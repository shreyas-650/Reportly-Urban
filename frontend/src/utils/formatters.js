export function formatDate(dateString) {
  if (!dateString) return 'N/A';
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString;
    return new Intl.DateTimeFormat('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(date);
  } catch {
    return dateString;
  }
}

export function formatDateTime(dateString) {
  if (!dateString) return 'N/A';
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString;
    return new Intl.DateTimeFormat('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return dateString;
  }
}

export function generateComplaintId() {
  const year = new Date().getFullYear();
  const randomNum = Math.floor(1000 + Math.random() * 9000);
  return `RU-${year}-${randomNum}`;
}

export function getStatusColor(status) {
  switch (status?.toLowerCase()) {
    case 'resolved':
      return {
        bg: 'bg-emerald-50',
        text: 'text-emerald-700',
        border: 'border-emerald-200',
        dot: 'bg-emerald-500',
      };
    case 'in progress':
    case 'in_progress':
      return {
        bg: 'bg-blue-50',
        text: 'text-blue-700',
        border: 'border-blue-200',
        dot: 'bg-blue-500',
      };
    case 'under_review':
    case 'under review':
      return {
        bg: 'bg-purple-50',
        text: 'text-purple-700',
        border: 'border-purple-200',
        dot: 'bg-purple-500',
      };
    case 'rejected':
      return {
        bg: 'bg-rose-50',
        text: 'text-rose-700',
        border: 'border-rose-200',
        dot: 'bg-rose-500',
      };
    case 'not_confirmed_by_citizen':
      return {
        bg: 'bg-slate-100',
        text: 'text-slate-700',
        border: 'border-slate-300',
        dot: 'bg-slate-500',
      };
    case 'submitted':
    case 'pending':
    default:
      return {
        bg: 'bg-amber-50',
        text: 'text-amber-700',
        border: 'border-amber-200',
        dot: 'bg-amber-500',
      };
  }
}

export function formatStatusLabel(status) {
  switch (status?.toLowerCase()) {
    case 'submitted':
      return 'Submitted';
    case 'under_review':
    case 'under review':
      return 'Under Review';
    case 'in_progress':
    case 'in progress':
      return 'In Progress';
    case 'resolved':
      return 'Resolved';
    case 'rejected':
      return 'Rejected';
    case 'not_confirmed_by_citizen':
      return 'Not Confirmed by Citizen';
    default:
      return status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Pending';
  }
}

export function getPriorityColor(priority) {
  switch (priority?.toLowerCase()) {
    case 'emergency':
      return {
        bg: 'bg-red-50',
        text: 'text-red-700',
        border: 'border-red-200',
        dot: 'bg-red-600',
      };
    case 'high':
      return {
        bg: 'bg-orange-50',
        text: 'text-orange-700',
        border: 'border-orange-200',
        dot: 'bg-orange-500',
      };
    case 'medium':
      return {
        bg: 'bg-amber-50',
        text: 'text-amber-700',
        border: 'border-amber-200',
        dot: 'bg-amber-500',
      };
    case 'normal':
      return {
        bg: 'bg-blue-50',
        text: 'text-blue-700',
        border: 'border-blue-200',
        dot: 'bg-blue-500',
      };
    case 'low':
    default:
      return {
        bg: 'bg-slate-100',
        text: 'text-slate-700',
        border: 'border-slate-200',
        dot: 'bg-slate-400',
      };
  }
}

export function formatPriorityLabel(priority) {
  switch (priority?.toLowerCase()) {
    case 'emergency':
      return 'Emergency';
    case 'high':
      return 'High';
    case 'medium':
      return 'Medium';
    case 'normal':
      return 'Normal';
    case 'low':
      return 'Low';
    default:
      return priority ? priority.charAt(0).toUpperCase() + priority.slice(1) : 'Normal';
  }
}

