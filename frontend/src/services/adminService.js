import { supabase } from '../lib/supabase.js';
import { COMPLAINT_STORAGE_BUCKET } from './storageService.js';
import { UUID_V4_REGEX } from './complaintService.js';

/**
 * Sanitizes search terms for PostgREST ilike filters to prevent syntax injection or crashes.
 */
export function sanitizeSearchTerm(term) {
  if (!term || typeof term !== 'string') return '';
  return term.replace(/[%_,()]/g, ' ').trim();
}

/**
 * Standardized overdue check:
 * sla_deadline < now AND status NOT IN ('resolved', 'rejected')
 */
export function isComplaintOverdue(complaint) {
  if (!complaint?.sla_deadline) return false;
  if (complaint.status === 'resolved' || complaint.status === 'rejected') return false;
  return new Date(complaint.sla_deadline).getTime() < Date.now();
}

/**
 * Fetches aggregated municipal administrative statistics via secure database RPC.
 */
export async function fetchAdminOverviewStats() {
  try {
    const { data, error } = await supabase.rpc('get_admin_overview_stats');
    if (error) {
      throw error;
    }
    return { data, error: null };
  } catch (err) {
    console.error('[adminService] fetchAdminOverviewStats error:', err);
    return { data: null, error: err };
  }
}

/**
 * Fetches complaints with comprehensive administrative filtering, server-side search,
 * and server-side pagination.
 */
export async function fetchAdminComplaints({
  search = '',
  status = 'all',
  priority = 'all',
  departmentId = 'all',
  ward = 'all',
  assigned = 'all', // 'all', 'assigned', 'unassigned'
  overdue = false,
  page = 1,
  pageSize = 10,
  sortBy = 'created_at',
  sortAscending = false,
} = {}) {
  try {
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let query = supabase.from('complaints').select(
      `
        id,
        complaint_number,
        citizen_id,
        title,
        category,
        location,
        ward,
        status,
        priority,
        department_id,
        assigned_officer_id,
        sla_deadline,
        created_at,
        updated_at,
        department:departments (
          id,
          name,
          code
        ),
        assigned_officer:officers (
          id,
          official_name,
          designation
        ),
        citizen:profiles!citizen_id (
          id,
          full_name,
          phone_number
        )
      `,
      { count: 'exact' }
    );

    // Apply filters
    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    if (priority && priority !== 'all') {
      query = query.eq('priority', priority);
    }

    if (departmentId && departmentId !== 'all') {
      if (departmentId === 'none') {
        query = query.is('department_id', null);
      } else {
        query = query.eq('department_id', departmentId);
      }
    }

    if (ward && ward !== 'all') {
      query = query.eq('ward', ward);
    }

    if (assigned === 'assigned') {
      query = query.not('assigned_officer_id', 'is', null);
    } else if (assigned === 'unassigned') {
      query = query.is('assigned_officer_id', null);
    }

    if (overdue) {
      const nowIso = new Date().toISOString();
      query = query
        .lt('sla_deadline', nowIso)
        .not('status', 'in', '("resolved","rejected")');
    }

    // Text Search on complaint_number or title
    const cleanSearch = sanitizeSearchTerm(search);
    if (cleanSearch) {
      query = query.or(
        `complaint_number.ilike.%${cleanSearch}%,title.ilike.%${cleanSearch}%`
      );
    }

    // Ordering and range
    query = query.order(sortBy, { ascending: sortAscending }).range(from, to);

    const { data, count, error } = await query;
    if (error) throw error;

    const totalPages = Math.ceil((count || 0) / pageSize) || 1;

    return {
      data: data || [],
      count: count || 0,
      page,
      pageSize,
      totalPages,
      error: null,
    };
  } catch (err) {
    console.error('[adminService] fetchAdminComplaints error:', err);
    return { data: [], count: 0, page: 1, totalPages: 1, error: err };
  }
}

/**
 * Fetches full complaint details for administration, including citizen information,
 * status history, assignment audit timeline, and short-lived signed image URLs.
 */
