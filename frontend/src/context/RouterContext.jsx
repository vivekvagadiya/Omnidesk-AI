import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

const RouterContext = createContext(null);

export function RouterProvider({ children }) {
  const [path, setPath] = useState(() => window.location.pathname || '/');

  useEffect(() => {
    const handlePopState = () => {
      setPath(window.location.pathname || '/');
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = useCallback((to, { replace = false } = {}) => {
    if (typeof to !== 'string') return;
    const target = to.startsWith('/') ? to : `/${to}`;
    if (replace) {
      window.history.replaceState({}, '', target);
    } else {
      window.history.pushState({}, '', target);
    }
    setPath(target);
  }, []);

  const value = {
    path,
    navigate,
  };

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter() {
  const context = useContext(RouterContext);
  if (!context) {
    throw new Error('useRouter must be used within a RouterProvider');
  }
  return context;
}

export function Link({ to, children, className, replace = false, ...props }) {
  const { navigate } = useRouter();

  const handleClick = (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to, { replace });
  };

  return (
    <a href={to} onClick={handleClick} className={className} {...props}>
      {children}
    </a>
  );
}
