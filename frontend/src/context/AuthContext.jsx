import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';

const AuthContext = createContext(null);

function isSameProfile(prev, next) {
  if (prev === next) return true;
  if (!prev || !next) return false;
  return (
    prev.id === next.id &&
    prev.role === next.role &&
    prev.full_name === next.full_name &&
    prev.ward === next.ward &&
    prev.phone_number === next.phone_number &&
    prev.civic_points === next.civic_points &&
    prev.badge_level === next.badge_level &&
    prev.updated_at === next.updated_at
  );
}

function isSameOfficerRecord(prev, next) {
  if (prev === next) return true;
  if (!prev || !next) return false;
  return (
    prev.id === next.id &&
    Boolean(prev.is_active) === Boolean(next.is_active) &&
    prev.department_id === next.department_id &&
    prev.designation === next.designation &&
    prev.assigned_ward === next.assigned_ward
  );
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [officerRecord, setOfficerRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(true);
  const [authError, setAuthError] = useState(null);

  const userRef = useRef(null);
  const sessionRef = useRef(null);
  const profileRef = useRef(null);
  const officerRecordRef = useRef(null);
  const profileLoadingRef = useRef(true);
  const resolvedUserIdRef = useRef(null);
  const inFlightProfileRef = useRef({ userId: null, promise: null });
  const isMountedRef = useRef(true);

  const commitProfileLoading = useCallback((nextValue) => {
    if (!isMountedRef.current) return;
    if (profileLoadingRef.current !== nextValue) {
      profileLoadingRef.current = nextValue;
      setProfileLoading(nextValue);
    }
  }, []);

  const commitUserAndSession = useCallback((nextSession) => {
    if (!isMountedRef.current) return;
    const nextUser = nextSession?.user ?? null;

    const prevSession = sessionRef.current;
    const sessionChanged =
      Boolean(prevSession) !== Boolean(nextSession) ||
      (prevSession &&
        nextSession &&
        (prevSession.access_token !== nextSession.access_token ||
          prevSession.expires_at !== nextSession.expires_at));
    if (sessionChanged) {
      sessionRef.current = nextSession;
      setSession(nextSession);
    }

    const prevUser = userRef.current;
    const userChanged =
      (prevUser?.id ?? null) !== (nextUser?.id ?? null) ||
      (prevUser?.email ?? null) !== (nextUser?.email ?? null);
    if (userChanged) {
      userRef.current = nextUser;
      setUser(nextUser);
    }
  }, []);

  const commitProfileState = useCallback((nextProfile, nextOfficer) => {
    if (!isMountedRef.current) return;
    if (!isSameProfile(profileRef.current, nextProfile)) {
      profileRef.current = nextProfile;
      setProfile(nextProfile);
    }
    if (!isSameOfficerRecord(officerRecordRef.current, nextOfficer)) {
      officerRecordRef.current = nextOfficer;
      setOfficerRecord(nextOfficer);
    }
  }, []);

  const clearAuthState = useCallback(() => {
    resolvedUserIdRef.current = null;
    inFlightProfileRef.current = { userId: null, promise: null };
    commitUserAndSession(null);
    commitProfileState(null, null);
    commitProfileLoading(false);
  }, [commitProfileLoading, commitProfileState, commitUserAndSession]);

  // Authoritatively fetch verified profile and active officer record from database
  const fetchProfile = useCallback(
    async (userId, options = {}) => {
      if (!userId) {
        resolvedUserIdRef.current = null;
        commitProfileState(null, null);
        commitProfileLoading(false);
        return null;
      }

      const isAlreadyResolvedForUser = resolvedUserIdRef.current === userId;
      const silent =
        typeof options.silent === 'boolean' ? options.silent : isAlreadyResolvedForUser;

      // Deduplicate concurrent fetches for the same userId (e.g. initSession + INITIAL_SESSION)
      if (
        inFlightProfileRef.current.userId === userId &&
        inFlightProfileRef.current.promise
      ) {
        return inFlightProfileRef.current.promise;
      }

      if (!silent) {
        commitProfileLoading(true);
      }

      const run = (async () => {
        try {
          // 1. Authoritative role check from public.profiles
          const { data: profileData, error: profileError } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .maybeSingle();

          if (profileError) {
            console.warn(
              '[AuthContext] Could not fetch profile from database:',
              profileError.message
            );
            resolvedUserIdRef.current = null;
            commitProfileState(null, null);
            return null;
          }

          const nextProfile = profileData || null;
          let nextOfficer = null;

          // 2. If profile indicates an officer, authoritatively verify active officer assignment
          if (nextProfile?.role === 'officer') {
            const { data: officerData, error: officerError } = await supabase
              .from('officers')
              .select('*')
              .eq('profile_id', userId)
              .eq('is_active', true)
              .maybeSingle();

            if (officerError) {
              console.warn('[AuthContext] Could not fetch officer record:', officerError.message);
              nextOfficer = null;
            } else {
              nextOfficer = officerData || null;
            }
          }

          resolvedUserIdRef.current = nextProfile ? userId : null;
          commitProfileState(nextProfile, nextOfficer);
          return nextProfile;
        } catch (err) {
          console.warn('[AuthContext] Profile fetch exception:', err);
          resolvedUserIdRef.current = null;
          commitProfileState(null, null);
          return null;
        } finally {
          if (inFlightProfileRef.current.userId === userId) {
            inFlightProfileRef.current = { userId: null, promise: null };
          }
          commitProfileLoading(false);
        }
      })();

      inFlightProfileRef.current = { userId, promise: run };
      return run;
    },
    [commitProfileLoading, commitProfileState]
  );

  useEffect(() => {
    isMountedRef.current = true;

    // 1. Retrieve initial active session (loading UI only during first load)
    async function initSession() {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (!isMountedRef.current) return;

        if (error) {
          console.error('[AuthContext] Session retrieval error:', error.message);
          setAuthError(error);
          clearAuthState();
        } else {
          const currentSession = data.session;
          commitUserAndSession(currentSession);
          if (currentSession?.user?.id) {
            await fetchProfile(currentSession.user.id, {
              silent: resolvedUserIdRef.current === currentSession.user.id,
            });
          } else {
            commitProfileState(null, null);
            commitProfileLoading(false);
          }
        }
      } catch (err) {
        console.error('[AuthContext] Unexpected initialization failure:', err);
        if (isMountedRef.current) {
          setAuthError(err);
          clearAuthState();
        }
      } finally {
        if (isMountedRef.current) {
          setLoading(false);
        }
      }
    }

    initSession();

    // 2. Real-time auth state listener (silent background refresh on refocus/token refresh)
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      if (!isMountedRef.current) return;

      if (event === 'SIGNED_OUT' || !newSession?.user?.id) {
        clearAuthState();
        setLoading(false);
        return;
      }

      const nextUserId = newSession.user.id;
      const isSameResolvedUser = resolvedUserIdRef.current === nextUserId;

      commitUserAndSession(newSession);
      setLoading(false);

      // On tab refocus / TOKEN_REFRESHED / re-emitted SIGNED_IN for same user,
      // re-verify role/profile silently without showing loading/verifying UI.
      await fetchProfile(nextUserId, { silent: isSameResolvedUser });
    });

    // 3. Clean up subscription on unmount
    return () => {
      isMountedRef.current = false;
      subscription?.unsubscribe();
    };
  }, [clearAuthState, commitProfileLoading, commitProfileState, commitUserAndSession, fetchProfile]);

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
        commitUserAndSession(data.session);
        if (data.session.user?.id) {
          await fetchProfile(data.session.user.id, { silent: false });
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
        commitUserAndSession(data.session);
        if (data.session.user?.id) {
          await fetchProfile(data.session.user.id, {
            silent: resolvedUserIdRef.current === data.session.user.id,
          });
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
      clearAuthState();
      if (error) {
        return { error };
      }
      return { error: null };
    } catch (err) {
      console.error('[AuthContext] signOut error:', err);
      clearAuthState();
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