export async function fetchAdminComplaintDetails(identifier) {
  try {
    if (!identifier) {
      return { data: null, error: new Error('Complaint identifier is required.') };
    }

    let query = supabase.from('complaints').select(`
      id,
      complaint_number,
      citizen_id,
      title,
      category,
      description,
      location,
      ward,
      latitude,
      longitude,
      status,
      priority,
      department_id,
      assigned_officer_id,
      image_url,
      completion_image_url,
      sla_deadline,
      created_at,
      updated_at,
      department:departments (
        id,
        name,
        code,
        default_sla_hours,
        contact_email
      ),
      assigned_officer:officers (
        id,
        official_name,
        designation,
        assigned_ward,
        is_active
      ),
      citizen:profiles!citizen_id (
        id,
        full_name,
        phone_number,
        ward,
        badge_level
      )
    `);

    if (UUID_V4_REGEX.test(identifier.trim())) {
      query = query.eq('id', identifier.trim());
    } else {
      query = query.eq('complaint_number', identifier.trim());
    }

    const { data: complaint, error: queryError } = await query.maybeSingle();
    if (queryError) throw queryError;
    if (!complaint) return { data: null, error: null };

    // Resolve short-lived signed URL for complaint evidence photo
    let signedImageUrl = null;
    if (complaint.image_url) {
      if (complaint.image_url.startsWith('http://') || complaint.image_url.startsWith('https://')) {
        signedImageUrl = complaint.image_url;
      } else {
        try {
          const { data: signedData } = await supabase.storage
            .from(COMPLAINT_STORAGE_BUCKET)
            .createSignedUrl(complaint.image_url, 1800); // 30 min short-lived URL
          signedImageUrl = signedData?.signedUrl || null;
        } catch (storageErr) {
          console.warn('[adminService] Storage signed URL generation failed:', storageErr);
        }
      }
    }

    // Resolve signed URL for completion evidence photo if available
    let signedCompletionUrl = null;
    if (complaint.completion_image_url) {
      if (complaint.completion_image_url.startsWith('http://') || complaint.completion_image_url.startsWith('https://')) {
        signedCompletionUrl = complaint.completion_image_url;
      } else {
        try {
          const { data: signedCompData } = await supabase.storage
            .from(COMPLAINT_STORAGE_BUCKET)
            .createSignedUrl(complaint.completion_image_url, 1800);
          signedCompletionUrl = signedCompData?.signedUrl || null;
        } catch (storageErr) {
          console.warn('[adminService] Storage signed completion URL failed:', storageErr);
        }
      }
    }

    // Fetch Status History (with audit columns: previous_status, public_description, internal_note)
    const { data: statusHistory, error: historyErr } = await supabase
      .from('complaint_status_history')
      .select(`
        id,
        status,
        previous_status,
        title,
        public_description,
        internal_note,
        notes,
        created_at,
        actor:profiles!actor_id (
          full_name,
          role
        )
      `)
      .eq('complaint_id', complaint.id)
      .order('created_at', { ascending: false });

    if (historyErr) {
      console.warn('[adminService] Error fetching status history:', historyErr);
    }

    // Fetch Resolution Evidence Metadata if available
    let resolutionEvidence = null;
    try {
      const { data: evidenceData } = await supabase
        .from('complaint_resolution_evidence')
        .select(`
          id,
          storage_path,
          file_size_bytes,
          mime_type,
          created_at,
          uploader:profiles!uploaded_by (
            full_name
          )
        `)
        .eq('complaint_id', complaint.id)
        .maybeSingle();

      resolutionEvidence = evidenceData || null;
    } catch (evidenceErr) {
      console.warn('[adminService] Error fetching resolution evidence:', evidenceErr);
    }

    // Fetch Assignment Audit Timeline
    const { data: assignmentAudit, error: auditErr } = await supabase
      .from('complaint_assignment_audit')
      .select(`
        id,
        prev_priority,
        new_priority,
        prev_sla_deadline,
        new_sla_deadline,
        created_at,
        actor:profiles!actor_id (
          full_name,
          role
        ),
        prev_department:departments!prev_department_id (
          name
        ),
        new_department:departments!new_department_id (
          name
        ),
        prev_officer:officers!prev_officer_id (
          official_name
        ),
        new_officer:officers!new_officer_id (
          official_name
        )
      `)
      .eq('complaint_id', complaint.id)
      .order('created_at', { ascending: false });

    if (auditErr) {
      console.warn('[adminService] Error fetching assignment audit:', auditErr);
    }

    return {
      data: {
        ...complaint,
        signedImageUrl,
        signedCompletionUrl,
        isOverdue: isComplaintOverdue(complaint),
        statusHistory: statusHistory || [],
        assignmentAudit: assignmentAudit || [],
        resolutionEvidence,
      },
      error: null,
    };
  } catch (err) {
    console.error('[adminService] fetchAdminComplaintDetails error:', err);
    return { data: null, error: err };
  }
}

