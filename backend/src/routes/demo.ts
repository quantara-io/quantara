import { Hono } from "hono";

const demo = new Hono();

demo.get("/", (c) => {
  return c.html(DEMO_HTML);
});

export { demo };

const DEMO_HTML = `<!DOCTYPE html>
<html lang="en" class="h-full bg-gray-50">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Quantara — Sign in</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  .code-input { caret-color: transparent; }
  .code-input:focus { border-color: #4f46e5; box-shadow: 0 0 0 2px rgba(79,70,229,0.2); }
  .shake { animation: shake 0.4s ease-in-out; }
  @keyframes shake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-8px)} 75%{transform:translateX(8px)} }
  .fade-in { animation: fadeIn 0.2s ease-out; }
  @keyframes fadeIn { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
  .spinner { border:2px solid #e5e7eb; border-top-color:#4f46e5; border-radius:50%; width:16px; height:16px; animation:spin 0.6s linear infinite; display:inline-block; }
  @keyframes spin { to{transform:rotate(360deg)} }
</style>
</head>
<body class="h-full">

<div class="min-h-full flex flex-col justify-center py-12 sm:px-6 lg:px-8" id="app">

  <!-- Logo + Title -->
  <div class="sm:mx-auto sm:w-full sm:max-w-md text-center">
    <h1 class="text-2xl font-bold text-gray-900 tracking-tight">Quantara</h1>
    <p class="mt-1 text-sm text-gray-500" id="step-subtitle">Sign in to your account</p>
  </div>

  <!-- Auth Card -->
  <div class="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
    <div class="bg-white py-8 px-6 shadow-sm rounded-xl sm:px-10 border border-gray-100">

      <!-- STEP 1: Identifier (email + social) -->
      <div id="step-email" class="fade-in">
        <!-- Social buttons -->
        <div class="space-y-3">
          <button onclick="doOAuth('google')" class="w-full flex items-center justify-center gap-3 rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 transition">
            <svg class="h-5 w-5" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
            Continue with Google
          </button>
          <button onclick="doOAuth('apple')" class="w-full flex items-center justify-center gap-3 rounded-lg border border-gray-300 bg-black px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-gray-900 transition">
            <svg class="h-5 w-5" fill="currentColor" viewBox="0 0 24 24"><path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C4.24 16.7 4.89 10.5 8.8 10.3c1.17.06 1.99.68 2.69.72.99-.2 1.95-.77 3.01-.7 1.28.1 2.25.6 2.88 1.5-2.65 1.6-2.02 5.12.37 6.1-.5 1.3-.74 1.88-1.7 3.36zM12.03 10.2c-.12-2.35 1.83-4.37 4.02-4.2.3 2.52-2.3 4.42-4.02 4.2z"/></svg>
            Continue with Apple
          </button>
        </div>

        <!-- Divider -->
        <div class="relative my-6">
          <div class="absolute inset-0 flex items-center"><div class="w-full border-t border-gray-200"></div></div>
          <div class="relative flex justify-center text-sm"><span class="bg-white px-4 text-gray-400">or</span></div>
        </div>

        <!-- Email field -->
        <div>
          <label for="email" class="block text-sm font-medium text-gray-700 mb-1">Email address</label>
          <input type="email" id="email" placeholder="you@example.com" autocomplete="email"
            class="block w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 shadow-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 outline-none transition"
            onkeydown="if(event.key==='Enter')doContinue()">
          <p id="email-error" class="mt-1 text-xs text-red-500 hidden"></p>
        </div>

        <button onclick="doContinue()" id="continue-btn"
          class="mt-4 w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 transition disabled:opacity-50 disabled:cursor-not-allowed">
          Continue
        </button>

        <p class="mt-6 text-center text-xs text-gray-400">
          By continuing, you agree to our Terms of Service and Privacy Policy.
        </p>
      </div>

      <!-- STEP 2: Password (login or signup) -->
      <div id="step-password" class="fade-in hidden">
        <button onclick="goBack()" class="flex items-center text-sm text-gray-500 hover:text-gray-700 mb-4 transition">
          <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
          Back
        </button>
        <p class="text-sm text-gray-600 mb-1" id="password-email-display"></p>
        <p class="text-xs text-gray-400 mb-4" id="password-mode-label"></p>

        <!-- Signup: name field -->
        <div id="name-field" class="hidden">
          <label class="block text-sm font-medium text-gray-700 mb-1">Full name</label>
          <input type="text" id="display-name" placeholder="Your name" autocomplete="name"
            class="block w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 shadow-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 outline-none transition mb-3">
        </div>

        <label class="block text-sm font-medium text-gray-700 mb-1">Password</label>
        <input type="password" id="password" placeholder="Enter your password" autocomplete="current-password"
          class="block w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 shadow-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 outline-none transition"
          onkeydown="if(event.key==='Enter')doSubmitAuth()">

        <!-- Password strength (signup only) -->
        <div id="password-reqs" class="hidden mt-2 space-y-1">
          <p class="text-xs" id="req-length"><span class="text-gray-400">&#9679;</span> At least 8 characters</p>
        </div>

        <p id="password-error" class="mt-1 text-xs text-red-500 hidden"></p>

        <button onclick="doSubmitAuth()" id="auth-btn"
          class="mt-4 w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 transition disabled:opacity-50">
          Sign in
        </button>

        <div id="signup-toggle" class="hidden mt-3 text-center">
          <p class="text-xs text-gray-400">Don't have an account? <a href="#" onclick="toggleSignup()" class="text-indigo-500 hover:text-indigo-700">Create one</a></p>
        </div>
        <div id="login-toggle" class="hidden mt-3 text-center">
          <p class="text-xs text-gray-400">Already have an account? <a href="#" onclick="toggleLogin()" class="text-indigo-500 hover:text-indigo-700">Sign in</a></p>
        </div>

        <div class="flex flex-wrap justify-center gap-x-4 gap-y-1 mt-3 text-xs">
          <a href="#" onclick="doForgotPassword()" class="text-indigo-500 hover:text-indigo-700 transition">Forgot password?</a>
          <a href="#" onclick="doMagicLink()" class="text-indigo-500 hover:text-indigo-700 transition">Magic link</a>
          <a href="#" onclick="doPasskeyLogin()" class="text-indigo-500 hover:text-indigo-700 transition flex items-center gap-1">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 11.5V14m0-2.5v-6a1.5 1.5 0 113 0m-3 6a1.5 1.5 0 00-3 0v2a7.5 7.5 0 0015 0v-5a1.5 1.5 0 00-3 0m-6-3V11m0-5.5v-1a1.5 1.5 0 013 0v1m0 0V11m0-5.5a1.5 1.5 0 013 0v3m0 0V11"/></svg>
            Passkey
          </a>
        </div>

        <!-- Forgot password inline -->
        <div id="forgot-password-section" class="hidden mt-4 border-t border-gray-100 pt-4">
          <p class="text-sm text-gray-600 mb-3">We'll send a password reset link to <span class="font-medium" id="reset-email-display"></span></p>
          <button onclick="doSendResetEmail()" id="reset-send-btn" class="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 transition">
            Send Reset Link
          </button>
          <div id="reset-sent-msg" class="hidden mt-3 text-center">
            <div class="flex items-center justify-center gap-2 text-green-600 mb-2">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
              <span class="text-sm font-medium">Reset link sent!</span>
            </div>
            <p class="text-xs text-gray-400">Check your email and click the link to reset your password.</p>
            <button onclick="doSendResetEmail()" class="mt-2 text-xs text-indigo-500 hover:text-indigo-700">Resend</button>
          </div>
        </div>
      </div>

      <!-- STEP 3: MFA -->
      <div id="step-mfa" class="fade-in hidden">
        <button onclick="showStep('password')" class="flex items-center text-sm text-gray-500 hover:text-gray-700 mb-4 transition">
          <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
          Back
        </button>
        <div class="text-center mb-4">
          <div class="mx-auto w-12 h-12 bg-indigo-50 rounded-full flex items-center justify-center mb-3">
            <svg class="w-6 h-6 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
          </div>
          <h3 class="text-lg font-semibold text-gray-900">Two-factor authentication</h3>
          <p class="text-sm text-gray-500 mt-1" id="mfa-step-description">Enter the 6-digit code from your authenticator app</p>
        </div>

        <!-- Method selector (only shows when multiple methods available) -->
        <div id="mfa-method-tabs" class="hidden flex rounded-lg border border-gray-200 mb-4 overflow-hidden">
          <button id="mfa-tab-totp" onclick="selectMfaMethod('totp')" class="flex-1 px-3 py-2 text-xs font-medium text-center transition">Authenticator App</button>
          <button id="mfa-tab-email" onclick="selectMfaMethod('email')" class="flex-1 px-3 py-2 text-xs font-medium text-center transition border-l border-gray-200">Email Code</button>
        </div>

        <button id="mfa-send-email-btn" onclick="doSendMfaEmail()" class="hidden w-full mb-4 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 transition">
          Send Code to Email
        </button>

        <div class="flex justify-center gap-2 mb-4" id="mfa-code-boxes">
          <input type="text" maxlength="6" class="code-input w-12 h-14 text-center text-xl font-semibold border border-gray-300 rounded-lg focus:outline-none transition" data-idx="0">
          <input type="text" maxlength="6" class="code-input w-12 h-14 text-center text-xl font-semibold border border-gray-300 rounded-lg focus:outline-none transition" data-idx="1">
          <input type="text" maxlength="6" class="code-input w-12 h-14 text-center text-xl font-semibold border border-gray-300 rounded-lg focus:outline-none transition" data-idx="2">
          <input type="text" maxlength="6" class="code-input w-12 h-14 text-center text-xl font-semibold border border-gray-300 rounded-lg focus:outline-none transition" data-idx="3">
          <input type="text" maxlength="6" class="code-input w-12 h-14 text-center text-xl font-semibold border border-gray-300 rounded-lg focus:outline-none transition" data-idx="4">
          <input type="text" maxlength="6" class="code-input w-12 h-14 text-center text-xl font-semibold border border-gray-300 rounded-lg focus:outline-none transition" data-idx="5">
        </div>
        <p id="mfa-error" class="text-xs text-red-500 text-center hidden mb-2"></p>

        <button onclick="doMfaSubmit()" id="mfa-btn"
          class="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 transition disabled:opacity-50">
          Verify
        </button>

        <button onclick="doUseRecovery()" class="mt-3 w-full text-center text-xs text-gray-400 hover:text-gray-600 transition">
          Use a recovery code
        </button>
      </div>

      <!-- STEP 4: Passkey Setup (post-login) -->
      <div id="step-passkey-prompt" class="fade-in hidden">
        <div class="text-center mb-6">
          <div class="mx-auto w-12 h-12 bg-green-50 rounded-full flex items-center justify-center mb-3">
            <svg class="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 11.5V14m0-2.5v-6a1.5 1.5 0 113 0m-3 6a1.5 1.5 0 00-3 0v2a7.5 7.5 0 0015 0v-5a1.5 1.5 0 00-3 0m-6-3V11m0-5.5v-1a1.5 1.5 0 013 0v1m0 0V11m0-5.5a1.5 1.5 0 013 0v3m0 0V11"/></svg>
          </div>
          <h3 class="text-lg font-semibold text-gray-900">Enable passkey?</h3>
          <p class="text-sm text-gray-500 mt-1">Sign in faster next time with Face ID, Touch ID, or your device PIN.</p>
        </div>
        <button onclick="doPasskeySetup()" class="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 transition">
          Set up passkey
        </button>
        <button onclick="goToDashboard()" class="mt-2 w-full text-center text-sm text-gray-400 hover:text-gray-600 transition">
          Skip for now
        </button>
      </div>

      <!-- STEP: Reset Password -->
      <div id="step-reset-password" class="fade-in hidden">
        <div class="text-center mb-6">
          <div class="mx-auto w-12 h-12 bg-indigo-50 rounded-full flex items-center justify-center mb-3">
            <svg class="w-6 h-6 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/></svg>
          </div>
          <h3 class="text-lg font-semibold text-gray-900">Set new password</h3>
          <p class="text-sm text-gray-500 mt-1">Enter your new password below.</p>
        </div>

        <label class="block text-sm font-medium text-gray-700 mb-1">New password</label>
        <input type="password" id="new-password" placeholder="Min 8 characters" autocomplete="new-password"
          class="block w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 shadow-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 outline-none transition mb-3">

        <label class="block text-sm font-medium text-gray-700 mb-1">Confirm password</label>
        <input type="password" id="confirm-password" placeholder="Re-enter password" autocomplete="new-password"
          class="block w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 shadow-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 outline-none transition"
          onkeydown="if(event.key==='Enter')doResetPassword()">

        <p id="reset-pw-error" class="mt-1 text-xs text-red-500 hidden"></p>

        <button onclick="doResetPassword()" id="reset-pw-btn"
          class="mt-4 w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 transition disabled:opacity-50">
          Reset Password
        </button>

        <div id="reset-pw-success" class="hidden mt-4 text-center">
          <div class="flex items-center justify-center gap-2 text-green-600 mb-2">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
            <span class="text-sm font-medium">Password reset successfully!</span>
          </div>
          <button onclick="showStep('email')" class="text-sm text-indigo-500 hover:text-indigo-700">Sign in with new password</button>
        </div>
      </div>

      <!-- STEP 5: Success / Dashboard -->
      <div id="step-dashboard" class="fade-in hidden">
        <div class="text-center mb-6">
          <div class="mx-auto w-12 h-12 bg-green-50 rounded-full flex items-center justify-center mb-3">
            <svg class="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
          </div>
          <h3 class="text-lg font-semibold text-gray-900">Welcome back!</h3>
          <p class="text-sm text-gray-500 mt-1" id="welcome-email"></p>
        </div>

        <div class="bg-gray-50 rounded-lg p-4 space-y-3 text-sm">
          <div class="flex justify-between"><span class="text-gray-500">User ID</span><span class="text-gray-900 font-mono text-xs" id="dash-uid"></span></div>
          <div class="flex justify-between"><span class="text-gray-500">Email verified</span><span id="dash-ev"></span></div>
          <div class="flex justify-between"><span class="text-gray-500">Auth method</span><span class="text-gray-900" id="dash-method"></span></div>
          <div class="flex justify-between"><span class="text-gray-500">Role</span><span class="text-gray-900" id="dash-role"></span></div>
          <div class="flex justify-between"><span class="text-gray-500">Token expires</span><span class="text-gray-900" id="dash-exp"></span></div>
        </div>

        <div class="mt-4 grid grid-cols-2 gap-3">
          <button onclick="doMfaSetupFlow()" class="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 transition">Setup MFA</button>
          <button onclick="doPasskeySetup()" class="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 transition">Add Passkey</button>
          <button onclick="doRefresh()" class="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 transition">Refresh Token</button>
          <button onclick="doLogout()" class="rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-500 hover:bg-red-50 transition">Sign Out</button>
        </div>

        <!-- MFA status + setup -->
        <div id="mfa-status-section" class="hidden mt-4 border-t border-gray-100 pt-4">
          <h4 class="text-sm font-medium text-gray-700 mb-2">Multi-Factor Authentication</h4>
          <div id="mfa-enrolled-list" class="space-y-2 mb-3"></div>
        </div>

        <div id="mfa-setup-section" class="hidden mt-4 border-t border-gray-100 pt-4">
          <h4 class="text-sm font-medium text-gray-700 mb-3">Add MFA Method</h4>
          <div class="flex gap-2 mb-3" id="mfa-method-buttons">
            <button onclick="doTotpSetup()" class="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 transition flex items-center justify-center gap-1">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>
              Authenticator App
            </button>
            <button onclick="doEmailMfaSetup()" class="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 transition flex items-center justify-center gap-1">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
              Email Code
            </button>
          </div>
          <div id="mfa-qr-area" class="hidden text-center">
            <div class="inline-block bg-white border border-gray-200 rounded-lg p-3"><img id="mfa-qr-img" width="180" height="180"></div>
            <p class="text-xs text-gray-400 mt-2">Scan with your authenticator app</p>
            <a id="mfa-otpauth-link" href="" class="inline-block mt-2 text-xs text-indigo-500 hover:text-indigo-700 transition">Open in 1Password / authenticator app</a>
            <div class="mt-2">
              <p class="text-xs text-gray-400 mb-1">Or enter this secret manually:</p>
              <code id="mfa-secret-text" class="text-xs bg-gray-100 px-2 py-1 rounded font-mono text-gray-700 select-all cursor-pointer" title="Click to copy"></code>
            </div>
            <div class="mt-3 text-left">
              <label class="block text-xs font-medium text-gray-600 mb-1">Enter 6-digit code from authenticator app</label>
              <div class="flex gap-2">
                <input type="text" id="mfa-setup-code" maxlength="6" placeholder="123456"
                  class="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 outline-none">
                <button onclick="doMfaConfirmSetup()" class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition">Confirm</button>
              </div>
            </div>
          </div>
          <div id="recovery-codes" class="hidden mt-3 bg-yellow-50 border border-yellow-200 rounded-lg p-3">
            <p class="text-xs font-medium text-yellow-800 mb-2">Save your recovery codes:</p>
            <pre id="recovery-list" class="text-xs text-yellow-700 font-mono"></pre>
          </div>

          <!-- Email MFA setup -->
          <div id="email-mfa-area" class="hidden">
            <p class="text-sm text-gray-600 mb-3">A verification code will be sent to your email address.</p>
            <button onclick="doSendEmailMfaCode()" id="send-email-mfa-btn" class="w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition">Send Code</button>
            <div id="email-mfa-confirm" class="hidden mt-3">
              <label class="block text-xs font-medium text-gray-600 mb-1">Enter code from email</label>
              <div class="flex gap-2">
                <input type="text" id="email-mfa-code" maxlength="6" placeholder="123456"
                  class="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 outline-none">
                <button onclick="doEmailMfaConfirm()" class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition">Confirm</button>
              </div>
            </div>
          </div>
        </div>

        <!-- Passkey list -->
        <div id="passkey-section" class="hidden mt-4 border-t border-gray-100 pt-4">
          <h4 class="text-sm font-medium text-gray-700 mb-2">Registered Passkeys</h4>
          <div id="passkey-list" class="space-y-2"></div>
        </div>

        <p id="dash-msg" class="mt-3 text-xs text-center text-green-600 hidden"></p>
      </div>

    </div>
  </div>

  <!-- Toast -->
  <div id="toast" class="fixed bottom-6 left-1/2 -translate-x-1/2 hidden">
    <div class="rounded-lg px-4 py-2 text-sm font-medium shadow-lg" id="toast-inner"></div>
  </div>

</div>

<script>
const API_KEY = "qk_6734f98158e9f1fcffa9f86d27d09f05ee37ad9e50c69eba";
let accessToken = localStorage.getItem("qt_access_token") || "";
let refreshToken = localStorage.getItem("qt_refresh_token") || "";
let mfaToken = "";
let mfaAvailableMethods = [];
let mfaSelectedMethod = "totp";
let currentEmail = "", isNewUser = false;

// Restore session on page load, or handle reset token
// Check URL for OAuth fragment tokens, reset token, or magic link token
const urlParams = new URLSearchParams(window.location.search);
const hashParams = new URLSearchParams(window.location.hash.slice(1));

if (hashParams.get("access_token")) {
  // OAuth callback — tokens in URL fragment
  accessToken = hashParams.get("access_token");
  refreshToken = hashParams.get("refresh_token") || "";
  saveTokens();
  window.history.replaceState({}, "", window.location.pathname);
  toast("Signed in with Google!");
  goToDashboard();
} else if (urlParams.get("token") && urlParams.get("reset")) {
  showStep("reset-password");
} else if (urlParams.get("token") && urlParams.get("magic")) {
  doMagicLinkVerify(urlParams.get("token"));
} else if (accessToken) {
  goToDashboard();
}

function saveTokens() {
  localStorage.setItem("qt_access_token", accessToken);
  localStorage.setItem("qt_refresh_token", refreshToken);
}
function clearTokens() {
  accessToken = ""; refreshToken = ""; mfaToken = "";
  localStorage.removeItem("qt_access_token");
  localStorage.removeItem("qt_refresh_token");
}

function headers(json = true) {
  const h = { "x-api-key": API_KEY };
  if (json) h["Content-Type"] = "application/json";
  if (accessToken) h["Authorization"] = "Bearer " + accessToken;
  return h;
}

function showStep(step) {
  ["email","password","mfa","passkey-prompt","reset-password","dashboard"].forEach(s => {
    document.getElementById("step-" + s).classList.toggle("hidden", s !== step);
  });
  const subtitles = {
    email: "Sign in to your account",
    password: isNewUser ? "Create your account" : "Welcome back",
    mfa: "Verify your identity",
    "passkey-prompt": "Enhance your security",
    "reset-password": "Reset your password",
    dashboard: "",
  };
  document.getElementById("step-subtitle").textContent = subtitles[step] || "";
}

function goBack() { showStep("email"); }

function showError(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg; el.classList.remove("hidden");
  el.parentElement?.classList.add("shake");
  setTimeout(() => el.parentElement?.classList.remove("shake"), 400);
}
function hideError(id) { document.getElementById(id).classList.add("hidden"); }

function toast(msg, type = "success") {
  const t = document.getElementById("toast");
  const inner = document.getElementById("toast-inner");
  inner.textContent = msg;
  inner.className = "rounded-lg px-4 py-2 text-sm font-medium shadow-lg " +
    (type === "error" ? "bg-red-600 text-white" : "bg-gray-900 text-white");
  t.classList.remove("hidden");
  setTimeout(() => t.classList.add("hidden"), 3000);
}

function setLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (loading) { btn.disabled = true; btn.dataset.text = btn.textContent; btn.innerHTML = '<span class="spinner"></span>'; }
  else { btn.disabled = false; btn.textContent = btn.dataset.text || btn.textContent; }
}

// Step 1: Continue with email
async function doContinue() {
  const email = document.getElementById("email").value.trim();
  if (!email || !email.includes("@")) return showError("email-error", "Please enter a valid email address");
  hideError("email-error");
  currentEmail = email;

  // Show password step — user decides to sign in or create account
  isNewUser = false;

  document.getElementById("password-email-display").textContent = email;
  document.getElementById("password-mode-label").textContent = "Enter your password to continue";
  document.getElementById("name-field").classList.add("hidden");
  document.getElementById("password-reqs").classList.add("hidden");
  document.getElementById("auth-btn").textContent = "Sign in";
  document.getElementById("password").placeholder = "Enter your password";
  document.getElementById("password").autocomplete = "current-password";
  document.getElementById("signup-toggle").classList.remove("hidden");
  showStep("password");
  document.getElementById("password").focus();
}

function toggleSignup() {
  isNewUser = true;
  document.getElementById("password-mode-label").textContent = "Create a new account";
  document.getElementById("name-field").classList.remove("hidden");
  document.getElementById("password-reqs").classList.remove("hidden");
  document.getElementById("auth-btn").textContent = "Create account";
  document.getElementById("password").placeholder = "Create a password (8+ chars)";
  document.getElementById("password").autocomplete = "new-password";
  document.getElementById("signup-toggle").classList.add("hidden");
  document.getElementById("login-toggle").classList.remove("hidden");
}

function toggleLogin() {
  isNewUser = false;
  document.getElementById("password-mode-label").textContent = "Enter your password to continue";
  document.getElementById("name-field").classList.add("hidden");
  document.getElementById("password-reqs").classList.add("hidden");
  document.getElementById("auth-btn").textContent = "Sign in";
  document.getElementById("password").placeholder = "Enter your password";
  document.getElementById("password").autocomplete = "current-password";
  document.getElementById("login-toggle").classList.add("hidden");
  document.getElementById("signup-toggle").classList.remove("hidden");
}

// Step 2: Submit login or signup
async function doSubmitAuth() {
  const password = document.getElementById("password").value;
  if (password.length < 8 && isNewUser) return showError("password-error", "Password must be at least 8 characters");
  if (!password) return showError("password-error", "Please enter your password");
  hideError("password-error");

  setLoading("auth-btn", true);
  const endpoint = isNewUser ? "/api/auth/signup" : "/api/auth/login";
  const body = isNewUser
    ? { email: currentEmail, password, displayName: document.getElementById("display-name").value || undefined }
    : { email: currentEmail, password };

  try {
    const res = await fetch(endpoint, { method: "POST", headers: headers(), body: JSON.stringify(body) });
    const data = await res.json();
    setLoading("auth-btn", false);

    if (!data.success) {
      const msg = data.error?.message || "Authentication failed";
      // If user doesn't exist, suggest creating an account
      if (msg.toLowerCase().includes("not found") || msg.toLowerCase().includes("does not exist")) {
        showError("password-error", "No account found. Click 'Create one' below.");
        toggleSignup();
        return;
      }
      return showError("password-error", msg);
    }

    if (data.data.mfaRequired) {
      mfaToken = data.data.mfaToken;
      mfaAvailableMethods = data.data.availableMethods || ["totp"];
      showMfaStep();
      return;
    }

    accessToken = data.data.accessToken;
    refreshToken = data.data.refreshToken || "";
    saveTokens();
    if (isNewUser) { showStep("passkey-prompt"); }
    else { goToDashboard(); }
  } catch (e) {
    setLoading("auth-btn", false);
    showError("password-error", "Network error");
  }
}

function showMfaStep() {
  showStep("mfa");
  // Show tabs if multiple methods
  const tabs = document.getElementById("mfa-method-tabs");
  if (mfaAvailableMethods.length > 1) {
    tabs.classList.remove("hidden");
    document.getElementById("mfa-tab-totp").classList.toggle("hidden", !mfaAvailableMethods.includes("totp"));
    document.getElementById("mfa-tab-email").classList.toggle("hidden", !mfaAvailableMethods.includes("email"));
  } else {
    tabs.classList.add("hidden");
  }
  selectMfaMethod(mfaAvailableMethods[0] || "totp");
}

function selectMfaMethod(method) {
  mfaSelectedMethod = method;
  // Update tab styles
  const totpTab = document.getElementById("mfa-tab-totp");
  const emailTab = document.getElementById("mfa-tab-email");
  if (totpTab) {
    totpTab.className = "flex-1 px-3 py-2 text-xs font-medium text-center transition " +
      (method === "totp" ? "bg-indigo-600 text-white" : "text-gray-500 hover:bg-gray-50");
  }
  if (emailTab) {
    emailTab.className = "flex-1 px-3 py-2 text-xs font-medium text-center transition border-l border-gray-200 " +
      (method === "email" ? "bg-indigo-600 text-white" : "text-gray-500 hover:bg-gray-50");
  }
  // Update description and show/hide send button for email
  const desc = document.getElementById("mfa-step-description");
  const sendBtn = document.getElementById("mfa-send-email-btn");
  if (method === "email") {
    desc.textContent = "We'll send a 6-digit code to your email";
    sendBtn.classList.remove("hidden");
  } else {
    desc.textContent = "Enter the 6-digit code from your authenticator app";
    sendBtn.classList.add("hidden");
  }
  // Clear and focus code boxes
  const boxes = document.querySelectorAll("#mfa-code-boxes input");
  boxes.forEach(b => { b.value = ""; });
  boxes[0]?.focus();
}

async function doSendMfaEmail() {
  const btn = document.getElementById("mfa-send-email-btn");
  btn.textContent = "Sending...";
  btn.disabled = true;
  try {
    const res = await fetch("/api/auth/mfa/challenge", {
      method: "POST", headers: headers(),
      body: JSON.stringify({ mfaToken }),
    });
    const data = await res.json();
    if (data.success) {
      toast("Code sent to your email");
      btn.textContent = "Resend Code";
      document.getElementById("mfa-step-description").textContent = "Enter the 6-digit code sent to your email";
    } else {
      toast(data.error?.message || "Failed to send code", "error");
      btn.textContent = "Retry";
    }
  } catch {
    toast("Failed to send code", "error");
    btn.textContent = "Retry";
  }
  btn.disabled = false;
}

// Step 3: MFA verify
async function doMfaSubmit() {
  const boxes = document.querySelectorAll("#mfa-code-boxes input");
  const code = Array.from(boxes).map(b => b.value).join("");
  if (code.length !== 6) return showError("mfa-error", "Please enter all 6 digits");
  hideError("mfa-error");

  setLoading("mfa-btn", true);
  try {
    const res = await fetch("/api/auth/mfa/verify", {
      method: "POST", headers: headers(),
      body: JSON.stringify({ mfaToken, code, method: mfaSelectedMethod, trustDevice: true }),
    });
    const data = await res.json();
    setLoading("mfa-btn", false);

    if (!data.success) {
      showError("mfa-error", data.error?.message || "Invalid code");
      boxes.forEach(b => { b.value = ""; }); boxes[0].focus();
      return;
    }

    accessToken = data.data.accessToken;
    refreshToken = data.data.refreshToken || "";
    saveTokens();
    goToDashboard();
  } catch {
    setLoading("mfa-btn", false);
    showError("mfa-error", "Network error");
  }
}

function doUseRecovery() {
  const code = prompt("Enter your recovery code:");
  if (!code) return;
  mfaToken && fetch("/api/auth/mfa/verify", {
    method: "POST", headers: headers(),
    body: JSON.stringify({ mfaToken, code, method: "recovery_code" }),
  }).then(r => r.json()).then(data => {
    if (data.success && data.data) {
      accessToken = data.data.accessToken;
      refreshToken = data.data.refreshToken || "";
    saveTokens();
      goToDashboard();
    } else { toast(data.error?.message || "Invalid recovery code", "error"); }
  });
}

// MFA code boxes — auto-advance + paste support
document.querySelectorAll("#mfa-code-boxes input").forEach((input, i, all) => {
  input.addEventListener("input", () => {
    // Handle 1Password/autofill pasting multiple chars into one field
    if (input.value.length > 1) {
      const digits = input.value.replace(/[^0-9]/g, "").slice(0, 6);
      digits.split("").forEach((c, j) => { if (all[j]) all[j].value = c; });
      if (digits.length === 6) doMfaSubmit();
      return;
    }
    if (input.value && i < 5) all[i + 1].focus();
    if (i === 5 && input.value) doMfaSubmit();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Backspace" && !input.value && i > 0) all[i - 1].focus();
  });
  input.addEventListener("paste", (e) => {
    e.preventDefault();
    const paste = (e.clipboardData || window.clipboardData).getData("text").replace(/[^0-9]/g, "").slice(0, 6);
    paste.split("").forEach((c, j) => { if (all[j]) all[j].value = c; });
    if (paste.length >= 6) setTimeout(() => doMfaSubmit(), 100);
  });
});

// Password strength indicator
document.getElementById("password").addEventListener("input", () => {
  if (!isNewUser) return;
  const pw = document.getElementById("password").value;
  const el = document.getElementById("req-length");
  el.innerHTML = (pw.length >= 8 ? '<span class="text-green-500">&#10003;</span>' : '<span class="text-gray-400">&#9679;</span>') + " At least 8 characters";
});

// Reset password (from email link)
async function doResetPassword() {
  const pw = document.getElementById("new-password").value;
  const confirm = document.getElementById("confirm-password").value;
  if (pw.length < 8) return showError("reset-pw-error", "Password must be at least 8 characters");
  if (pw !== confirm) return showError("reset-pw-error", "Passwords do not match");
  hideError("reset-pw-error");

  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  if (!token) return showError("reset-pw-error", "Invalid reset link");

  setLoading("reset-pw-btn", true);
  try {
    const res = await fetch("/api/auth/password/reset", {
      method: "POST", headers: headers(),
      body: JSON.stringify({ token, newPassword: pw }),
    });
    const data = await res.json();
    setLoading("reset-pw-btn", false);
    if (data.success) {
      document.getElementById("reset-pw-btn").classList.add("hidden");
      document.getElementById("reset-pw-success").classList.remove("hidden");
    } else {
      showError("reset-pw-error", data.error?.message || "Reset failed");
    }
  } catch {
    setLoading("reset-pw-btn", false);
    showError("reset-pw-error", "Network error");
  }
}

// Forgot password
function doForgotPassword() {
  document.getElementById("forgot-password-section").classList.remove("hidden");
  document.getElementById("reset-email-display").textContent = currentEmail;
  document.getElementById("reset-sent-msg").classList.add("hidden");
}

async function doSendResetEmail() {
  const btn = document.getElementById("reset-send-btn");
  btn.textContent = "Sending...";
  btn.disabled = true;
  try {
    const res = await fetch("/api/auth/password/reset-request", {
      method: "POST", headers: headers(),
      body: JSON.stringify({ email: currentEmail }),
    });
    const data = await res.json();
    if (data.success) {
      btn.classList.add("hidden");
      document.getElementById("reset-sent-msg").classList.remove("hidden");
    } else {
      toast(data.error?.message || "Failed to send reset email", "error");
      btn.textContent = "Retry";
    }
  } catch {
    toast("Network error", "error");
    btn.textContent = "Retry";
  }
  btn.disabled = false;
}

// Magic link verify (from email link)
async function doMagicLinkVerify(token) {
  toast("Verifying magic link...");
  try {
    const res = await fetch("/api/auth/magic-link/verify", {
      method: "POST", headers: headers(),
      body: JSON.stringify({ token }),
    });
    const data = await res.json();
    if (data.success && data.data?.accessToken) {
      accessToken = data.data.accessToken;
      refreshToken = data.data.refreshToken || "";
      saveTokens();
      toast("Signed in via magic link!");
      // Clean URL
      window.history.replaceState({}, "", window.location.pathname);
      goToDashboard();
    } else if (data.data?.mfaRequired) {
      mfaToken = data.data.mfaToken;
      mfaAvailableMethods = data.data.availableMethods || ["totp"];
      window.history.replaceState({}, "", window.location.pathname);
      showMfaStep();
    } else {
      toast(data.error?.message || "Magic link expired or invalid", "error");
      showStep("email");
    }
  } catch {
    toast("Failed to verify magic link", "error");
    showStep("email");
  }
}

// OAuth — redirect directly to Aldero, which returns tokens in URL fragment
function doOAuth(provider) {
  const redirectUri = window.location.origin + window.location.pathname;
  window.location.href = "/api/auth/oauth/" + provider + "?redirect_uri=" + encodeURIComponent(redirectUri);
}

// Magic link
async function doMagicLink() {
  const res = await fetch("/api/auth/magic-link/request", {
    method: "POST", headers: headers(),
    body: JSON.stringify({ email: currentEmail }),
  });
  toast("Magic link sent! Check your email.");
}

// Passkey setup
async function doPasskeySetup() {
  try {
    const optRes = await fetch("/api/auth/passkey/register/options", { method: "POST", headers: headers() });
    const optData = await optRes.json();
    if (!optData.success) { toast("Passkey setup failed: " + (optData.error?.message || ""), "error"); return goToDashboard(); }

    // Aldero returns options nested in data.options
    const publicKeyOptions = optData.data.options || optData.data;

    // Convert base64url strings to Uint8Array for WebAuthn API
    function b64ToUint8(b64) {
      const str = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - b64.length % 4) % 4));
      return Uint8Array.from(str, c => c.charCodeAt(0));
    }

    publicKeyOptions.challenge = b64ToUint8(publicKeyOptions.challenge);
    publicKeyOptions.user.id = b64ToUint8(publicKeyOptions.user.id);
    if (publicKeyOptions.excludeCredentials) {
      publicKeyOptions.excludeCredentials = publicKeyOptions.excludeCredentials.map(c => ({
        ...c, id: b64ToUint8(c.id),
      }));
    }

    const cred = await navigator.credentials.create({ publicKey: publicKeyOptions });

    // Serialize + wrap in { response, name } as Aldero expects
    function toB64url(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary).replace(/[+]/g, '-').replace(/[/]/g, '_').replace(/=+$/, '');
    }

    const wrappedBody = {
      response: {
        id: cred.id,
        rawId: toB64url(cred.rawId),
        type: cred.type,
        response: {
          clientDataJSON: toB64url(cred.response.clientDataJSON),
          attestationObject: toB64url(cred.response.attestationObject),
          transports: cred.response.getTransports ? cred.response.getTransports() : [],
        },
      },
      name: "1Password",
    };

    const verifyRes = await fetch("/api/auth/passkey/register/verify", {
      method: "POST", headers: headers(),
      body: JSON.stringify(wrappedBody),
    });
    const verifyData = await verifyRes.json();
    if (verifyData.success) {
      toast("Passkey registered!");
      await loadPasskeys();
    } else {
      toast("Passkey verify failed: " + (verifyData.error?.message || JSON.stringify(verifyData)), "error");
    }
  } catch (e) {
    console.error("Passkey error:", e);
    toast("Passkey error: " + (e.message || String(e)), "error");
  }
  goToDashboard();
}

// Load passkey list
async function loadPasskeys() {
  if (!accessToken) return;
  try {
    const res = await fetch("/api/auth/passkey/list", { headers: headers() });
    const data = await res.json();
    const passkeys = data.data?.passkeys || data.data || [];
    const section = document.getElementById("passkey-section");
    const list = document.getElementById("passkey-list");
    section.classList.remove("hidden");
    if (Array.isArray(passkeys) && passkeys.length > 0) {
      list.innerHTML = passkeys.map(pk => {
        const name = pk.name || pk.credentialId?.slice(0, 12) || "Passkey";
        const device = pk.deviceType || "unknown";
        const enrolled = pk.enrolledAt ? new Date(pk.enrolledAt).toLocaleDateString() : "";
        const lastUsed = pk.lastUsedAt ? new Date(pk.lastUsedAt).toLocaleDateString() : "never";
        const backed = pk.backedUp ? "Synced" : "Device-bound";
        return '<div class="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2">' +
          '<div>' +
            '<p class="text-sm font-medium text-gray-800">' + name + '</p>' +
            '<p class="text-xs text-gray-400">' + device + ' &middot; ' + backed + ' &middot; Added ' + enrolled + ' &middot; Last used ' + lastUsed + '</p>' +
          '</div>' +
          '<button onclick="deletePasskey(\\'' + (pk.credentialId || pk.id || '') + '\\')" class="text-xs text-red-400 hover:text-red-600">Remove</button>' +
        '</div>';
      }).join("");
    } else {
      list.innerHTML = '<p class="text-xs text-gray-400">No passkeys registered yet. Click "Add Passkey" to set one up.</p>';
    }
  } catch {}
}

async function deletePasskey(id) {
  if (!confirm("Remove this passkey?")) return;
  await fetch("/api/auth/passkey/" + encodeURIComponent(id), { method: "DELETE", headers: headers() });
  toast("Passkey removed");
  loadPasskeys();
}

// Passkey login
async function doPasskeyLogin() {
  try {
    const optRes = await fetch("/api/auth/passkey/login/options", {
      method: "POST", headers: headers(),
      body: JSON.stringify({ email: currentEmail || undefined }),
    });
    const optData = await optRes.json();
    if (!optData.success) { toast("No passkeys found: " + (optData.error?.message || ""), "error"); return; }

    const publicKeyOptions = optData.data.options || optData.data;

    function b64ToUint8(b64) {
      const str = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - b64.length % 4) % 4));
      return Uint8Array.from(str, c => c.charCodeAt(0));
    }

    publicKeyOptions.challenge = b64ToUint8(publicKeyOptions.challenge);
    if (publicKeyOptions.allowCredentials) {
      publicKeyOptions.allowCredentials = publicKeyOptions.allowCredentials.map(c => ({
        ...c, id: b64ToUint8(c.id),
      }));
    }

    const assertion = await navigator.credentials.get({ publicKey: publicKeyOptions });

    function toB64url(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary).replace(/[+]/g, '-').replace(/[/]/g, '_').replace(/=+$/, '');
    }

    const wrappedBody = {
      response: {
        id: assertion.id,
        rawId: toB64url(assertion.rawId),
        type: assertion.type,
        response: {
          clientDataJSON: toB64url(assertion.response.clientDataJSON),
          authenticatorData: toB64url(assertion.response.authenticatorData),
          signature: toB64url(assertion.response.signature),
          userHandle: assertion.response.userHandle ? toB64url(assertion.response.userHandle) : null,
        },
      },
    };

    const verifyRes = await fetch("/api/auth/passkey/login/verify", {
      method: "POST", headers: headers(),
      body: JSON.stringify(wrappedBody),
    });
    const verifyData = await verifyRes.json();
    if (verifyData.success && verifyData.data) {
      accessToken = verifyData.data.accessToken;
      refreshToken = verifyData.data.refreshToken || "";
      saveTokens();
      toast("Signed in with passkey!");
      goToDashboard();
    } else {
      toast("Passkey login failed: " + (verifyData.error?.message || ""), "error");
    }
  } catch (e) { toast("Passkey login cancelled: " + e.message, "error"); }
}

// Dashboard
function goToDashboard() {
  showStep("dashboard");
  try {
    const payload = JSON.parse(atob(accessToken.split(".")[1]));
    document.getElementById("welcome-email").textContent = payload.email;
    document.getElementById("dash-uid").textContent = payload.sub;
    document.getElementById("dash-method").textContent = payload.auth_method;
    document.getElementById("dash-role").textContent = payload.role;
    const ev = payload.email_verified;
    document.getElementById("dash-ev").innerHTML = ev
      ? '<span class="text-green-600 font-medium">Verified</span>'
      : '<span class="text-amber-500 font-medium">Not verified</span>';
    const exp = new Date(payload.exp * 1000);
    document.getElementById("dash-exp").textContent = exp.toLocaleTimeString();
  } catch {}
  loadPasskeys();
  loadMfaStatus();
}

// MFA setup from dashboard
async function loadMfaStatus() {
  if (!accessToken) return;
  try {
    const checkRes = await fetch("/api/auth/mfa/methods", { headers: headers() });
    const checkData = await checkRes.json();
    const enrolled = checkData.data?.enrolled || [];

    const statusSection = document.getElementById("mfa-status-section");
    const enrolledList = document.getElementById("mfa-enrolled-list");

    if (enrolled.length > 0) {
      statusSection.classList.remove("hidden");
      enrolledList.innerHTML = enrolled.map(m => {
        const isTotp = m.type === "otp" || m.type === "totp";
        const isEmail = m.type === "oob" || m.type === "email";
        const isRecovery = m.type === "recovery-code";
        const icon = isTotp
          ? '<svg class="w-4 h-4 text-green-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>'
          : isEmail
          ? '<svg class="w-4 h-4 text-blue-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>'
          : isRecovery
          ? '<svg class="w-4 h-4 text-amber-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/></svg>'
          : '<svg class="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>';
        const label = isTotp ? "Authenticator App" : isEmail ? "Email Code" : isRecovery ? "Recovery Codes" : m.type;
        const date = m.enrolledAt ? new Date(m.enrolledAt).toLocaleDateString() : "";
        const extra = isRecovery && m.remaining_codes != null ? " (" + m.remaining_codes + " left)" : "";
        return '<div class="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">' + icon +
          '<span class="text-sm text-gray-700 flex-1">' + label + extra + '</span>' +
          (date ? '<span class="text-xs text-gray-400">' + date + '</span>' : '') + '</div>';
      }).join("");
    } else {
      statusSection.classList.add("hidden");
    }
  } catch {}
}

function doMfaSetupFlow() {
  // Toggle setup section visibility
  const section = document.getElementById("mfa-setup-section");
  const isHidden = section.classList.contains("hidden");
  section.classList.toggle("hidden");
  // Reset sub-sections when opening
  if (isHidden) {
    document.getElementById("mfa-qr-area").classList.add("hidden");
    document.getElementById("email-mfa-area").classList.add("hidden");
  }
}

async function doTotpSetup() {
  document.getElementById("mfa-qr-area").classList.remove("hidden");
  document.getElementById("email-mfa-area").classList.add("hidden");
  const res = await fetch("/api/auth/mfa/totp/setup", { method: "POST", headers: headers() });
  const data = await res.json();
  if (data.success && data.data) {
    const uri = data.data.otpAuthUri || data.data.qrCodeUrl || data.data.uri || "";
    const secret = data.data.secret || uri.match(/secret=([^&]+)/)?.[1] || "";
    document.getElementById("mfa-qr-img").src = "https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=" + encodeURIComponent(uri);
    document.getElementById("mfa-otpauth-link").href = uri;
    document.getElementById("mfa-secret-text").textContent = secret;
    document.getElementById("mfa-secret-text").onclick = () => { navigator.clipboard.writeText(secret); toast("Secret copied!"); };
  } else { toast("MFA setup failed: " + (data.error?.message || ""), "error"); }
}

async function doMfaConfirmSetup() {
  const code = document.getElementById("mfa-setup-code").value;
  if (!code || code.length < 6) return toast("Enter your 6-digit code", "error");
  const res = await fetch("/api/auth/mfa/totp/confirm", {
    method: "POST", headers: headers(),
    body: JSON.stringify({ code }),
  });
  const data = await res.json();
  if (data.success) {
    toast("MFA enabled successfully!");
    // Hide QR + code input, show success state
    document.getElementById("mfa-qr-area").classList.add("hidden");
    document.querySelector("#mfa-setup-section .mt-3")?.classList.add("hidden"); // hide code input
    if (data.data?.recoveryCodes) {
      document.getElementById("recovery-codes").classList.remove("hidden");
      document.getElementById("recovery-list").textContent = data.data.recoveryCodes.join("\\n");
    }
    // Replace setup button with "MFA Enabled" badge
    const setupBtn = document.querySelector('[onclick="doMfaSetupFlow()"]');
    if (setupBtn) { setupBtn.textContent = "MFA Enabled"; setupBtn.classList.add("text-green-600","border-green-200"); setupBtn.setAttribute("disabled","true"); }
  } else {
    const msg = data.error?.message || "Invalid code";
    toast(msg, "error");
  }
}

// Email MFA setup
async function doEmailMfaSetup() {
  document.getElementById("email-mfa-area").classList.remove("hidden");
  document.getElementById("mfa-qr-area").classList.add("hidden");
  // Immediately send the code
  await doSendEmailMfaCode();
}

async function doSendEmailMfaCode() {
  const btn = document.getElementById("send-email-mfa-btn");
  btn.textContent = "Sending...";
  btn.disabled = true;
  try {
    const res = await fetch("/api/auth/mfa/email/setup", { method: "POST", headers: headers() });
    const data = await res.json();
    if (data.success) {
      toast("Verification code sent to your email");
      document.getElementById("email-mfa-confirm").classList.remove("hidden");
      btn.textContent = "Resend Code";
    } else {
      toast(data.error?.message || "Failed to send code", "error");
      btn.textContent = "Retry";
    }
  } catch (e) {
    toast("Network error: " + e.message, "error");
    btn.textContent = "Retry";
  }
  btn.disabled = false;
}

async function doEmailMfaConfirm() {
  const code = document.getElementById("email-mfa-code").value;
  if (!code || code.length < 6) return toast("Enter the 6-digit code", "error");
  const res = await fetch("/api/auth/mfa/email/confirm", {
    method: "POST", headers: headers(),
    body: JSON.stringify({ code }),
  });
  const data = await res.json();
  if (data.success) {
    toast("Email MFA enabled!");
    document.getElementById("email-mfa-area").classList.add("hidden");
    if (data.data?.recoveryCodes) {
      document.getElementById("recovery-codes").classList.remove("hidden");
      document.getElementById("recovery-list").textContent = data.data.recoveryCodes.join("\\n");
    }
    doMfaSetupFlow(); // refresh status
  } else {
    toast(data.error?.message || "Invalid code", "error");
  }
}

// Refresh token
async function doRefresh() {
  if (!refreshToken) return toast("No refresh token", "error");
  const res = await fetch("/api/auth/token/refresh", {
    method: "POST", headers: headers(),
    body: JSON.stringify({ refreshToken }),
  });
  const data = await res.json();
  if (data.success && data.data) {
    accessToken = data.data.accessToken || accessToken;
    refreshToken = data.data.refreshToken || refreshToken;
    saveTokens();
    goToDashboard();
    const msg = document.getElementById("dash-msg");
    msg.textContent = "Token refreshed!"; msg.classList.remove("hidden");
    setTimeout(() => msg.classList.add("hidden"), 2000);
  } else { toast("Refresh failed", "error"); }
}

// Logout
async function doLogout() {
  try { await fetch("/api/auth/logout", { method: "POST", headers: headers() }); } catch {}
  clearTokens();
  showStep("email");
  toast("Signed out");
}
</script>
</body>
</html>`;
