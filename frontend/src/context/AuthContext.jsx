import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import {
  setStoredSession,
  clearStoredSession,
  getStoredAccessToken,
  getStoredUser,
  SESSION_EXPIRED_EVENT,
} from '../services';
// Direct import (not ../queries) to avoid a circular import with hooks that use useAuth
import {
  useMeQuery,
  useLoginMutation,
  useRegisterMutation,
  useLogoutMutation,
} from '../queries/auth.queries';

const AuthContext = createContext(null);

/** Password shared by every seeded test account (backend/scripts/seed.js) */
export const DEMO_PASSWORD = 'Test@123';

export const PRESEEDED_ACCOUNTS = [
  {
    name: 'Sarah Jenkins',
    email: 'sarah@yopmail.com',
    role: 'employee',
    department: 'Engineering',
    label: 'Employee',
    description: 'Engineering · reports to David',
  },
  {
    name: 'James Carter',
    email: 'james@yopmail.com',
    role: 'employee',
    department: 'Engineering',
    label: 'Employee',
    description: 'Engineering · reports to David',
  },
  {
    name: 'David Miller',
    email: 'david@yopmail.com',
    role: 'manager',
    department: 'Engineering',
    label: 'Manager',
    description: 'Engineering manager · team: Sarah, James',
  },
  {
    name: 'Marcus Vance',
    email: 'marcus@yopmail.com',
    role: 'it_admin',
    department: 'IT Infrastructure',
    label: 'IT Admin',
    description: 'Hardware & access · IT ticket queue',
  },
  {
    name: 'Alex Morgan',
    email: 'alex@yopmail.com',
    role: 'hr_admin',
    department: 'Human Resources',
    label: 'HR Admin',
    description: 'Policies & people ops · HR ticket queue',
  },
  {
    name: 'Priya Sharma',
    email: 'priya@yopmail.com',
    role: 'employee',
    department: 'Human Resources',
    label: 'Employee',
    description: 'HR · reports to Alex (not on David\'s team)',
  },
];

export function AuthProvider({ children }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState(getStoredUser);
  const [accessToken, setAccessToken] = useState(getStoredAccessToken);
  const [error, setError] = useState(null);

  // mutateAsync is referentially stable; the mutation objects themselves are not
  const { mutateAsync: loginAsync, isPending: isLoggingIn } = useLoginMutation();
  const { mutateAsync: registerAsync, isPending: isRegistering } = useRegisterMutation();
  const { mutateAsync: logoutAsync } = useLogoutMutation();

  const isAuthenticated = Boolean(user && accessToken);

  // Validate the stored session with the server and pick up profile changes
  const meQuery = useMeQuery({ userId: user?.userId, enabled: isAuthenticated });
  useEffect(() => {
    const fresh = meQuery.data;
    if (!fresh || !user) return;
    const changed = ['role', 'department', 'name', 'email', 'orgId'].some((k) => fresh[k] !== user[k]);
    if (changed) {
      const merged = { ...user, ...fresh };
      setStoredSession({ user: merged });
      setUser(merged);
    }
  }, [meQuery.data, user]);

  const resetSession = useCallback(() => {
    clearStoredSession();
    queryClient.clear();
    setUser(null);
    setAccessToken(null);
  }, [queryClient]);

  // Fired by the API client when the refresh token is rejected
  useEffect(() => {
    const handleExpired = () => {
      resetSession();
      setError('Your session has expired. Please sign in again.');
      toast.warning('Session Expired', {
        description: 'Your authentication token has expired. Please sign in again.',
      });
    };

    window.addEventListener(SESSION_EXPIRED_EVENT, handleExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleExpired);
  }, [resetSession]);

  const login = useCallback(
    async (email, password = DEMO_PASSWORD, { rememberMe = true } = {}) => {
      setError(null);
      try {
        const { user: userData, accessToken: token, refreshToken } = await loginAsync({
          email,
          password,
        });
        setStoredSession({ accessToken: token, refreshToken, user: userData, rememberMe });
        setUser(userData);
        setAccessToken(token);
        return userData;
      } catch (err) {
        const msg = err.message || 'Login failed. Please verify credentials.';
        setError(msg);
        toast.error('Authentication Failed', { description: msg });
        throw err;
      }
    },
    [loginAsync]
  );

  const register = useCallback(
    async (userData) => {
      setError(null);
      try {
        await registerAsync(userData);
      } catch (err) {
        const msg = err.message || 'Registration failed.';
        setError(msg);
        toast.error('Registration Failed', { description: msg });
        throw err;
      }
      toast.success('Registration Successful', {
        description: `Account created for ${userData.email}. Logging in...`,
      });
      // Seamless auto-login on successful registration
      return login(userData.email, userData.password);
    },
    [registerAsync, login]
  );

  const logout = useCallback(async () => {
    try {
      await logoutAsync();
    } catch {
      // Server-side revoke failed (offline / already expired) — still sign out locally
    } finally {
      resetSession();
      toast.info('Signed Out', { description: 'You have been safely signed out.' });
    }
  }, [logoutAsync, resetSession]);

  const value = useMemo(
    () => ({
      user,
      accessToken,
      isAuthenticated,
      isLoading: isLoggingIn || isRegistering,
      error,
      setError,
      login,
      register,
      logout,
      setUser,
    }),
    [user, accessToken, isAuthenticated, isLoggingIn, isRegistering, error, login, register, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
