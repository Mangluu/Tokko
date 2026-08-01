import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Bell,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Download,
  Fingerprint,
  HeartPulse,
  Home,
  LoaderCircle,
  LogOut,
  Menu,
  MessageCircle,
  Moon,
  Plus,
  RotateCcw,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Users,
  X,
} from 'lucide-react';
import { api, phoneParts, toE164 } from './api';
import './trakko/trakko-mobile.css';

const MERCHANTS = [
  ['Setu', '/assets/merchants/setu.png'],
  ['Wellbeing Nutrition', '/assets/merchants/wellbeing-nutrition.png'],
  ['YogaBar', '/assets/merchants/yogabar.png'],
  ['Dot & Key', '/assets/merchants/dot-and-key.png'],
  ['Ritual', '/assets/merchants/ritual.png'],
  ['Momentous', '/assets/merchants/momentous.png'],
  ['Himalaya Wellness', '/assets/merchants/himalaya-wellness.png'],
  ['Dr Ortho', '/assets/merchants/dr-ortho.png'],
];

const STEP_COUNT = 6;
const STORAGE_KEY = 'tokko-hackathon-progress-v1';
let clerkBrowserPromise = null;
const INITIAL_STATE = {
  step: 0,
  profile: {
    name: 'Shivang',
    email: 'shivang@mehta.family',
    phone: '+919876543210',
    country: 'India',
  },
  members: [
    { id: 1, name: 'Asha Mehta', age: '67', gender: 'Woman', relation: 'Mother', phone: '+919876543211', channel: 'Demo contact' },
    { id: 2, name: 'Kabir Mehta', age: '71', gender: 'Man', relation: 'Father', phone: '+919876543212', channel: 'Demo contact' },
  ],
};

const ORDERS = [
  {
    member: 'Asha', initials: 'AM', merchant: 'Himalaya Wellness',
    detail: 'Vitamin D3 + Ashwagandha refill', arrival: 'Delivered today',
    payment: 'Care rule', status: 'Delivered', amount: '₹1,240',
  },
  {
    member: 'Kabir', initials: 'KM', merchant: 'Dr Ortho',
    detail: 'Pain relief oil · 120 ml', arrival: 'Awaiting your answer',
    payment: 'Approval', status: 'Needs you', amount: '₹485',
  },
  {
    member: 'Asha', initials: 'AM', merchant: 'Setu',
    detail: 'Gut health sachets · 30 pack', arrival: 'Delivered yesterday',
    payment: 'Care rule', status: 'Delivered', amount: '₹1,390',
  },
];

function clerkErrorMessage(error) {
  const details = Array.isArray(error?.errors) ? error.errors[0] : null;
  return details?.longMessage || details?.message || error?.message || 'Email verification could not be completed.';
}

function clerkVerificationAlreadyComplete(error) {
  const details = Array.isArray(error?.errors) ? error.errors : [];
  const codes = [error?.code, ...details.map((detail) => detail?.code)].filter(Boolean);
  const messages = [error?.message, ...details.flatMap((detail) => [detail?.message, detail?.longMessage])].filter(Boolean);
  return codes.includes('verification_already_verified') || messages.some((message) => /verification has already been verified/i.test(message));
}

function clerkEmailIsVerified(signUp) {
  return signUp?.verifications?.emailAddress?.status === 'verified';
}

async function browserClerk() {
  if (window.__tokkoClerkEmail) return null;
  if (!clerkBrowserPromise) {
    clerkBrowserPromise = api('/api/config')
      .then(async (config) => {
        if (!config.signupEmailVerificationConfigured || !config.clerkPublishableKey) {
          throw new Error('Email verification is not configured on this deployment.');
        }
        const { Clerk } = await import('@clerk/clerk-js');
        const clerk = new Clerk(config.clerkPublishableKey);
        await clerk.load({ appearance: { captcha: { theme: 'light', size: 'flexible', language: 'en-US' } } });
        return clerk;
      })
      .catch((error) => {
        clerkBrowserPromise = null;
        throw error;
      });
  }
  return clerkBrowserPromise;
}

async function startClerkEmailVerification(email, password) {
  if (window.__tokkoClerkEmail) return window.__tokkoClerkEmail.start({ email, password });
  const clerk = await browserClerk();
  const normalizedEmail = email.trim().toLowerCase();
  const currentSignUp = clerk.client.signUp;
  if (currentSignUp?.id && currentSignUp.emailAddress?.trim().toLowerCase() === normalizedEmail && (currentSignUp.status === 'complete' || clerkEmailIsVerified(currentSignUp))) {
    return { signUpId: currentSignUp.id, alreadyVerified: true };
  }
  try {
    const signUp = await clerk.client.signUp.create({ emailAddress: normalizedEmail, password });
    await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
    return { signUpId: signUp.id };
  } catch (error) {
    throw new Error(clerkErrorMessage(error));
  }
}

async function verifyClerkEmail(signUpId, code) {
  if (window.__tokkoClerkEmail) {
    try {
      return await window.__tokkoClerkEmail.verify({ signUpId, code });
    } catch (error) {
      if (clerkVerificationAlreadyComplete(error)) return { signUpId };
      throw new Error(clerkErrorMessage(error));
    }
  }
  const clerk = await browserClerk();
  const signUp = clerk.client.signUp;
  if (!signUp?.id || signUp.id !== signUpId) throw new Error('This signup attempt expired. Request a new code.');
  if (signUp.status === 'complete' || clerkEmailIsVerified(signUp)) return { signUpId: signUp.id };
  try {
    const verified = await signUp.attemptEmailAddressVerification({ code });
    if (verified.status !== 'complete' && !clerkEmailIsVerified(verified)) throw new Error('Clerk did not verify this email code.');
    return { signUpId: verified.id };
  } catch (error) {
    if (clerkVerificationAlreadyComplete(error)) return { signUpId };
    throw new Error(clerkErrorMessage(error));
  }
}

async function startGoogleOAuth() {
  const clerk = await browserClerk();
  const origin = window.location.origin;
  try {
    await clerk.client.signIn.authenticateWithRedirect({
      strategy: 'oauth_google',
      redirectUrl: `${origin}/sso-callback`,
      redirectUrlComplete: `${origin}/?clerk_oauth=complete`,
    });
  } catch (error) {
    throw new Error(clerkErrorMessage(error));
  }
}

