import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [officerRecord, setOfficerRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(true);
  const [authError, setAuthError] = useState(null);

  // Authoritatively fetch verified profile and active officer record from database
  const fetchProfile = useCallback(async (userId) => {
    if (!userId) {
      setProfile(null);
      setOfficerRecord(null);
      setProfileLoading(false);
      return null;
    }

    setProfileLoading(true);
    try {
      // 1. Authoritative role check from public.profiles
      const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      if (profileError) {
        console.warn('[AuthContext] Could not fetch profile from database:', profileError.message);
        setProfile(null);
        setOfficerRecord(null);
        return null;
      }

      setProfile(profileData || null);

      // 2. If profile indicates an officer, authoritatively verify active officer assignment
      if (profileData?.role === 'officer') {
        const { data: officerData, error: officerError } = await supabase
          .from('officers')
          .select('*')
          .eq('profile_id', userId)
          .eq('is_active', true)
          .maybeSingle();

        if (officerError) {
          console.warn('[AuthContext] Could not fetch officer record:', officerError.message);
          setOfficerRecord(null);
        } else {
          setOfficerRecord(officerData || null);
        }
      } else {
        setOfficerRecord(null);
      }

      return profileData;
    } catch (err) {
      console.warn('[AuthContext] Profile fetch exception:', err);
      setProfile(null);
      setOfficerRecord(null);
    } finally {
      setProfileLoading(false);
    }
    return null;
  }, []);

  useEffect(() => {
    let isMounted = true;

    // 1. Retrieve initial active session
    async function initSession() {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (error) {
          console.error('[AuthContext] Session retrieval error:', error.message);
          if (isMounted) {
            setAuthError(error);
            setProfileLoading(false);
          }
        } else if (isMounted) {
          const currentSession = data.session;
          setSession(currentSession);
          setUser(currentSession?.user ?? null);
          if (currentSession?.user?.id) {
            await fetchProfile(currentSession.user.id);
          } else {
            setProfileLoading(false);
          }
        }
      } catch (err) {
        console.error('[AuthContext] Unexpected initialization failure:', err);
        if (isMounted) {
          setAuthError(err);
          setProfileLoading(false);
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    initSession();

    // 2. Real-time auth state listener
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, newSession) => {
      if (isMounted) {
        setSession(newSession);
        setUser(newSession?.user ?? null);
        setLoading(false);
        if (newSession?.user?.id) {
          await fetchProfile(newSession.user.id);
        } else {
          setProfile(null);
          setOfficerRecord(null);
          setProfileLoading(false);
        }
      }
    });

    // 3. Clean up subscription on unmount
    return () => {
      isMounted = false;
      subscription?.unsubscribe();
    };
  }, [fetchProfile]);

  // Citizen Registration
  const signUp = async ({ fullName, email, password, phoneNumber, ward }) => {
    setAuthError(null);
    try {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: {
            full_name: fullName.trim(),
            phone_number: phoneNumber.trim(),
            ward: ward.trim(),
          },
        },
      });

      if (error) {
        return { data: null, error };
      }

      if (data?.session) {
        setSession(data.session);
        setUser(data.session.user);
        if (data.session.user?.id) {
          await fetchProfile(data.session.user.id);
        }
      }

      return { data, error: null };
    } catch (err) {
      console.error('[AuthContext] signUp error:', err);
      return { data: null, error: err };
    }
  };

  // Citizen Login
  const signIn = async ({ email, password }) => {
    setAuthError(null);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error) {
        return { data: null, error };
      }

      if (data?.session) {
        setSession(data.session);
        setUser(data.session.user);
        if (data.session.user?.id) {
          await fetchProfile(data.session.user.id);
        }
      }

      return { data, error: null };
    } catch (err) {
      console.error('[AuthContext] signIn error:', err);
      return { data: null, error: err };
    }
  };

  // Citizen Logout
  const signOut = async () => {
    setAuthError(null);
    try {
      const { error } = await supabase.auth.signOut();
      setUser(null);
      setSession(null);
      setProfile(null);
      setOfficerRecord(null);
      setProfileLoading(false);
      if (error) {
        return { error };
      }
      return { error: null };
    } catch (err) {
      console.error('[AuthContext] signOut error:', err);
      setUser(null);
      setSession(null);
      setProfile(null);
      setOfficerRecord(null);
      setProfileLoading(false);
      return { error: err };
    }
  };

  // Authoritative database-enforced role flags (Never trusting user_metadata)
  const role = profile?.role || null;
  const isAdmin = role === 'admin';
  const isOfficer = role === 'officer' && Boolean(officerRecord && officerRecord.is_active);
  const isCitizen = role === 'citizen';

  // Active citizen display metadata
  const citizenInfo = {
    fullName: profile?.full_name || user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'Citizen User',
    email: user?.email || '',
    ward: profile?.ward || user?.user_metadata?.ward || 'Unassigned Ward',
    phoneNumber: profile?.phone_number || user?.user_metadata?.phone_number || '',
    role: role || 'citizen',
    civicPoints: profile?.civic_points ?? 0,
    badgeLevel: profile?.badge_level || 'Civic Starter',
  };

  const value = {
    user,
    session,
    profile,
    role,
    officerRecord,
    isAdmin,
    isOfficer,
    isCitizen,
    citizenInfo,
    loading,
    profileLoading,
    authError,
    isAuthenticated: Boolean(user),
    signUp,
    signIn,
    signOut,
    fetchProfile,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
