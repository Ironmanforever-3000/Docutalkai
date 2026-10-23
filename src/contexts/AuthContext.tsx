import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signInAsGuest: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // 1. Check if there is an active local guest session
    const savedGuest = localStorage.getItem('docutalk_guest_session');
    if (savedGuest) {
      try {
        const parsed = JSON.parse(savedGuest);
        if (parsed?.id) {
          setUser(parsed);
          setLoading(false);
          return;
        }
      } catch {}
    }

    // 2. Fast-fallback timeout (2s) so a paused or unreachable Supabase project does not hang the login page
    const timeoutId = setTimeout(() => {
      setLoading(false);
    }, 2000);

    supabase.auth.getSession()
      .then(({ data: { session } }) => {
        clearTimeout(timeoutId);
        if (session?.user) {
          localStorage.removeItem('docutalk_guest_session');
          setUser(session.user);
        } else if (!savedGuest) {
          setUser(null);
        }
        setLoading(false);
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        console.warn('Supabase auth session check failed (project may be paused or offline):', err);
        setLoading(false);
      });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (session?.user) {
          localStorage.removeItem('docutalk_guest_session');
          setUser(session.user);
        }
      }
    );

    return () => {
      clearTimeout(timeoutId);
      subscription.unsubscribe();
    };
  }, []);

  const signIn = async (email: string, password: string) => {
    localStorage.removeItem('docutalk_guest_session');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  };

  const signUp = async (email: string, password: string) => {
    localStorage.removeItem('docutalk_guest_session');
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;
  };

  const signOut = async () => {
    localStorage.removeItem('docutalk_guest_session');
    try {
      await supabase.auth.signOut();
    } catch {
      // Ignore network errors on signout
    }
    setUser(null);
  };

  const signInWithGoogle = async () => {
    localStorage.removeItem('docutalk_guest_session');
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/login`,
        queryParams: {
          access_type: 'offline',
          prompt: 'consent',
        },
      },
    });
    if (error) throw error;
  };

  const signInAsGuest = async () => {
    try {
      // 1. Try Supabase anonymous auth if enabled on backend
      const { data, error } = await supabase.auth.signInAnonymously();
      if (!error && data?.user) {
        localStorage.removeItem('docutalk_guest_session');
        setUser(data.user);
        return;
      }
    } catch {
      // Anonymous sign-in not enabled or Supabase is paused
    }

    // 2. Client-side guest session with valid UUID format
    let guestId = localStorage.getItem('docutalk_guest_id');
    if (!guestId) {
      guestId = '00000000-0000-4000-8000-' + Math.random().toString(16).substring(2, 14).padEnd(12, '0');
      localStorage.setItem('docutalk_guest_id', guestId);
    }

    const guestUser: User = {
      id: guestId,
      app_metadata: { provider: 'guest' },
      user_metadata: { full_name: 'Guest Explorer', name: 'Guest Explorer' },
      aud: 'authenticated',
      created_at: new Date().toISOString(),
      email: 'guest@docutalk.ai',
      role: 'authenticated',
    } as User;

    localStorage.setItem('docutalk_guest_session', JSON.stringify(guestUser));
    setUser(guestUser);
  };

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signUp, signOut, signInWithGoogle, signInAsGuest }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
