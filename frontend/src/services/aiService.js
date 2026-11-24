/**
 * ReportlyUrban — AI Vision Analysis Frontend Service
 * Coordinates direct image transport to the FastAPI backend, client-side preview resizing,
 * Bearer JWT authentication, and structured error handling.
 */

import { supabase } from '../lib/supabase.js';

export const AI_SERVICE_URL =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_AI_SERVICE_URL) ||
  'http://localhost:8000';

/**
 * Resizes an image File using an in-memory HTML5 Canvas before transport.
 * Constrains maximum dimension to 1600px to optimize network bandwidth and prevent timeouts,
 * leaving the original high-resolution File untouched for final evidence submission.
 *
 * @param {File} file
 * @param {number} [maxDimension=1600]
 * @param {number} [quality=0.85]
 * @returns {Promise<Blob>}
 */
export async function resizeImageForAnalysis(file, maxDimension = 1600, quality = 0.85) {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.document) {
      resolve(file);
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read image file for analysis preview.'));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error('Failed to decode image data in browser.'));
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        if (width <= maxDimension && height <= maxDimension) {
          // Image already within bounds, return original file
          resolve(file);
          return;
        }

        if (width > height) {
          height = Math.round((height * maxDimension) / width);
          width = maxDimension;
        } else {
          width = Math.round((width * maxDimension) / height);
          height = maxDimension;
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(file);
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            if (blob) {
              resolve(blob);
            } else {
              resolve(file);
            }
          },
          file.type === 'image/png' ? 'image/png' : 'image/jpeg',
          quality
        );
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Submits an image file to the ReportlyUrban AI service for Gemini Vision classification.
 *
 * @param {Object} params
 * @param {File} params.file - The incident photograph file
 * @param {number} [params.timeoutMs=20000] - Request timeout in milliseconds
 * @param {Object} [params.supabaseClient=supabase] - Supabase client instance
 * @returns {Promise<{ data: Object | null, error: Error | null }>}
 */
export async function analyzeIncidentPhoto({
  file,
  timeoutMs = 20000,
  supabaseClient = supabase,
}) {
  if (!file) {
    return { data: null, error: new Error('Please select an image photograph first.') };
  }

  // 1. Authoritative session verification
  const {
    data: { session },
    error: sessionError,
  } = await supabaseClient.auth.getSession();

  if (sessionError || !session?.access_token) {
    return {
      data: null,
      error: new Error('Authentication required. Please sign in as a citizen to use AI analysis.'),
    };
  }

  // 2. Prepare resized image blob for efficient transport
  let transportBlob;
  try {
    transportBlob = await resizeImageForAnalysis(file);
  } catch {
    transportBlob = file; // Fallback to raw file if canvas unavailable
  }

  const formData = new FormData();
  formData.append('file', transportBlob, file.name || 'incident.jpg');

  // 3. Prepare AbortController for timeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const endpoint = `${AI_SERVICE_URL.replace(/\/$/, '')}/api/ai/analyze-issue`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        Accept: 'application/json',
      },
      body: formData,
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (response.status === 401) {
      return {
        data: null,
        error: new Error('Session expired or invalid. Please sign in again.'),
      };
    }

    if (response.status === 403) {
      const errJson = await response.json().catch(() => ({}));
      return {
        data: null,
        error: new Error(errJson.detail || 'Access denied: AI problem detection is reserved for citizens.'),
      };
    }

    if (response.status === 413) {
      return {
        data: null,
        error: new Error('Image file is too large for AI vision analysis. Max size is 5 MB.'),
      };
    }

    if (response.status === 422) {
      const errJson = await response.json().catch(() => ({}));
      return {
        data: null,
        error: new Error(errJson.detail || 'The selected file is not a valid or supported image format.'),
      };
    }

    if (response.status === 429) {
      const errJson = await response.json().catch(() => ({}));
      return {
        data: null,
        error: new Error(errJson.detail || 'Daily AI analysis quota reached (10/10). Please submit details manually.'),
      };
    }

    if (!response.ok) {
      const errJson = await response.json().catch(() => ({}));
      return {
        data: null,
        error: new Error(errJson.detail || `AI service returned error code ${response.status}.`),
      };
    }

    const data = await response.json();
    return { data, error: null };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return {
        data: null,
        error: new Error('AI analysis timed out after 20 seconds. Please try again or fill in the details manually.'),
      };
    }
    return {
      data: null,
      error: new Error(
        err.message?.includes('Failed to fetch')
          ? 'Unable to connect to Reportly AI backend service. Please ensure the backend is running or continue manually.'
          : err.message || 'An unexpected error occurred during AI analysis.'
      ),
    };
  }
}