/**
 * Assigns or updates a complaint's department, officer, priority, and SLA deadline atomically
 * via the database RPC public.assign_complaint_admin().
 * Includes concurrency check against expectedUpdatedAt.
 */
export async function assignComplaintAdmin({
  complaintId,
  departmentId,
  officerId,
  priority,
  slaDeadline,
  expectedUpdatedAt,
}) {
  try {
    if (!complaintId) {
      throw new Error('Complaint ID is required.');
    }
    if (!expectedUpdatedAt) {
      throw new Error('expectedUpdatedAt timestamp is required for concurrency control.');
    }

    const { data, error } = await supabase.rpc('assign_complaint_admin', {
      p_complaint_id: complaintId,
      p_department_id: departmentId || null,
      p_officer_id: officerId || null,
      p_priority: priority,
      p_sla_deadline: slaDeadline || null,
      p_expected_updated_at: expectedUpdatedAt || null,
    });

    if (error) {
      throw error;
    }

    return { data, error: null };
  } catch (err) {
    console.error('[adminService] assignComplaintAdmin error:', err);
    return { data: null, error: err };
  }
}

/**
 * Fetches all municipal departments with officer and complaint counts.
 */
export async function fetchAdminDepartments() {
  try {
    const { data, error } = await supabase
      .from('departments')
      .select(`
        id,
        name,
        code,
        description,
        default_sla_hours,
        contact_email,
        is_active,
        created_at,
        officers:officers (
          id,
          is_active
        ),
        complaints:complaints (
          id,
          status
        )
      `)
      .order('name', { ascending: true });

    if (error) throw error;

    const formatted = (data || []).map((dept) => {
      const activeOfficers = (dept.officers || []).filter((o) => o.is_active).length;
      const totalOfficers = (dept.officers || []).length;
      const totalComplaints = (dept.complaints || []).length;
      const activeComplaints = (dept.complaints || []).filter(
        (c) => c.status !== 'resolved' && c.status !== 'rejected'
      ).length;

      return {
        ...dept,
        activeOfficers,
        totalOfficers,
        totalComplaints,
        activeComplaints,
      };
    });

    return { data: formatted, error: null };
  } catch (err) {
    console.error('[adminService] fetchAdminDepartments error:', err);
    return { data: [], error: err };
  }
}

/**
 * Updates municipal department details (e.g. is_active deactivation, SLA hours, email).
 */
export async function updateAdminDepartment(departmentId, updates) {
  try {
    const { data, error } = await supabase
      .from('departments')
      .update(updates)
      .eq('id', departmentId)
      .select()
      .single();

    if (error) throw error;
    return { data, error: null };
  } catch (err) {
    console.error('[adminService] updateAdminDepartment error:', err);
    return { data: null, error: err };
  }
}

/**
 * Creates a new municipal department.
 */
export async function createAdminDepartment(deptData) {
  try {
    const { data, error } = await supabase
      .from('departments')
      .insert([
        {
          name: deptData.name.trim(),
          code: deptData.code.trim().toUpperCase(),
          description: deptData.description?.trim() || null,
          default_sla_hours: Number(deptData.default_sla_hours) || 48,
          contact_email: deptData.contact_email?.trim() || null,
          is_active: true,
        },
      ])
      .select()
      .single();

    if (error) throw error;
    return { data, error: null };
  } catch (err) {
    console.error('[adminService] createAdminDepartment error:', err);
    return { data: null, error: err };
  }
}

/**
 * Fetches the officer roster with active complaint counts and verified officer email.
 */
