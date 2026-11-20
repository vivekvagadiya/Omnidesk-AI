import React, { createContext, useContext, useState, useEffect } from 'react';
import { api, setStoredSession, clearStoredSession, getStoredAccessToken, getStoredUser } from '../services/api';

const AuthContext = createContext(null);

export const PRESEEDED_ACCOUNTS = [
  {
    name: 'Sarah Jenkins',
    email: 'sarah.j@abctech.com',
    role: 'employee',
    department: 'Engineering',
    label: 'Employee',
    description: 'Engineering Staff (Reports to David)',
  },
  {
    name: 'David Miller',
    email: 'david.m@abctech.com',
    role: 'manager',
    department: 'Engineering',
    label: 'Manager',
    description: 'Engineering Team Manager',
  },
  {
    name: 'Marcus Vance',
    email: 'it.admin@abctech.com',
    role: 'it_admin',
    department: 'IT Infrastructure',
    label: 'IT Admin',
    description: 'Hardware & Access Controller',
  },
  {
    name: 'Alex Morgan',
    email: 'hr.admin@abctech.com',
    role: 'hr_admin',
    department: 'Human Resources',
    label: 'HR Admin',
    description: 'Policy & People Ops Admin',
  },
];

export function AuthProvider({ children }) {
  const [user, setUser] = useState(getStoredUser());
  const [accessToken, setAccessToken] = useState(getStoredAccessToken());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const handleExpired = () => {
      setUser(null);
      setAccessToken(null);
      setError('Your session has expired. Please sign in again.');
    };

    window.addEventListener('omnidesk:session_expired', handleExpired);
    return () => window.removeEventListener('omnidesk:session_expired', handleExpired);
  }, []);

  const login = async (email, password = 'Password123!') => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await api.post('/auth/login', { email, password });
      const { user: userData, accessToken: token, refreshToken } = response.data.data;

      setStoredSession({
        accessToken: token,
        refreshToken,
        user: userData,
      });

      setUser(userData);
      setAccessToken(token);
      return userData;
    } catch (err) {
      const msg = err.response?.data?.message || err.message || 'Login failed. Please verify credentials.';
      setError(msg);
      throw new Error(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const register = async (userData) => {
    setIsLoading(true);
    setError(null);

    try {
      await api.post('/auth/register', userData);
      // Seamless auto-login on successful registration
      return await login(userData.email, userData.password);
    } catch (err) {
      const msg = err.response?.data?.message || err.message || 'Registration failed.';
      setError(msg);
      throw new Error(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const logout = async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      // Ignore cleanup error
    } finally {
      clearStoredSession();
      setUser(null);
      setAccessToken(null);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        accessToken,
        isAuthenticated: Boolean(user && accessToken),
        isLoading,
        error,
        setError,
        login,
        register,
        logout,
        setUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
