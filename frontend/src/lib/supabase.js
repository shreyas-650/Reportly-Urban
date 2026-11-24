import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env?.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env?.VITE_SUPABASE_ANON_KEY;

const isConfigured = Boolean(
  supabaseUrl &&
  supabaseAnonKey &&
  supabaseUrl !== 'https://your-project-id.supabase.co' &&
  supabaseAnonKey !== 'your-anon-public-key-here'
);

if (!isConfigured) {
  console.warn(
    '[Reportly Urban] Supabase environment variables (VITE_SUPABASE_URL and/or VITE_SUPABASE_ANON_KEY) are missing or using placeholder values. Please set valid credentials in frontend/.env to enable live authentication.'
  );
}

// Resilient initialization with fallback values so client instantiation does not throw on unconfigured builds
export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder-anon-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }
);