export async function fetchAdminOfficers() {
  try {
    const { data, error } = await supabase.rpc('get_admin_officers_directory');
    if (error) throw error;
    return { data: data || [], error: null };
  } catch (err) {
    console.error('[adminService] fetchAdminOfficers error:', err);
    return { data: [], error: err };
  }
}

/**
 * Fetches active officers belonging strictly to a specific department.
 * Used for dynamic officer assignment dropdowns in complaint triage.
 */
export async function fetchActiveDepartmentOfficers(departmentId) {
  try {
    if (!departmentId) return { data: [], error: null };

    const { data, error } = await supabase
      .from('officers')
      .select('id, official_name, designation, assigned_ward, is_active')
      .eq('department_id', departmentId)
      .eq('is_active', true)
      .order('official_name', { ascending: true });

    if (error) throw error;
    return { data: data || [], error: null };
  } catch (err) {
    console.error('[adminService] fetchActiveDepartmentOfficers error:', err);
    return { data: [], error: err };
  }
}

/**
 * Links a registered citizen user account to an officer roster record via RPC.
 */
export async function linkOfficerUser({
  email,
  departmentId,
  officialName,
  designation,
  assignedWard,
}) {
  try {
    const { data, error } = await supabase.rpc('link_officer_user', {
      p_user_email: email,
      p_department_id: departmentId,
      p_official_name: officialName,
      p_designation: designation,
      p_assigned_ward: assignedWard || null,
    });

    if (error) throw error;
    return { data, error: null };
  } catch (err) {
    console.error('[adminService] linkOfficerUser error:', err);
    return { data: null, error: err };
  }
}

/**
 * Updates an officer's active status or transfers their department.
 * Validates at database level that the officer does not hold unresolved complaints.
 */
export async function updateOfficerStatus({ officerId, isActive, newDepartmentId = null }) {
  try {
    const { data, error } = await supabase.rpc('update_officer_status', {
      p_officer_id: officerId,
      p_is_active: isActive,
      p_new_department_id: newDepartmentId || null,
    });

    if (error) throw error;
    return { data, error: null };
  } catch (err) {
    console.error('[adminService] updateOfficerStatus error:', err);
    return { data: null, error: err };
  }
}

/**
 * Transitions a complaint status atomically via RPC public.transition_complaint_status().
 * Enforces role checks, transition matrix, optimistic concurrency (expectedUpdatedAt),
 * and evidence verification inside the database transaction.
 *
 * @param {Object} params
 * @param {string} params.complaintId - UUID of the complaint
 * @param {string} params.newStatus - Target complaint_status ('under_review', 'in_progress', 'resolved', 'rejected')
 * @param {string} params.expectedUpdatedAt - Exact updated_at timestamp string from Supabase (never re-serialized through JS Date)
 * @param {string} [params.publicDescription] - Public explanation to the citizen (mandatory for resolved and rejected)
 * @param {string} [params.internalNote] - Private internal remark for municipal staff
 * @param {string} [params.resolutionImagePath] - Storage path of uploaded completion photo (mandatory for resolved)
 * @returns {Promise<{ data: any, error: Error | null }>}
 */
export async function transitionComplaintStatus({
  complaintId,
  newStatus,
  expectedUpdatedAt,
  publicDescription = null,
  internalNote = null,
  resolutionImagePath = null,
}) {
  try {
    if (!complaintId) {
      throw new Error('Complaint ID is required.');
    }
    if (!newStatus) {
      throw new Error('New status is required.');
    }
    if (!expectedUpdatedAt || typeof expectedUpdatedAt !== 'string') {
      throw new Error('Exact expectedUpdatedAt timestamp string is required for concurrency control.');
    }

    const { data, error } = await supabase.rpc('transition_complaint_status', {
      p_complaint_id: complaintId,
      p_new_status: newStatus,
      p_expected_updated_at: expectedUpdatedAt,
      p_public_description: publicDescription || null,
      p_internal_note: internalNote || null,
      p_resolution_image_path: resolutionImagePath || null,
    });

    if (error) throw error;
    return { data, error: null };
  } catch (err) {
    console.error('[adminService] transitionComplaintStatus error:', err);
    return { data: null, error: err };
  }
}