async function completeGoogleOAuthCallback() {
  const clerk = await browserClerk();
  const completeUrl = `${window.location.origin}/?clerk_oauth=complete`;
  await clerk.handleRedirectCallback({
    signInFallbackRedirectUrl: completeUrl,
    signUpFallbackRedirectUrl: completeUrl,
    signInForceRedirectUrl: completeUrl,
    signUpForceRedirectUrl: completeUrl,
  });
}

async function exchangeClerkSession() {
  const clerk = await browserClerk();
  const token = await clerk.session?.getToken();
  if (!token) throw new Error('Google sign-in did not create an active session. Please try again.');
  await api('/api/auth/clerk/session', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  return api('/api/me');
}

function compactPhone(value = '') {
  return String(value).replace(/[()\s.-]/g, '');
}

function stateToUi(state) {
  const backendProfile = state?.profile;
  return {
    profile: {
      name: backendProfile?.primaryParentName || '',
      email: state?.account?.email || '',
      phone: backendProfile?.primaryParentPhone || '',
      country: 'India',
    },
    members: (backendProfile?.dependents || []).map((dependent, index) => ({
      id: dependent.id || index + 1,
      name: dependent.name || '',
      age: dependent.age ?? '',
      gender: dependent.gender || '',
      relation: dependent.relationshipToUser || 'Family',
      phone: dependent.phone || '',
      channel: 'Backend synced',
    })),
  };
}

function profilePayload(profile, members) {
  const ownerPhone = compactPhone(profile.phone);
  const ownerParts = phoneParts(ownerPhone);
  return {
    primaryParentName: profile.name.trim(),
    primaryParentPhone: toE164(ownerParts.countryCode, ownerParts.localPhone),
    primaryParentCountryCode: ownerParts.countryCode,
    primaryParentLocalPhone: ownerParts.localPhone,
    dependents: members.map((member) => {
      const parts = phoneParts(compactPhone(member.phone));
      return {
        name: member.name.trim(),
        age: member.age === '' ? null : Number(member.age),
        gender: member.gender || null,
        relationshipToUser: member.relation,
        phone: toE164(parts.countryCode, parts.localPhone),
        countryCode: parts.countryCode,
        localPhone: parts.localPhone,
      };
    }),
    merchantAuthPhone: toE164(ownerParts.countryCode, ownerParts.localPhone),
    merchantAuthSubjectType: 'account_holder',
  };
}

function findOrderArray(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (value.some((entry) => entry && typeof entry === 'object' && (entry.id || entry.orderId || entry.order_id || entry.code))) return value;
    for (const entry of value) {
      const nested = findOrderArray(entry, depth + 1);
      if (nested) return nested;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  for (const key of ['orders', 'history', 'items', 'data', 'result']) {
    if (value[key] !== undefined) {
      const nested = findOrderArray(value[key], depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

function normalizeBackendOrders(value, accountName = 'Family') {
  const rows = findOrderArray(value) || [];
  return rows.slice(0, 8).map((order, index) => {
    const products = Array.isArray(order?.productsNamesAndCounts)
      ? order.productsNamesAndCounts
      : (Array.isArray(order?.shipments) ? order.shipments : []).flatMap((shipment) => shipment?.products || []);
    const amountPaise = Number(order?.grandTotalAmount ?? order?.billSummary?.totalBill ?? order?.totalAmount);
    const status = String(order?.formattedStatus || order?.status || order?.shipments?.[0]?.formattedStatus || 'Processing');
    const itemCopy = products.slice(0, 2).map((product) => product.name || product.productName || 'Item').join(', ');
    const timestamp = order?.placedTime || order?.createdAt || order?.created_at;
    return {
      id: order?.id || order?.orderId || order?.order_id || index,
      member: accountName.split(' ')[0] || 'Family',
      initials: accountName.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase() || 'FA',
      merchant: 'Zepto',
      detail: itemCopy || `${Number(order?.itemQuantityCount || 0)} family essentials`,
      arrival: timestamp ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp)) : 'Synced from backend',
      payment: 'Backend',
      status: status.charAt(0).toUpperCase() + status.slice(1).toLowerCase(),
      amount: Number.isFinite(amountPaise) ? `₹${(amountPaise / 100).toFixed(2)}` : '—',
    };
  });
}

const DASH_NAV = [
  ['overview', 'Overview', Home],
  ['requests', 'Needs you', Bell],
  ['family', 'Family', Users],
  ['rules', 'Care rules', ShieldCheck],
  ['activity', 'Activity', Activity],
  ['settings', 'Settings', Settings],
];

function clampStep(value) {
  return Math.max(0, Math.min(Number(value) || 0, STEP_COUNT - 1));
}

function readSavedState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!saved) return INITIAL_STATE;
    return {
      ...INITIAL_STATE,
      ...saved,
      step: clampStep(saved.step),
      profile: { ...INITIAL_STATE.profile, ...(saved.profile || {}) },
      members: Array.isArray(saved.members) && saved.members.length ? saved.members : INITIAL_STATE.members,
    };
  } catch {
    return INITIAL_STATE;
  }
}

function Brand({ compact = false }) {
  return (
    <div className={`tokko-brand ${compact ? 'is-compact' : ''}`}>
      <span className="tokko-mark">t</span>
      <span>
        <strong>Tokko</strong>
        {!compact && <small>Your family care agent</small>}
      </span>
    </div>
  );
}

function ThemeButton({ theme, onToggle }) {
  return (
    <button className="tokko-icon-button" type="button" onClick={onToggle} aria-label={`Use ${theme === 'light' ? 'dark' : 'light'} mode`}>
      {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
    </button>
  );
}

function LogoMarquee() {
  const logos = [...MERCHANTS, ...MERCHANTS];
  return (
    <div className="tokko-logo-marquee" aria-label="Health and wellness merchant network">
      <div className="tokko-logo-track">
        {logos.map(([name, src], index) => (
          <figure className="tokko-logo-tile" key={`${name}-${index}`}>
            <img src={src} alt={`${name} logo`} />
          </figure>
        ))}
      </div>
    </div>
  );
}

function NavActions({ onBack, onNext, nextLabel = 'Continue', disabled = false, busy = false }) {
  return (
    <div className="tokko-actions">
      {onBack && (
        <button className="tokko-button tokko-button-ghost" type="button" onClick={onBack}>
          <ArrowLeft size={18} />
          <span>Back</span>
        </button>
      )}
      {onNext && (
        <button className="tokko-button tokko-button-primary" type="button" onClick={onNext} disabled={disabled || busy}>
          {busy && <LoaderCircle className="tokko-spinner" size={17} />}
          <span>{nextLabel}</span>
          {!busy && <ArrowRight size={18} />}
        </button>
      )}
    </div>
  );
}

function SetupProgress({ step, onBack, theme, onTheme }) {
  const stage = step - 1;
  const labels = ['Account', 'You', 'Family'];
  return (
    <header className="tokko-setup-header">
      <button className="tokko-brand-button" type="button" onClick={onBack} aria-label="Return to Tokko welcome">
        <Brand compact />
      </button>
      <div className="tokko-setup-progress" aria-label={`Setup step ${stage} of 3`}>
        {labels.map((label, index) => (
          <span className={index + 1 <= stage ? 'is-active' : ''} key={label}>
            <i>{index + 1 < stage ? <Check size={11} /> : index + 1}</i>
            <b>{label}</b>
          </span>
        ))}
      </div>
      <ThemeButton theme={theme} onToggle={onTheme} />
    </header>
  );
}

function AiPreview({ step }) {
  if (step === 2) {
    return (
      <aside className="tokko-ai-preview">
        <div className="tokko-ai-kicker"><Sparkles size={15} /> A small glimpse</div>
        <div className="tokko-phone-preview">
          <div className="tokko-phone-top"><span>Asha</span><small>Family chat</small></div>
          <p className="is-human">Beta, my vitamin D is nearly over.</p>
          <p className="is-tokko"><b>Tokko</b>I found Asha’s usual refill. It fits her care rule and can arrive tomorrow.</p>
          <span className="tokko-thinking"><i /> Checked preferences, price and budget</span>
        </div>
        <p>Family members simply message. Tokko handles the complexity quietly.</p>
      </aside>
    );
  }

  if (step === 3) {
    return (
      <aside className="tokko-ai-preview">
        <div className="tokko-ai-kicker"><Fingerprint size={15} /> You stay in control</div>
        <div className="tokko-decision-preview">
          <span className="tokko-avatar">KM</span>
          <div><small>Tokko will ask Shivang</small><strong>Only when judgment is needed</strong></div>
        </div>
        <ul className="tokko-check-list">
          <li><Check size={14} /> Unusual item or amount</li>
          <li><Check size={14} /> Outside a care rule</li>
          <li><Check size={14} /> Sensitive wellness request</li>
        </ul>
      </aside>
    );
  }

  return (
    <aside className="tokko-ai-preview">
      <div className="tokko-ai-kicker"><MessageCircle size={15} /> Messaging is the front door</div>
      <div className="tokko-family-preview">
        <div><span className="tokko-avatar">AM</span><p><strong>Asha</strong><small>“My vitamin D is almost over.”</small></p><CheckCircle2 size={16} /></div>
        <div><span className="tokko-avatar">KM</span><p><strong>Kabir</strong><small>“Can you get my pain oil?”</small></p><Clock3 size={16} /></div>
        <footer><span className="tokko-mark">t</span><p><strong>Tokko knows who is asking.</strong><small>Identity, preferences and rules stay attached.</small></p></footer>
      </div>
      <p>Each person gets simple chat. Tokko remembers who they are, what is safe, and when to ask you.</p>
    </aside>
  );
}

function AccountAccess({ onAuthenticated, initialEmail = '', initialStatus = '' }) {
  const pendingChallengeRef = useRef(null);
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [signupChallenge, setSignupChallenge] = useState(null);
  const [emailOtp, setEmailOtp] = useState('');
  const [status, setStatus] = useState(initialStatus);
  const [busy, setBusy] = useState(false);
  const verifyingSignup = mode === 'signup' && Boolean(signupChallenge);

  const changeMode = (nextMode) => {
    setMode(nextMode);
    setSignupChallenge(null);
    setEmailOtp('');
    setStatus('');
  };

  const signInWithGoogle = async () => {
    setBusy(true);
    setStatus('Opening secure Google sign-in…');
    try {
      await startGoogleOAuth();
    } catch (error) {
      setStatus(error.message);
      setBusy(false);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setStatus(verifyingSignup ? 'Verifying your email…' : mode === 'signup' ? 'Sending a verification code…' : 'Signing in…');
    try {
      if (verifyingSignup) {
        const verified = await verifyClerkEmail(signupChallenge.clerkSignUpId, emailOtp);
        await api('/api/auth/signup/verify', {
          method: 'POST',
          body: { challengeId: signupChallenge.challengeId, email, clerkSignUpId: verified.signUpId },
        });
      } else if (mode === 'signup') {
        const normalizedEmail = email.trim().toLowerCase();
        const pending = pendingChallengeRef.current;
        const challenge = pending?.email === normalizedEmail && pending?.password === password
          ? pending.result
          : await api('/api/auth/signup', { method: 'POST', body: { email, password } });
        pendingChallengeRef.current = { email: normalizedEmail, password, result: challenge };
        const prepared = await startClerkEmailVerification(email, password);
        if (prepared.alreadyVerified) {
          await api('/api/auth/signup/verify', {
            method: 'POST',
            body: { challengeId: challenge.challengeId, email, clerkSignUpId: prepared.signUpId },
          });
          pendingChallengeRef.current = null;
        } else {
          setSignupChallenge({ ...challenge, clerkSignUpId: prepared.signUpId });
          pendingChallengeRef.current = null;
          setEmailOtp('');
          setStatus(`A six-digit code was sent to ${challenge.email || email}.`);
          return;
        }
      } else {
        await api('/api/auth/login', { method: 'POST', body: { email, password } });
      }
      const state = await api('/api/me');
      setStatus('');
      onAuthenticated(state);
    } catch (error) {
      setStatus(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="tokko-auth-form" onSubmit={submit}>
      <button className="tokko-google-button" type="button" onClick={signInWithGoogle} disabled={busy}>
        <span aria-hidden="true">G</span>
        Continue with Google
        {busy ? <LoaderCircle className="tokko-spinner" size={17} /> : <ArrowRight size={17} />}
      </button>
      <div className="tokko-auth-divider"><span>or use email</span></div>
      <div className="tokko-auth-modes" aria-label="Account access method">
        <button className={mode === 'login' ? 'is-active' : ''} type="button" onClick={() => changeMode('login')}>Sign in</button>
        <button className={mode === 'signup' ? 'is-active' : ''} type="button" onClick={() => changeMode('signup')}>Create account</button>
      </div>
      <div className="tokko-auth-fields">
        <label>
          <span>Email</span>
          <input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required disabled={verifyingSignup} />
        </label>
        {!verifyingSignup && (
          <label>
            <span>Password</span>
            <input type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === 'signup' ? 'At least 10 characters' : 'Your password'} minLength={10} required />
          </label>
        )}
        {verifyingSignup && (
          <label>
            <span>Six-digit code</span>
            <input inputMode="numeric" autoComplete="one-time-code" value={emailOtp} onChange={(event) => setEmailOtp(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="123456" pattern="[0-9]{6}" required autoFocus />
          </label>
        )}
      </div>
      <button className="tokko-button tokko-button-primary tokko-auth-submit" type="submit" disabled={busy}>
        {busy ? <LoaderCircle className="tokko-spinner" size={17} /> : <ShieldCheck size={17} />}
        {verifyingSignup ? 'Verify and continue' : mode === 'signup' ? 'Create secure account' : 'Sign in to Tokko'}
        {!busy && <ArrowRight size={17} />}
      </button>
      {status && <p className={/sent to|signing|verifying|sending/i.test(status) ? 'tokko-form-status' : 'tokko-form-status is-error'} role="status">{status}</p>}
      <div className="tokko-safe-note"><ShieldCheck size={16} /><span>Google identity stays with Clerk. Tokko uses a separate HttpOnly session and never stores your password in the browser.</span></div>
    </form>
  );
}

function FormShell({ step, eyebrow, title, copy, icon: Icon, children, onHome, theme, onTheme }) {
  return (
    <section className="tokko-panel-screen">
      <SetupProgress step={step} onBack={onHome} theme={theme} onTheme={onTheme} />
      <div className="tokko-panel-layout">
        <div className="tokko-panel">
          <div className="tokko-panel-kicker">{Icon && <Icon size={16} />}<span>{eyebrow}</span></div>
          <h1>{title}</h1>
          <p className="tokko-panel-copy">{copy}</p>
          {children}
        </div>
        <AiPreview step={step} />
      </div>
    </section>
  );
}

function ApprovalCard({ status, onDecision }) {
  if (status !== 'pending') {
    const approved = status === 'approved';
    return (
      <section className={`tokko-decision-complete ${approved ? 'is-approved' : 'is-declined'}`}>
        <span>{approved ? <CheckCircle2 size={22} /> : <X size={22} />}</span>
        <div>
          <strong>{approved ? 'Approved and on its way' : 'Request declined'}</strong>
          <p>{approved ? 'Tokko sent Kabir the update in your connected family channel.' : 'Tokko let Kabir know and offered gentler alternatives.'}</p>
        </div>
        <button type="button" onClick={() => onDecision('pending')}><RotateCcw size={15} /> Reset demo</button>
      </section>
    );
  }

  return (
    <section className="tokko-approval-card">
      <div className="tokko-approval-head">
        <span className="tokko-avatar">KM</span>
        <div>
          <span className="tokko-status"><i /> Demo decision · Needs your judgment</span>
          <h2>Kabir asked for pain relief oil</h2>
          <p>Family message · local interaction demo</p>
        </div>
        <strong>₹485</strong>
      </div>
      <div className="tokko-product-line">
        <span><HeartPulse size={22} /></span>
        <div><strong>Dr Ortho Pain Relief Oil</strong><small>120 ml · Delivery by 8:20 PM</small></div>
      </div>
      <div className="tokko-ai-reason">
        <Sparkles size={16} />
        <p><b>Why Tokko paused</b>This is a new product for Kabir and falls outside his repeat-order rule. No known preference conflicts found.</p>
      </div>
      <div className="tokko-approval-actions">
        <button type="button" className="tokko-button tokko-button-ghost" onClick={() => onDecision('declined')}>Not this time</button>
        <button type="button" className="tokko-button tokko-button-primary" onClick={() => onDecision('approved')}><Fingerprint size={17} /> Approve ₹485</button>
      </div>
    </section>
  );
}

function MetricCard({ label, value, note, icon: Icon, tone }) {
  return (
    <article className={`tokko-metric-card ${tone ? `is-${tone}` : ''}`}>
      <span><Icon size={19} /></span>
      <small>{label}</small>
      <strong>{value}</strong>
      <p>{note}</p>
    </article>
  );
}

function OrdersList({ compact = false, requestStatus = 'pending', orders = ORDERS }) {
  return (
    <div className={`tokko-orders ${compact ? 'is-compact' : ''}`}>
      {orders.map((order) => {
        const isDecisionOrder = order.member === 'Kabir';
        const displayStatus = isDecisionOrder && requestStatus !== 'pending'
          ? (requestStatus === 'approved' ? 'Approved' : 'Declined')
          : order.status;
        const displayArrival = isDecisionOrder && requestStatus !== 'pending'
          ? (requestStatus === 'approved' ? 'Approved just now' : 'Declined just now')
          : order.arrival;
        return (
        <article className="tokko-order" key={`${order.member}-${order.merchant}`}>
          <span className="tokko-avatar">{order.initials}</span>
          <div className="tokko-order-main">
            <span><strong>{order.member}</strong><small>{displayArrival}</small></span>
            <b>{order.merchant}</b>
            <p>{order.detail}</p>
          </div>
          <div className="tokko-order-meta">
            <span className={displayStatus === 'Needs you' || displayStatus === 'Declined' ? 'is-attention' : ''}>{displayStatus}</span>
            <strong>{order.amount}</strong>
            <button type="button" onClick={() => downloadReceipt(order)}><Download size={14} /> Receipt</button>
          </div>
        </article>
      )})}
    </div>
  );
}

function downloadReceipt(order) {
  const receipt = [
    'Tokko care receipt', '', `Family member: ${order.member}`, `Merchant: ${order.merchant}`,
    `Item: ${order.detail}`, `Status: ${order.status}`, `Amount: ${order.amount}`,
  ].join('\n');
  const blob = new Blob([receipt], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `tokko-receipt-${order.merchant.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function formatInr(value) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(value || 0));
}

function DashboardContent({ view, requestStatus, setRequestStatus, members, profile, onView, backendData, onRefresh }) {
  const backendOrders = backendData.orders || [];
  const mandate = backendData.mandate || {};
  const approvedAmount = Number(mandate.approvedAmount || 0);
  const remaining = Number(mandate.remaining || 0);
  const spent = Math.max(approvedAmount - remaining, 0);
  if (view === 'requests') {
    return (
      <>
        <div className="tokko-page-heading"><span>DECISIONS</span><h1>Needs you</h1><p>Tokko handles the routine. These are the moments that need a human.</p></div>
        <ApprovalCard status={requestStatus} onDecision={setRequestStatus} />
      </>
    );
  }

  if (view === 'family') {
    return (
      <>
        <div className="tokko-page-heading"><span>YOUR CIRCLE</span><h1>Family</h1><p>Every person gets a simple, personal path to everyday care.</p></div>
        <div className="tokko-family-grid">
          {members.map((member) => (
            <article key={member.id}>
              <span className="tokko-avatar">{member.name.split(' ').map((part) => part[0]).join('').slice(0, 2)}</span>
              <div><strong>{member.name}</strong><p>{member.relation} · {member.age}</p></div>
              <small><MessageCircle size={14} /> {member.channel || 'Backend synced'}</small>
              <button type="button">View care profile <ChevronRight size={15} /></button>
            </article>
          ))}
          <article className="tokko-family-admin">
            <span className="tokko-avatar">{profile.name.slice(0, 2).toUpperCase()}</span>
            <div><strong>{profile.name}</strong><p>Family admin</p></div>
            <small><ShieldCheck size={14} /> Decision maker</small>
            <button type="button">Manage access <ChevronRight size={15} /></button>
          </article>
        </div>
      </>
    );
  }

  if (view === 'rules') {
    return (
      <>
        <div className="tokko-page-heading"><span>SAFE AUTONOMY</span><h1>Care rules</h1><p>Simple boundaries tell Tokko what it can handle and when it should pause.</p></div>
        <div className="tokko-rules-list">
          <article><span><RotateCcw size={18} /></span><div><strong>Repeat known essentials</strong><p>Tokko can reorder a previously approved item under ₹1,500.</p></div><b>On</b></article>
          <article><span><CircleDollarSign size={18} /></span><div><strong>Monthly family limit</strong><p>Pause before the family crosses ₹10,000 in a month.</p></div><b>₹10k</b></article>
          <article><span><ShieldCheck size={18} /></span><div><strong>New wellness products</strong><p>Always ask before buying a product nobody has used before.</p></div><b>Ask</b></article>
        </div>
      </>
    );
  }

  if (view === 'activity') {
    return (
      <>
        <div className="tokko-page-heading"><span>TRACEABLE BY DESIGN</span><h1>Activity</h1><p>A calm, transparent record of what Tokko understood and did.</p></div>
        <section className="tokko-section-card">
          {backendOrders.length ? <OrdersList requestStatus={requestStatus} orders={backendOrders} /> : <div className="tokko-empty-state"><Activity size={22} /><strong>No backend activity yet</strong><p>Orders and checkout events will appear here as soon as the connected account creates them.</p></div>}
        </section>
      </>
    );
  }

  if (view === 'settings') {
    return (
      <>
        <div className="tokko-page-heading"><span>PREFERENCES</span><h1>Settings</h1><p>Keep the agent quiet, predictable and aligned with your family.</p></div>
        <div className="tokko-settings-list">
          <label><span><strong>Decision alerts</strong><small>Notify me only when Tokko pauses.</small></span><input type="checkbox" defaultChecked /></label>
          <label><span><strong>Delivery updates</strong><small>Send family members progress in their connected channel.</small></span><input type="checkbox" defaultChecked /></label>
          <label><span><strong>Weekly care digest</strong><small>A gentle summary every Sunday.</small></span><input type="checkbox" /></label>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="tokko-overview-head">
        <div className="tokko-page-heading"><span>{new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()).toUpperCase()}</span><h1>Good morning, {profile.name.split(' ')[0] || 'there'}</h1><p>Tokko has your family’s care requests, decisions and spending in one calm place.</p></div>
        <button className="tokko-alert-chip" type="button" onClick={() => onView('requests')}><Bell size={17} /> {requestStatus === 'pending' ? '1 needs you' : 'All caught up'} <ChevronRight size={15} /></button>
      </div>
      <section className="tokko-message-banner">
        <span><MessageCircle size={20} /></span>
        <div><strong>{backendData.state?.merchantConnected ? 'Merchant connection is ready' : 'Family profile is synced'}</strong><p>{backendData.state?.merchantConnected ? 'This account can search, order and track through the Tokko backend.' : 'Hermes and messaging adapters can now resolve requests to this family.'}</p></div>
        <button type="button" onClick={() => onView('family')}>View family <ChevronRight size={15} /></button>
      </section>
      {backendData.error && <section className="tokko-backend-notice"><Clock3 size={16} /><p><strong>Some live data is unavailable.</strong>{backendData.error}</p><button type="button" onClick={onRefresh}>Retry</button></section>}
      <div className="tokko-overview-grid">
        <div><ApprovalCard status={requestStatus} onDecision={setRequestStatus} /></div>
        <div className="tokko-metrics-grid">
          <MetricCard label="Mandate used" value={formatInr(spent)} note={approvedAmount ? `of ${formatInr(approvedAmount)} approved` : 'No active Prava mandate'} icon={CircleDollarSign} />
          <MetricCard label="Backend activity" value={String(backendOrders.length + (backendData.checkoutFlows?.length || 0))} note="orders and checkout events" icon={Sparkles} tone="ai" />
          <MetricCard label="Family connected" value={String(members.length)} note={members.length === 1 ? 'one dependent synced' : 'dependents synced'} icon={Users} tone="sage" />
        </div>
      </div>
      <section className="tokko-section-card">
        <div className="tokko-section-title"><div><span>RECENT CARE</span><h2>Family activity</h2></div><button type="button" onClick={() => onView('activity')}>See all <ArrowRight size={15} /></button></div>
        {backendOrders.length ? <OrdersList compact requestStatus={requestStatus} orders={backendOrders.slice(0, 3)} /> : <div className="tokko-empty-state is-compact"><Activity size={20} /><strong>Connected, with no recent orders</strong><p>Tokko will keep this space quiet until there is something useful to show.</p></div>}
      </section>
    </>
  );
}

function Dashboard({ onBack, onLogout, members, profile, theme, onTheme, initialBackendState }) {
  const [view, setView] = useState('overview');
  const [requestStatus, setRequestStatus] = useState('pending');
  const [mobileMenu, setMobileMenu] = useState(false);
  const [backendData, setBackendData] = useState({ state: initialBackendState, orders: [], checkoutFlows: [], mandate: null, loading: true, error: '' });
  const activeLabel = DASH_NAV.find(([id]) => id === view)?.[1] || 'Overview';

  const refreshBackend = async () => {
    setBackendData((current) => ({ ...current, loading: true, error: '' }));
    try {
      const state = await api('/api/me');
      const [mandatesResult, checkoutResult, ordersResult] = await Promise.all([
        api('/api/payments/mandates').catch(() => ({ mandates: [], summary: null })),
        api('/api/checkout/activity?limit=8').catch(() => ({ checkoutFlows: [] })),
        state.merchantConnected ? api('/api/orders?limit=8&pageNumber=1').catch(() => null) : Promise.resolve(null),
      ]);
      setBackendData({
        state,
        mandate: mandatesResult.summary || null,
        checkoutFlows: checkoutResult.checkoutFlows || [],
        orders: ordersResult ? normalizeBackendOrders(ordersResult, profile.name) : [],
        loading: false,
        error: '',
      });
    } catch (error) {
      setBackendData((current) => ({ ...current, loading: false, error: error.message }));
    }
  };

  useEffect(() => {
    refreshBackend();
  }, []);

  return (
    <section className="tokko-dashboard-screen">
      <aside className={`tokko-sidebar ${mobileMenu ? 'is-open' : ''}`}>
        <div className="tokko-sidebar-top"><Brand /><button type="button" onClick={() => setMobileMenu(false)} aria-label="Close menu"><X size={19} /></button></div>
        <nav aria-label="Tokko dashboard">
          {DASH_NAV.map(([id, label, Icon]) => (
            <button className={view === id ? 'is-active' : ''} type="button" onClick={() => { setView(id); setMobileMenu(false); }} key={id}>
              <Icon size={18} /><span>{label}</span>{id === 'requests' && requestStatus === 'pending' && <b>1</b>}
            </button>
          ))}
        </nav>
        <div className="tokko-sidebar-bottom">
          <div><span className="tokko-avatar">{profile.name.slice(0, 2).toUpperCase()}</span><p><strong>{profile.name}</strong><small>Family admin</small></p></div>
          <div className="tokko-sidebar-account-actions"><button type="button" onClick={onBack}>Edit setup</button><button type="button" onClick={onLogout}><LogOut size={13} /> Sign out</button></div>
        </div>
      </aside>
      {mobileMenu && <button className="tokko-sidebar-scrim" type="button" aria-label="Close menu" onClick={() => setMobileMenu(false)} />}
      <div className="tokko-dashboard-shell">
        <header className="tokko-dashboard-header">
          <button className="tokko-icon-button tokko-menu-button" type="button" onClick={() => setMobileMenu(true)} aria-label="Open menu"><Menu size={19} /></button>
          <span>{activeLabel}</span>
          <div><span className="tokko-live-dot"><i className={backendData.error ? 'is-offline' : ''} /> {backendData.loading ? 'Syncing backend' : backendData.error ? 'Backend unavailable' : 'Backend connected'}</span><button className="tokko-icon-button" type="button" onClick={refreshBackend} aria-label="Refresh backend data"><RotateCcw size={17} /></button><ThemeButton theme={theme} onToggle={onTheme} /><button className="tokko-icon-button" type="button" onClick={() => setView('requests')} aria-label="Open decisions"><Bell size={18} />{requestStatus === 'pending' && <b>1</b>}</button></div>
        </header>
        <main className="tokko-dashboard-content">
          <DashboardContent view={view} requestStatus={requestStatus} setRequestStatus={setRequestStatus} members={members} profile={profile} onView={setView} backendData={backendData} onRefresh={refreshBackend} />
        </main>
        <nav className="tokko-mobile-nav" aria-label="Mobile dashboard">
          {DASH_NAV.slice(0, 5).map(([id, label, Icon]) => (
            <button className={view === id ? 'is-active' : ''} type="button" onClick={() => setView(id)} key={id}><Icon size={18} /><span>{label}</span></button>
          ))}
        </nav>
      </div>
    </section>
  );
}

function App() {
  const savedState = useMemo(readSavedState, []);
  const [step, setStep] = useState(savedState.step);
  const [profile, setProfile] = useState(savedState.profile);
  const [members, setMembers] = useState(savedState.members);
  const [sessionStatus, setSessionStatus] = useState('checking');
  const [authNotice, setAuthNotice] = useState('');
  const [backendState, setBackendState] = useState(null);
  const [merchantConsent, setMerchantConsent] = useState(true);
  const [saveStatus, setSaveStatus] = useState('');
  const [saveBusy, setSaveBusy] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('tokko-theme') || 'light');
  const [newMember, setNewMember] = useState({ name: '', age: '', gender: 'Woman', relation: '', phone: '' });
  const [isMemberModalOpen, setIsMemberModalOpen] = useState(false);
  const touchStartRef = useRef(null);
  const gestureLockRef = useRef(false);
  const canAddMember = newMember.name.trim() && newMember.age.trim() && newMember.gender && newMember.relation.trim() && /^\+[1-9]\d{7,14}$/.test(compactPhone(newMember.phone));

  const go = (nextStep) => {
    setStep(clampStep(nextStep));
    window.scrollTo({ left: 0, top: 0, behavior: 'smooth' });
  };

  const toggleTheme = () => setTheme((current) => current === 'light' ? 'dark' : 'light');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('tokko-theme', theme);
  }, [theme]);

  useEffect(() => {
    let active = true;
    const bootSession = async () => {
      const url = new URL(window.location.href);
      if (url.pathname === '/sso-callback') {
        setStep(2);
        await completeGoogleOAuthCallback();
        const state = await exchangeClerkSession();
        window.history.replaceState({}, '', '/');
        return state;
      }
      const googleCallback = url.searchParams.get('clerk_oauth') === 'complete';
      const state = googleCallback ? await exchangeClerkSession() : await api('/api/me');
      if (googleCallback) window.history.replaceState({}, '', '/');
      return state;
    };
    bootSession()
      .then((state) => {
        if (!active) return;
        const ui = stateToUi(state);
        setBackendState(state);
        setSessionStatus('authenticated');
        setMerchantConsent(state.merchantConsent?.consented ?? true);
        setProfile((current) => ({ ...current, ...ui.profile }));
        setMembers(ui.members);
        setStep(state.onboardingComplete ? 5 : state.profileComplete ? 4 : 3);
      })
      .catch((error) => {
        if (!active) return;
        const url = new URL(window.location.href);
        const googleCallback = url.pathname === '/sso-callback' || url.searchParams.get('clerk_oauth') === 'complete';
        if (googleCallback) {
          setAuthNotice(error.message || 'Google sign-in could not be completed.');
          setStep(2);
          window.history.replaceState({}, '', '/');
        }
        setSessionStatus('guest');
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ step, profile, members }));
  }, [members, profile, step]);

  useEffect(() => {
    window.scrollTo({ left: 0, top: 0, behavior: 'auto' });
  }, [step]);

  const canMoveByScroll = (direction) => {
    const scrollTop = window.scrollY || 0;
    const pageBottom = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight || 0);
    if (direction > 0) return scrollTop + window.innerHeight >= pageBottom - 6;
    return scrollTop <= 6;
  };

  const moveByGesture = (direction) => {
    if (isMemberModalOpen || gestureLockRef.current || !canMoveByScroll(direction)) return;
    const next = clampStep(step + direction);
    if (next === step) return;
    gestureLockRef.current = true;
    go(next);
    window.setTimeout(() => { gestureLockRef.current = false; }, 650);
  };

  const isInteractive = (target) => target instanceof Element && Boolean(target.closest('button, input, select, textarea, a'));
  const handleWheel = (event) => {
    if (step === 5 || isInteractive(event.target) || Math.abs(event.deltaY) < 28) return;
    moveByGesture(event.deltaY > 0 ? 1 : -1);
  };
  const handleTouchStart = (event) => {
    touchStartRef.current = { x: event.touches[0]?.clientX || 0, y: event.touches[0]?.clientY || 0 };
  };
  const handleTouchEnd = (event) => {
    if (step === 5 || isInteractive(event.target)) return;
    const start = touchStartRef.current;
    const end = event.changedTouches[0];
    touchStartRef.current = null;
    if (!start || !end) return;
    const dy = start.y - end.clientY;
    const dx = start.x - end.clientX;
    if (Math.abs(dy) > 70 && Math.abs(dy) > Math.abs(dx) * 1.2) moveByGesture(dy > 0 ? 1 : -1);
  };

  const addMember = () => {
    if (!canAddMember) return;
    setMembers((current) => [...current, { ...newMember, phone: compactPhone(newMember.phone), id: Date.now(), channel: 'Ready to sync' }]);
    setNewMember({ name: '', age: '', gender: 'Woman', relation: '', phone: '' });
    setIsMemberModalOpen(false);
  };

  const handleAuthenticated = (state) => {
    const ui = stateToUi(state);
    setBackendState(state);
    setSessionStatus('authenticated');
    setAuthNotice('');
    setMerchantConsent(state.merchantConsent?.consented ?? true);
    setProfile((current) => ({ ...current, ...ui.profile }));
    setMembers(ui.members);
    go(state.onboardingComplete ? 5 : state.profileComplete ? 4 : 3);
  };

  const saveFamily = async () => {
    if (sessionStatus !== 'authenticated') {
      go(2);
      return;
    }
    setSaveBusy(true);
    setSaveStatus('Saving your family securely…');
    try {
      await api('/api/onboarding/profile', { method: 'PUT', body: profilePayload(profile, members) });
      const state = await api('/api/onboarding/merchant-consent', { method: 'PUT', body: { consented: merchantConsent } });
      const ui = stateToUi(state);
      setBackendState(state);
      setProfile((current) => ({ ...current, ...ui.profile }));
      setMembers(ui.members);
      setSaveStatus('Family synced. Opening Tokko…');
      go(5);
    } catch (error) {
      setSaveStatus(error.message);
    } finally {
      setSaveBusy(false);
    }
  };

  const logout = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      // Clearing local state still returns the user to sign in if the network dropped.
    }
    try {
      const clerk = await browserClerk();
      if (clerk.session) await clerk.signOut();
    } catch {
      // Email/password accounts do not require a Clerk browser session.
    }
    localStorage.removeItem(STORAGE_KEY);
    setBackendState(null);
    setSessionStatus('guest');
    setProfile(INITIAL_STATE.profile);
    setMembers(INITIAL_STATE.members);
    go(2);
  };

  return (
    <div className={`tokko-app ${isMemberModalOpen ? 'is-modal-open' : ''}`} onWheel={handleWheel} onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
      {step === 0 && (
        <section className="tokko-image-screen tokko-entry-screen">
          <img src="/assets/trakko/storefront-tokko.png" alt="Tokko health and wellness storefront" />
          <div className="tokko-shade" />
          <div className="tokko-entry-top"><Brand /><ThemeButton theme={theme} onToggle={toggleTheme} /></div>
          <div className="tokko-entry-copy">
            <span className="tokko-eyebrow"><Sparkles size={15} /> Everyday care, beautifully handled</span>
            <h1>Care feels<br /><em>lighter</em> here.</h1>
            <p>Tokko turns family messages into safe, thoughtful health and wellness orders—while you keep the final say.</p>
            <div className="tokko-entry-actions"><button className="tokko-button tokko-button-primary" type="button" onClick={() => go(1)}>Enter Tokko <ArrowRight size={18} /></button><span><MessageCircle size={16} /> Familiar as a family group chat</span></div>
          </div>
          <button className="tokko-scroll-cue" type="button" onClick={() => go(1)}><span>Discover how</span><i><ArrowRight size={15} /></i></button>
        </section>
      )}

      {step === 1 && (
        <section className="tokko-image-screen tokko-hero-screen">
          <img src="/assets/trakko/storefront-tokko.png" alt="Tokko family care storefront" />
          <div className="tokko-shade tokko-shade-soft" />
          <div className="tokko-hero-nav"><Brand compact /><button type="button" onClick={() => go(0)}><ArrowLeft size={17} /> Exit</button></div>
          <div className="tokko-hero-copy">
            <span className="tokko-eyebrow"><MessageCircle size={15} /> Familiar as a family group chat</span>
            <h1>Your family asks.<br /><em>Tokko takes care.</em></h1>
            <p>It understands the message, finds the right essential, checks your rules and only pauses when a decision truly needs you.</p>
            <div className="tokko-agent-path" aria-label="How Tokko works"><span>Message</span><ArrowRight size={14} /><span>Understand</span><ArrowRight size={14} /><span>Check</span><ArrowRight size={14} /><span>Deliver</span></div>
            <LogoMarquee />
            <NavActions onBack={() => go(0)} onNext={() => go(2)} nextLabel="Set up my family" />
          </div>
        </section>
      )}

      {step === 2 && (
        <FormShell step={step} eyebrow="Private by design" title="One account. Your family’s care circle." copy="Sign in to the secure Tokko backend—the account that receives decisions, alerts and the occasional ‘are you sure?’" icon={ShieldCheck} onHome={() => go(0)} theme={theme} onTheme={toggleTheme}>
          {sessionStatus === 'checking' ? <div className="tokko-loading-panel"><LoaderCircle className="tokko-spinner" size={19} /> Checking your Tokko session…</div> : <AccountAccess onAuthenticated={handleAuthenticated} initialEmail={profile.email} initialStatus={authNotice} />}
          <NavActions onBack={() => go(1)} />
        </FormShell>
      )}

      {step === 3 && (
        <FormShell step={step} eyebrow="Family admin" title="Who should Tokko ask when judgment is needed?" copy="These details become the calm human checkpoint behind every uncertain request." icon={Fingerprint} onHome={() => go(0)} theme={theme} onTheme={toggleTheme}>
          <div className="tokko-form-grid">
            <label><span>Name</span><input value={profile.name} onChange={(event) => setProfile({ ...profile, name: event.target.value })} /></label>
            <label><span>Account email</span><input type="email" value={profile.email} readOnly aria-readonly="true" /></label>
            <label><span>Phone · E.164</span><input value={profile.phone} onChange={(event) => setProfile({ ...profile, phone: event.target.value })} placeholder="+919876543210" /></label>
            <label><span>Country</span><select value={profile.country} onChange={(event) => setProfile({ ...profile, country: event.target.value })}><option>India</option><option>United States</option><option>United Kingdom</option><option>Singapore</option></select></label>
          </div>
          <NavActions onBack={() => go(2)} onNext={() => go(4)} />
        </FormShell>
      )}

      {step === 4 && (
        <FormShell step={step} eyebrow="Family circle" title="Who can ask Tokko for a little help?" copy="Add the people Tokko should recognise across your family messaging channels. You can fine-tune their care preferences later." icon={Users} onHome={() => go(0)} theme={theme} onTheme={toggleTheme}>
          <div className="tokko-member-list">
            {members.map((member) => (
              <div className="tokko-member-row" key={member.id}>
                <span className="tokko-avatar">{member.name.split(' ').map((part) => part[0]).join('').slice(0, 2)}</span>
                <div><strong>{member.name}</strong><small>{member.relation} · {member.age}</small></div>
                <b><MessageCircle size={13} /> {member.channel || 'Backend synced'}</b>
              </div>
            ))}
          </div>
          <button className="tokko-add-member-trigger" type="button" onClick={() => setIsMemberModalOpen(true)}><Plus size={18} /> Add family member</button>
          <label className="tokko-consent-row"><input type="checkbox" checked={merchantConsent} onChange={(event) => setMerchantConsent(event.target.checked)} /><span><strong>Allow merchant verification</strong><small>Tokko may use the family admin number to connect supported merchants. You can revoke this later.</small></span></label>
          {saveStatus && <p className={/synced|saving/i.test(saveStatus) ? 'tokko-form-status' : 'tokko-form-status is-error'} role="status">{saveStatus}</p>}
          <NavActions onBack={() => go(3)} onNext={saveFamily} nextLabel="Sync and open Tokko" disabled={!profile.name.trim() || !/^\+[1-9]\d{7,14}$/.test(compactPhone(profile.phone)) || !merchantConsent} busy={saveBusy} />
          {isMemberModalOpen && (
            <div className="tokko-modal-layer" role="presentation" onClick={() => setIsMemberModalOpen(false)}>
              <form className="tokko-member-modal" role="dialog" aria-modal="true" aria-labelledby="member-title" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); addMember(); }}>
                <button className="tokko-modal-close" type="button" onClick={() => setIsMemberModalOpen(false)} aria-label="Close"><X size={18} /></button>
                <span className="tokko-panel-kicker"><Users size={15} /> Family circle</span>
                <h2 id="member-title">Add someone Tokko can help</h2>
                <p>A little context makes every request more personal and safer.</p>
                <div className="tokko-form-grid">
                  <label><span>Name</span><input autoFocus placeholder="Anita Mehta" value={newMember.name} onChange={(event) => setNewMember({ ...newMember, name: event.target.value })} /></label>
                  <label><span>Age</span><input inputMode="numeric" placeholder="68" value={newMember.age} onChange={(event) => setNewMember({ ...newMember, age: event.target.value })} /></label>
                  <label><span>Phone · E.164</span><input inputMode="tel" placeholder="+919876543211" value={newMember.phone} onChange={(event) => setNewMember({ ...newMember, phone: event.target.value })} /></label>
                  <label><span>Gender</span><select value={newMember.gender} onChange={(event) => setNewMember({ ...newMember, gender: event.target.value })}><option>Woman</option><option>Man</option><option>Non-binary</option><option>Prefer not to say</option></select></label>
                  <label><span>Relation</span><input placeholder="Aunt" value={newMember.relation} onChange={(event) => setNewMember({ ...newMember, relation: event.target.value })} /></label>
                </div>
                <div className="tokko-modal-actions"><button className="tokko-button tokko-button-ghost" type="button" onClick={() => setIsMemberModalOpen(false)}>Cancel</button><button className="tokko-button tokko-button-primary" type="submit" disabled={!canAddMember}>Add member <Plus size={17} /></button></div>
              </form>
            </div>
          )}
        </FormShell>
      )}

      {step === 5 && <Dashboard onBack={() => go(4)} onLogout={logout} members={members} profile={profile} theme={theme} onTheme={toggleTheme} initialBackendState={backendState} />}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
