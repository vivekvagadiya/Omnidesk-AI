import React, { useState } from 'react';
import { toast } from 'sonner';
import { useAuth, PRESEEDED_ACCOUNTS } from '../../context/AuthContext';
import {
  ShieldCheck,
  ArrowRight,
  Lock,
  Mail,
  User,
  UserCheck,
} from 'lucide-react';

export function LoginView() {
  const { login, register, isLoading, error, setError } = useAuth();
  const [mode, setMode] = useState('login'); // 'login' | 'register'

  // Login form state
  const [loginEmail, setLoginEmail] = useState('sarah.j@abctech.com');
  const [loginPassword, setLoginPassword] = useState('Password123!');

  // Register form state
  const [regName, setRegName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regOrgId, setRegOrgId] = useState('abctech');
  const [regDepartment, setRegDepartment] = useState('Engineering');
  const [regRole, setRegRole] = useState('employee');

  const handleLoginSubmit = async (e) => {
    e.preventDefault();
    try {
      const u = await login(loginEmail, loginPassword);
      toast.success(`Welcome back, ${u.name || 'User'}!`, {
        description: `Signed in as ${u.role} (${u.department})`,
      });
    } catch {
      // Handled in AuthContext
    }
  };

  const handleRegisterSubmit = async (e) => {
    e.preventDefault();

    // Basic password strength check on client
    if (regPassword.length < 8) {
      setError?.('Password must be at least 8 characters long.');
      toast.error('Validation Error', { description: 'Password must be at least 8 characters long.' });
      return;
    }
    if (!/[A-Z]/.test(regPassword) || !/[a-z]/.test(regPassword) || !/\d/.test(regPassword)) {
      setError?.('Password must contain at least 1 uppercase, 1 lowercase letter, and 1 number.');
      toast.error('Validation Error', {
        description: 'Password must contain at least 1 uppercase, 1 lowercase letter, and 1 number.',
      });
      return;
    }

    try {
      const u = await register({
        name: regName.trim(),
        email: regEmail.trim(),
        password: regPassword,
        orgId: regOrgId.trim() || 'abctech',
        department: regDepartment,
        role: regRole,
      });
      toast.success(`Welcome to OmniDesk, ${u.name}!`, {
        description: `Registered and signed in as ${u.role}.`,
      });
    } catch {
      // Handled in AuthContext
    }
  };

  const handleQuickLogin = async (acc) => {
    if (mode !== 'login') setMode('login');
    setLoginEmail(acc.email);
    setLoginPassword('Password123!');
    try {
      const u = await login(acc.email, 'Password123!');
      toast.success(`Switched to ${acc.label}`, {
        description: `Logged in as ${u.name} (${u.role})`,
      });
    } catch {
      // Handled
    }
  };

  const switchMode = (newMode) => {
    setMode(newMode);
    if (setError) setError(null);
  };

  return (
    <div className="min-h-screen bg-[#090a0f] text-zinc-100 flex flex-col justify-center items-center px-4 py-8">
      <div className="w-full max-w-4xl grid md:grid-cols-2 rounded-2xl border border-zinc-800 bg-[#0f1117] overflow-hidden">
        
        {/* Left Side: Brand & Quick Role Switcher */}
        <div className="p-8 border-b md:border-b-0 md:border-r border-zinc-800 flex flex-col justify-between bg-[#0b0d13]">
          <div>
            <div className="flex items-center gap-2 mb-6">
              <div className="w-8 h-8 rounded-lg bg-zinc-800 border border-zinc-700 flex items-center justify-center text-zinc-100 font-mono font-bold text-sm">
                OD
              </div>
              <span className="font-semibold text-lg tracking-tight">OmniDesk AI</span>
              <span className="ml-1 text-[10px] font-mono uppercase bg-zinc-800/80 text-zinc-400 px-1.5 py-0.5 rounded border border-zinc-700">
                v1.0
              </span>
            </div>

            <h2 className="text-xl font-medium tracking-tight mb-2">
              Enterprise Operations Copilot
            </h2>
            <p className="text-xs text-zinc-400 mb-6 leading-relaxed">
              Ground-truth RAG policies, multi-tenant isolation, and cryptographically staged Human-in-the-Loop workflows.
            </p>

            <div className="space-y-2">
              <span className="text-[11px] font-mono uppercase text-zinc-500 tracking-wider">
                1-Click Role Switcher (Demo Accounts)
              </span>
              <div className="space-y-1.5 pt-1">
                {PRESEEDED_ACCOUNTS.map((acc) => (
                  <button
                    key={acc.email}
                    onClick={() => handleQuickLogin(acc)}
                    disabled={isLoading}
                    className="w-full text-left px-3 py-2 rounded-lg border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/40 transition-colors flex items-center justify-between group"
                  >
                    <div>
                      <div className="text-xs font-medium text-zinc-200 group-hover:text-white flex items-center gap-1.5">
                        {acc.name}
                        <span className="text-[10px] font-mono text-zinc-500 uppercase px-1 py-0.2 rounded bg-zinc-900 border border-zinc-800">
                          {acc.label}
                        </span>
                      </div>
                      <div className="text-[11px] text-zinc-400">{acc.description}</div>
                    </div>
                    <ArrowRight className="w-3.5 h-3.5 text-zinc-600 group-hover:text-zinc-300 transition-transform group-hover:translate-x-0.5" />
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="pt-6 border-t border-zinc-800/80 text-[11px] text-zinc-400 flex items-center justify-between">
            <span className="flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" /> AES-256 JWT & RBAC Gates
            </span>
            <span className="font-mono text-zinc-400">Org: abctech</span>
          </div>
        </div>

        {/* Right Side: Auth Forms (Sign In & Register) */}
        <div className="p-8 flex flex-col justify-center">
          {/* Segmented Mode Selector */}
          <div className="flex rounded-lg bg-zinc-900/90 p-1 border border-zinc-800 mb-6">
            <button
              type="button"
              onClick={() => switchMode('login')}
              className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${
                mode === 'login'
                  ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => switchMode('register')}
              className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${
                mode === 'register'
                  ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Register User
            </button>
          </div>

          <div className="mb-4">
            <h3 className="text-base font-medium text-zinc-100">
              {mode === 'login' ? 'Sign in to your organization' : 'Register New Corporate User'}
            </h3>
            <p className="text-xs text-zinc-400 mt-0.5">
              {mode === 'login'
                ? 'Enter your corporate credentials or choose a quick role.'
                : 'Create an employee or administrator account with instant role assignment.'}
            </p>
          </div>

          {error && (
            <div className="mb-4 p-2.5 rounded-lg bg-red-950/30 border border-red-900/60 text-red-300 text-xs">
              {error}
            </div>
          )}

          {/* SIGN IN FORM */}
          {mode === 'login' ? (
            <form onSubmit={handleLoginSubmit} className="space-y-3.5">
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">
                  Corporate Email
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-zinc-400 absolute left-3 top-2.5" />
                  <input
                    type="email"
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    required
                    placeholder="name@company.com"
                    className="w-full pl-9 pr-3 py-2 bg-zinc-900/80 border border-zinc-800 rounded-lg text-xs text-zinc-100 focus:outline-none focus:border-zinc-600 transition-colors placeholder:text-zinc-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">
                  Password
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-zinc-400 absolute left-3 top-2.5" />
                  <input
                    type="password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    required
                    placeholder="••••••••"
                    className="w-full pl-9 pr-3 py-2 bg-zinc-900/80 border border-zinc-800 rounded-lg text-xs text-zinc-100 focus:outline-none focus:border-zinc-600 transition-colors placeholder:text-zinc-500"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-2.5 bg-zinc-100 text-zinc-900 font-medium text-xs rounded-lg hover:bg-white active:scale-[0.99] transition-all flex items-center justify-center gap-1.5 disabled:opacity-50 mt-2"
              >
                {isLoading ? (
                  <span>Signing in...</span>
                ) : (
                  <>
                    <span>Sign In</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </>
                )}
              </button>

              <div className="pt-2 text-center">
                <span className="text-[11px] text-zinc-500">
                  Demo password: <code className="text-zinc-400 font-mono">Password123!</code>
                </span>
              </div>
            </form>
          ) : (
            /* REGISTER USER FORM */
            <form onSubmit={handleRegisterSubmit} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">
                  Full Name
                </label>
                <div className="relative">
                  <User className="w-4 h-4 text-zinc-400 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    value={regName}
                    onChange={(e) => setRegName(e.target.value)}
                    required
                    placeholder="e.g. John Doe"
                    className="w-full pl-9 pr-3 py-2 bg-zinc-900/80 border border-zinc-800 rounded-lg text-xs text-zinc-100 focus:outline-none focus:border-zinc-600 transition-colors placeholder:text-zinc-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">
                  Corporate Email
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-zinc-400 absolute left-3 top-2.5" />
                  <input
                    type="email"
                    value={regEmail}
                    onChange={(e) => setRegEmail(e.target.value)}
                    required
                    placeholder="john.doe@abctech.com"
                    className="w-full pl-9 pr-3 py-2 bg-zinc-900/80 border border-zinc-800 rounded-lg text-xs text-zinc-100 focus:outline-none focus:border-zinc-600 transition-colors placeholder:text-zinc-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">
                  Password <span className="text-[10px] text-zinc-500 font-normal">(min 8, Aa1)</span>
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-zinc-400 absolute left-3 top-2.5" />
                  <input
                    type="password"
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                    required
                    placeholder="Password123!"
                    className="w-full pl-9 pr-3 py-2 bg-zinc-900/80 border border-zinc-800 rounded-lg text-xs text-zinc-100 focus:outline-none focus:border-zinc-600 transition-colors placeholder:text-zinc-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-xs font-medium text-zinc-400 mb-1">
                    Department
                  </label>
                  <select
                    value={regDepartment}
                    onChange={(e) => setRegDepartment(e.target.value)}
                    className="w-full px-2.5 py-2 bg-zinc-900/80 border border-zinc-800 rounded-lg text-xs text-zinc-200 focus:outline-none focus:border-zinc-600 font-sans"
                  >
                    <option value="Engineering">Engineering</option>
                    <option value="IT Infrastructure">IT Infrastructure</option>
                    <option value="Human Resources">Human Resources</option>
                    <option value="Finance">Finance</option>
                    <option value="Operations">Operations</option>
                    <option value="General">General</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-zinc-400 mb-1">
                    Role
                  </label>
                  <select
                    value={regRole}
                    onChange={(e) => setRegRole(e.target.value)}
                    className="w-full px-2.5 py-2 bg-zinc-900/80 border border-zinc-800 rounded-lg text-xs text-zinc-200 focus:outline-none focus:border-zinc-600 font-mono text-[11px]"
                  >
                    <option value="employee">employee</option>
                    <option value="manager">manager</option>
                    <option value="it_admin">it_admin</option>
                    <option value="hr_admin">hr_admin</option>
                    <option value="org_admin">org_admin</option>
                  </select>
                </div>
              </div>

              <div className="pt-1">
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-2.5 bg-zinc-100 text-zinc-900 font-medium text-xs rounded-lg hover:bg-white active:scale-[0.99] transition-all flex items-center justify-center gap-1.5 disabled:opacity-50"
                >
                  {isLoading ? (
                    <span>Creating Account...</span>
                  ) : (
                    <>
                      <UserCheck className="w-3.5 h-3.5" />
                      <span>Create Account & Sign In</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          )}

          <div className="mt-4 pt-3 border-t border-zinc-800/60 text-center">
            {mode === 'login' ? (
              <span className="text-[11px] text-zinc-400">
                Need a new user profile?{' '}
                <button
                  type="button"
                  onClick={() => switchMode('register')}
                  className="text-zinc-200 hover:text-white underline underline-offset-2 font-medium"
                >
                  Register here
                </button>
              </span>
            ) : (
              <span className="text-[11px] text-zinc-400">
                Already registered?{' '}
                <button
                  type="button"
                  onClick={() => switchMode('login')}
                  className="text-zinc-200 hover:text-white underline underline-offset-2 font-medium"
                >
                  Sign in
                </button>
              </span>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
