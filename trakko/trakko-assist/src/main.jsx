import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Banknote,
  Bell,
  Check,
  CheckCircle2,
  CircleAlert,
  CircleDollarSign,
  Clock3,
  CreditCard,
  ChevronDown,
  ExternalLink,
  Fingerprint,
  House,
  LayoutDashboard,
  Link2,
  ListFilter,
  LockKeyhole,
  LogOut,
  MapPin,
  MessageCircle,
  Mic,
  MicOff,
  Minus,
  MoreHorizontal,
  PackageCheck,
  Paperclip,
  Plug,
  Plus,
  ReceiptText,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  ShoppingBag,
  ShoppingCart,
  Sparkles,
  Store,
  Trash2,
  UserRound,
  Users,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import './styles.css';
import {
  api,
  DEPENDENT_RELATIONSHIPS,
  normalizeLocalPhone,
  onboardingPayload,
  phoneParts,
  setupFromUserState,
  toE164,
} from './api';

const STEPS = [
  { id: 'profile', label: 'Your details', icon: UserRound },
  { id: 'family', label: 'Your family', icon: Users },
  { id: 'zepto', label: 'Connect Zepto', icon: Store },
  { id: 'card', label: 'Add card', icon: CreditCard },
  { id: 'approvals', label: 'Approvals', icon: Fingerprint },
  { id: 'mandate', label: 'Set mandate', icon: ShieldCheck },
  { id: 'review', label: 'Review', icon: CheckCircle2 },
];

const FLOW_VERSION = 'scroll-v3';
let clerkBrowserPromise = null;

const DELIVERY_COUNTRY_OPTIONS = [
  { code: 'IN', label: 'India (IN)' },
  { code: 'US', label: 'United States (US)' },
  { code: 'GB', label: 'United Kingdom (GB)' },
  { code: 'AE', label: 'United Arab Emirates (AE)' },
  { code: 'SG', label: 'Singapore (SG)' },
  { code: 'AU', label: 'Australia (AU)' },
  { code: 'CA', label: 'Canada (CA)' },
];

const PHONE_COUNTRY_CODE_OPTIONS = [
  { code: '+91', label: 'IN +91' },
  { code: '+1', label: 'US/CA +1' },
  { code: '+44', label: 'UK +44' },
  { code: '+61', label: 'AU +61' },
  { code: '+65', label: 'SG +65' },
  { code: '+971', label: 'AE +971' },
];

function clerkErrorMessage(error) {
  const details = Array.isArray(error?.errors) ? error.errors[0] : null;
  return (
    details?.longMessage
    || details?.message
    || error?.message
    || 'Clerk could not complete email verification. Please try again.'
  );
}

function clerkVerificationAlreadyComplete(error) {
  const details = Array.isArray(error?.errors) ? error.errors : [];
  const codes = [
    error?.code,
    ...details.map((detail) => detail?.code),
  ].filter(Boolean);
  const messages = [
    error?.message,
    ...details.flatMap((detail) => [detail?.message, detail?.longMessage]),
  ].filter(Boolean);
  return (
    codes.some((code) => code === 'verification_already_verified')
    || messages.some((message) => /verification has already been verified/i.test(message))
  );
}

function clerkEmailIsVerified(signUp) {
  return signUp?.verifications?.emailAddress?.status === 'verified';
}

async function browserClerk() {
  if (window.__tokkoClerkEmail) return null;
  if (!clerkBrowserPromise) {
    clerkBrowserPromise = api('/api/config')
      .then(async (config) => {
        if (
          !config.signupEmailVerificationConfigured
          || !config.clerkPublishableKey
        ) {
          throw new Error('Email verification is not configured.');
        }
        const { Clerk } = await import('@clerk/clerk-js');
        const clerk = new Clerk(config.clerkPublishableKey);
        await clerk.load({
          appearance: {
            captcha: {
              theme: 'light',
              size: 'flexible',
              language: 'en-US',
            },
          },
        });
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
  if (window.__tokkoClerkEmail) {
    return window.__tokkoClerkEmail.start({ email, password });
  }
  const clerk = await browserClerk();
  const normalizedEmail = email.trim().toLowerCase();
  const currentSignUp = clerk.client.signUp;
  if (
    currentSignUp?.id
    && currentSignUp.emailAddress?.trim().toLowerCase() === normalizedEmail
    && (
      currentSignUp.status === 'complete'
      || clerkEmailIsVerified(currentSignUp)
    )
  ) {
    return {
      signUpId: currentSignUp.id,
      alreadyVerified: true,
    };
  }
  try {
    const signUp = await clerk.client.signUp.create({
      emailAddress: normalizedEmail,
      password,
    });
    await signUp.prepareEmailAddressVerification({
      strategy: 'email_code',
    });
    return { signUpId: signUp.id };
  } catch (error) {
    throw new Error(clerkErrorMessage(error));
  }
}

async function resendClerkEmailVerification(signUpId) {
  if (window.__tokkoClerkEmail) {
    return window.__tokkoClerkEmail.resend({ signUpId });
  }
  const clerk = await browserClerk();
  const signUp = clerk.client.signUp;
  if (!signUp?.id || signUp.id !== signUpId) {
    throw new Error('This signup attempt expired. Change the email and try again.');
  }
  try {
    await signUp.prepareEmailAddressVerification({
      strategy: 'email_code',
    });
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
      if (clerkVerificationAlreadyComplete(error)) {
        return { signUpId };
      }
      throw new Error(clerkErrorMessage(error));
    }
  }
  const clerk = await browserClerk();
  const signUp = clerk.client.signUp;
  if (!signUp?.id || signUp.id !== signUpId) {
    throw new Error('This signup attempt expired. Request a new code.');
  }
  if (signUp.status === 'complete' || clerkEmailIsVerified(signUp)) {
    return { signUpId: signUp.id };
  }
  try {
    const verified = await signUp.attemptEmailAddressVerification({ code });
    if (
      verified.status !== 'complete'
      && !clerkEmailIsVerified(verified)
    ) {
      throw new Error('Clerk did not verify this email code.');
    }
    return {
      signUpId: verified.id,
    };
  } catch (error) {
    if (clerkVerificationAlreadyComplete(error)) {
      return { signUpId };
    }
    throw new Error(clerkErrorMessage(error));
  }
}

const initialSetup = {
  account: null,
  profile: {
    name: '',
    age: '',
    gender: '',
    genderDescription: '',
    phone: '',
    countryCode: '+91',
    localPhone: '',
    country: 'India',
    postal: '',
  },
  card: { connected: false, last4: '', brand: '' },
  cards: [],
  passkeyActive: false,
  zeptoConnected: false,
  zeptoPhone: '',
  deliveryPreference: null,
  familyName: 'My Family',
  members: [],
  merchantAuthPhone: 'account_holder',
  merchantConsent: false,
  mandate: {
    active: false,
    period: 'Monthly',
    total: 500,
    remaining: 0,
    currency: 'INR',
    status: 'inactive',
    renewsAt: null,
    perOrder: 60,
    groceries: true,
    medicines: true,
    codFallback: true,
  },
};

function readStoredValue(key, fallback) {
  const value = localStorage.getItem(key);
  if (value === null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function usePersistentState(key, initialValue) {
  const [value, setValue] = useState(() => readStoredValue(key, initialValue));

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue];
}

function usePersistentSetup() {
  const [setup, setSetup] = useState(() => {
    try {
      const saved = localStorage.getItem('tokko-setup') || localStorage.getItem('chotu-setup') || localStorage.getItem('prava-family-setup');
      if (!saved) return initialSetup;
      const parsed = JSON.parse(saved);
      return {
        ...initialSetup,
        ...parsed,
        card: parsed.card?.preview ? initialSetup.card : (parsed.card || initialSetup.card),
        cards: Array.isArray(parsed.cards) ? parsed.cards : initialSetup.cards,
        profile: { ...initialSetup.profile, ...(parsed.profile || {}) },
        members: (parsed.members || initialSetup.members).map((member) => ({
          ...member,
          ...phoneParts(member.phone),
          channel: 'Phone',
        })),
      };
    } catch {
      return initialSetup;
    }
  });

  useEffect(() => {
    localStorage.setItem('tokko-setup', JSON.stringify(setup));
  }, [setup]);

  return [setup, setSetup];
}

const SHOPPER_SESSION_MESSAGES_KEY = 'tokko-shopper-session-messages-v1';
const SHOPPER_SESSION_ADDRESS_KEY = 'tokko-shopper-session-address-v1';

function readShopperSession(key, fallback) {
  try {
    const value = sessionStorage.getItem(key);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function safeShopperSessionMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => !message.pending && message.content)
    .slice(-100)
    .map((message) => ({
      id: String(message.id || `shopper-session-${Date.now()}`),
      role: message.role === 'user' ? 'user' : 'assistant',
      content: String(message.content || '').slice(0, 12_000),
      ...(Array.isArray(message.tools) && message.tools.length
        ? {
            tools: message.tools.map((tool) => ({
              name: String(tool.name || 'tool'),
              status: String(tool.status || 'completed'),
              ...(tool.error ? { error: String(tool.error).slice(0, 1_000) } : {}),
            })),
          }
        : {}),
    }));
}

function Brand({ compact = false }) {
  return (
    <div className="brand" aria-label="Tokko - your personal shopping assistant">
      <span className="brand-mark" aria-hidden="true">t</span>
      {!compact && <span className="brand-copy"><strong className="brand-name">Tokko</strong><span className="brand-tagline">Your personal shopping assistant</span></span>}
    </div>
  );
}

function AisleBackdrop({ depth = 0, scene = 'aisle' }) {
  const imageSource = scene === 'trakko'
    ? '/assets/trakko/storefront-hero.png'
    : scene === 'studio'
      ? '/assets/tokko-studio.png'
      : '/assets/tokko-aisle.png';
  return (
    <div className={`aisle-backdrop ${scene}`} aria-hidden="true">
      <img
        src={imageSource}
        alt=""
        style={{ '--aisle-depth': depth, '--aisle-shift': `${depth * -4}%` }}
      />
      <div className="ambient-shoppers">
        <span className="ambient-shopper shopper-one"><i className="shopper-head" /><i className="shopper-body" /><i className="shopper-arm" /><i className="shopper-leg leg-one" /><i className="shopper-leg leg-two" /></span>
        <span className="ambient-shopper shopper-two"><i className="shopper-head" /><i className="shopper-body" /><i className="shopper-arm" /><i className="shopper-leg leg-one" /><i className="shopper-leg leg-two" /></span>
        <span className="ambient-shopper shopper-three"><i className="shopper-head" /><i className="shopper-body" /><i className="shopper-arm" /><i className="shopper-leg leg-one" /><i className="shopper-leg leg-two" /></span>
      </div>
      <div className="aisle-wash" />
    </div>
  );
}

function Entry({ initialScreen = 0, onScreenChange, onEnter }) {
  const [screen, setScreen] = useState(initialScreen === 1 ? 'about' : 'welcome');
  const [opening, setOpening] = useState(initialScreen === 1);
  const entryRef = useRef(null);
  const enteringRef = useRef(false);
  const wheelLockRef = useRef(false);

  useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const page = entryRef.current;
      if (!page) return;
      if (initialScreen === 1) page.scrollTop = page.clientHeight;
      page.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialScreen]);

  const moveOneScreen = (direction) => {
    const page = entryRef.current;
    if (!page || wheelLockRef.current) return;
    const current = Math.round(page.scrollTop / Math.max(page.clientHeight, 1));
    const target = Math.max(0, Math.min(current + direction, 2));
    if (target === current) return;
    wheelLockRef.current = true;
    page.scrollTo({ top: target * page.clientHeight, behavior: 'smooth' });
    window.setTimeout(() => { wheelLockRef.current = false; }, 980);
  };

  useEffect(() => {
    const page = entryRef.current;
    if (!page) return undefined;
    const handleWheel = (event) => {
      if (Math.abs(event.deltaY) < 8) return;
      event.preventDefault();
      moveOneScreen(event.deltaY > 0 ? 1 : -1);
    };
    page.addEventListener('wheel', handleWheel, { passive: false });
    return () => page.removeEventListener('wheel', handleWheel);
  }, []);

  const handleKeyDown = (event) => {
    if (['ArrowDown', 'PageDown', ' '].includes(event.key)) {
      event.preventDefault();
      moveOneScreen(1);
    }
    if (['ArrowUp', 'PageUp'].includes(event.key)) {
      event.preventDefault();
      moveOneScreen(-1);
    }
  };

  const handleScroll = (event) => {
    const { scrollTop, clientHeight } = event.currentTarget;
    const progress = scrollTop / Math.max(clientHeight, 1);
    const nextScreen = progress >= 0.5 ? 'about' : 'welcome';
    const nextOpening = progress >= 0.08;

    setOpening(nextOpening);
    if (nextScreen !== screen) {
      setScreen(nextScreen);
      onScreenChange(nextScreen === 'about' ? 1 : 0);
    }

    if (progress >= 1.82 && !enteringRef.current) {
      enteringRef.current = true;
      onEnter();
    }
  };

  return (
    <main
      ref={entryRef}
      className={`entry-page ${opening ? 'opening' : ''} ${screen === 'about' ? 'about' : ''}`}
      onScroll={handleScroll}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      aria-label="Tokko introduction"
    >
      <div className="entry-stage">
        <img
          className="trakko-entry-art"
          src={screen === 'welcome'
            ? '/assets/trakko/storefront-entry.png'
            : '/assets/trakko/storefront-hero.png'}
          alt="Tokko health and wellness storefront"
        />
        <div className="trakko-entry-shade" aria-hidden="true" />
        {screen === 'welcome' ? (
          <section className="entry-copy welcome-copy" aria-labelledby="entry-title">
            <span className="entry-trakko-mark" aria-hidden="true">t</span>
            <p className="entry-kicker">Health, wellness, and family care</p>
            <h1 id="entry-title">Step into Tokko.</h1>
            <p className="entry-subheading">Shop together, even when you're worlds apart.</p>
            <div className="entry-scroll-cue" aria-hidden="true"><span>Get Started</span><ChevronDown size={19} /></div>
          </section>
        ) : (
          <section className="entry-copy about-copy" aria-labelledby="about-title">
            <span className="entry-trakko-mark" aria-hidden="true">t</span>
            <p className="eyebrow">Your family personal shopper</p>
            <h1 id="about-title">Shopping through a simple chat.</h1>
            <p className="about-body">TOKKO lives in your family chat. Parents simply send a message with what they need, and TOKKO takes care of finding and ordering it—keeping you in control every step of the way.</p>
            <div className="entry-merchant-strip" aria-label="Supported wellness merchants">
              <span>Kapiva</span>
              <span>OZiva</span>
              <img src="/assets/merchants/himalaya-wellness.png" alt="Himalaya Wellness" />
            </div>
            <div className="entry-scroll-cue" aria-hidden="true"><span>Continue</span><ChevronDown size={19} /></div>
          </section>
        )}
        <div className="entry-threshold" aria-hidden="true" />
      </div>
      <div className="entry-scroll-track" aria-hidden="true">
        <span className="entry-scroll-stop" />
        <span className="entry-scroll-stop" />
        <span className="entry-scroll-stop" />
      </div>
    </main>
  );
}

function StatusPill({ tone = 'neutral', children }) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}

function Login({ onAuthenticated, onBack }) {
  const touchStartRef = useRef(null);
  const backLockRef = useRef(false);
  const pendingChallengeRef = useRef(null);
  const [mode, setMode] = useState('login');
  const [loginMethod, setLoginMethod] = useState('email');
  const [email, setEmail] = useState('');
  const [loginCountryCode, setLoginCountryCode] = useState('+91');
  const [loginLocalPhone, setLoginLocalPhone] = useState('');
  const [password, setPassword] = useState('');
  const [signupChallenge, setSignupChallenge] = useState(null);
  const [emailOtp, setEmailOtp] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const verifyingSignup = mode === 'signup' && Boolean(signupChallenge);
  const returnToIntro = () => {
    if (backLockRef.current || window.scrollY > 0) return;
    backLockRef.current = true;
    onBack();
  };
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setStatus(
      verifyingSignup
        ? 'Verifying your email…'
        : mode === 'signup'
          ? 'Sending a verification code…'
          : 'Signing in…'
    );
    try {
      if (verifyingSignup) {
        const verified = await verifyClerkEmail(
          signupChallenge.clerkSignUpId,
          emailOtp
        );
        await api('/api/auth/signup/verify', {
          method: 'POST',
          body: {
            challengeId: signupChallenge.challengeId,
            email,
            clerkSignUpId: verified.signUpId,
          },
        });
      } else if (mode === 'signup') {
        const pending = pendingChallengeRef.current;
        const result =
          pending
          && pending.email === email.trim().toLowerCase()
          && pending.password === password
            ? pending.result
            : await api('/api/auth/signup', {
                method: 'POST',
                body: { email, password },
              });
        pendingChallengeRef.current = {
          email: email.trim().toLowerCase(),
          password,
          result,
        };
        const prepared = await startClerkEmailVerification(email, password);
        if (prepared.alreadyVerified) {
          await api('/api/auth/signup/verify', {
            method: 'POST',
            body: {
              challengeId: result.challengeId,
              email,
              clerkSignUpId: prepared.signUpId,
            },
          });
          pendingChallengeRef.current = null;
        } else {
          setSignupChallenge({
            ...result,
            clerkSignUpId: prepared.signUpId,
          });
          pendingChallengeRef.current = null;
          setEmailOtp('');
          setStatus(`A six-digit code was sent to ${result.email || email}.`);
          return;
        }
      } else {
        await api('/api/auth/login', {
          method: 'POST',
          body: loginMethod === 'phone'
            ? {
                phone: toE164(loginCountryCode, loginLocalPhone),
                password,
              }
            : { email, password },
        });
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
    <main
      className="auth-page"
      onWheel={(event) => { if (event.deltaY < -24) returnToIntro(); }}
      onTouchStart={(event) => { touchStartRef.current = event.touches[0]?.clientY ?? null; }}
      onTouchEnd={(event) => {
        const endY = event.changedTouches[0]?.clientY ?? null;
        if (touchStartRef.current !== null && endY !== null && endY - touchStartRef.current > 70) returnToIntro();
        touchStartRef.current = null;
      }}
    >
      <AisleBackdrop scene="trakko" depth={0.06} />
      <header className="auth-header">
        <Brand />
        <span className="secure-label"><LockKeyhole size={15} /> Secure sign in</span>
      </header>

      <section className="auth-shell" aria-labelledby="sign-in-title">
        <div className="auth-context">
          <div className="context-visual" aria-hidden="true">
            <div className="context-row">
              <span className="avatar avatar-child">A</span>
              <span className="chat-bubble">Can you order cereal and milk?</span>
            </div>
            <div className="context-row agent-row">
              <span className="avatar avatar-agent"><Sparkles size={16} /></span>
              <span className="chat-bubble agent-bubble">
                Found everything · $18.40
                <small>Within Aarav's grocery mandate</small>
              </span>
            </div>
            <div className="context-order">
              <ShoppingBag size={20} />
              <div><strong>Order placed · 16 min</strong><span>Zepto · 4 items</span></div>
              <CheckCircle2 size={19} />
            </div>
          </div>
          <p className="eyebrow">From the family chat to the front door</p>
          <h1>Welcome inside Tokko.</h1>
          <p>Ask in iMessage. Tokko finds the items, checks the family rules, and keeps the card owner in control.</p>
          <div className="trust-row">
            <span><ShieldCheck size={16} /> Owner controls</span>
            <span><Fingerprint size={16} /> Passkey protected</span>
          </div>
        </div>

        <div className="auth-form-wrap">
          <div className="auth-form">
            <p className="eyebrow">Welcome to Tokko</p>
            <h2 id="sign-in-title">
              {verifyingSignup
                ? 'Verify your email'
                : mode === 'signup'
                  ? 'Create your Tokko account'
                  : 'Sign in to Tokko'}
            </h2>
            <form className="email-auth-form" onSubmit={submit}>
              {verifyingSignup ? (
                <>
                  <p className="verification-copy">
                    Enter the code sent to <strong>{signupChallenge.email || email}</strong>.
                    It expires in 10 minutes.
                  </p>
                  <label className="field-group">
                    <span>Six-digit email code</span>
                    <input
                      className="otp-input"
                      name="emailOtp"
                      value={emailOtp}
                      onChange={(event) => setEmailOtp(event.target.value.replace(/\D/g, '').slice(0, 6))}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="000000"
                      pattern="\d{6}"
                      maxLength={6}
                      required
                      autoFocus
                    />
                  </label>
                </>
              ) : (
                <>
                  {mode === 'login' && (
                    <div className="auth-identifier-tabs" aria-label="Sign-in method">
                      <button
                        type="button"
                        className={loginMethod === 'email' ? 'active' : ''}
                        aria-pressed={loginMethod === 'email'}
                        onClick={() => {
                          setLoginMethod('email');
                          setStatus('');
                        }}
                      >
                        Email
                      </button>
                      <button
                        type="button"
                        className={loginMethod === 'phone' ? 'active' : ''}
                        aria-pressed={loginMethod === 'phone'}
                        onClick={() => {
                          setLoginMethod('phone');
                          setStatus('');
                        }}
                      >
                        Phone number
                      </button>
                    </div>
                  )}
                  {(mode === 'signup' || loginMethod === 'email') ? (
                    <label className="field-group">
                      <span>Email</span>
                      <input
                        name="email"
                        type="email"
                        autoComplete="email"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        placeholder="you@example.com"
                        required
                      />
                    </label>
                  ) : (
                    <div className="field-group">
                      <span>Phone number</span>
                      <div className="phone-input-row">
                        <select
                          aria-label="Login country code"
                          value={loginCountryCode}
                          onChange={(event) => setLoginCountryCode(event.target.value)}
                        >
                          <option value="+91">IN +91</option>
                          <option value="+1">US/CA +1</option>
                          <option value="+44">UK +44</option>
                          <option value="+61">AU +61</option>
                          <option value="+65">SG +65</option>
                          <option value="+971">AE +971</option>
                        </select>
                        <input
                          aria-label="Login phone number"
                          name="phone"
                          type="tel"
                          inputMode="tel"
                          autoComplete="tel-national"
                          value={loginLocalPhone}
                          onChange={(event) => setLoginLocalPhone(event.target.value)}
                          placeholder="98765 43210"
                          required
                        />
                      </div>
                      <small className="phone-field-hint">
                        Use the account holder or any linked dependent number.
                      </small>
                    </div>
                  )}
                  <label className="field-group">
                    <span>Password</span>
                    <input
                      name="password"
                      type="password"
                      autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      minLength={10}
                      required
                    />
                  </label>
                  {mode === 'signup' && (
                    <div
                      id="clerk-captcha"
                      className="clerk-captcha-slot"
                      data-cl-theme="light"
                      data-cl-size="flexible"
                      data-cl-language="en-US"
                    />
                  )}
                </>
              )}
              <button className="button primary-button full-button" disabled={busy}>
                <LockKeyhole size={16} />
                {busy
                  ? 'Please wait…'
                  : verifyingSignup
                    ? 'Verify email'
                    : mode === 'signup'
                      ? 'Send email code'
                      : 'Sign in'}
              </button>
            </form>
            {status && <p className="form-message error-message" role="alert">{status}</p>}
            {verifyingSignup && (
              <div className="verification-actions">
                <button
                  className="text-button"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setSignupChallenge(null);
                    pendingChallengeRef.current = null;
                    setEmailOtp('');
                    setStatus('');
                  }}
                >
                  Change email
                </button>
                <button
                  className="text-button"
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setStatus('Sending a new code…');
                    try {
                      const result = await api('/api/auth/signup', {
                        method: 'POST',
                        body: { email, password },
                      });
                      const prepared = await resendClerkEmailVerification(
                        signupChallenge.clerkSignUpId
                      );
                      setSignupChallenge({
                        ...result,
                        clerkSignUpId: prepared.signUpId,
                      });
                      setEmailOtp('');
                      setStatus(`A new code was sent to ${result.email || email}.`);
                    } catch (error) {
                      setStatus(error.message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Resend code
                </button>
              </div>
            )}
            <button
              className="text-button centered-button"
              type="button"
              onClick={() => {
                setMode(mode === 'login' ? 'signup' : 'login');
                setLoginMethod('email');
                setSignupChallenge(null);
                pendingChallengeRef.current = null;
                setEmailOtp('');
                setStatus('');
              }}
            >
              {mode === 'login' ? 'New to Tokko? Create an account' : 'Already have an account? Sign in'}
            </button>

            <p className="legal-copy">By continuing, you agree to the Terms and acknowledge the Privacy Policy.</p>
          </div>
        </div>
      </section>
    </main>
  );
}

function ProgressNav({ stepIndex, onStepSelect, setup }) {
  return (
    <aside className="onboarding-sidebar">
      <Brand />
      <div className="sidebar-heading">
        <span>Account setup</span>
        <strong>{Math.round(((stepIndex + 1) / STEPS.length) * 100)}%</strong>
      </div>
      <div className="progress-track"><span style={{ width: `${((stepIndex + 1) / STEPS.length) * 100}%` }} /></div>
      <nav aria-label="Onboarding steps">
        {STEPS.map((step, index) => {
          const Icon = step.icon;
          const complete = index < stepIndex || (
            (step.id === 'card' && setup.card.connected) ||
            (step.id === 'approvals' && setup.passkeyActive) ||
            (step.id === 'zepto' && setup.zeptoConnected) ||
            (step.id === 'mandate' && setup.mandate.active)
          );
          return (
            <button
              key={step.id}
              className={`step-link ${index === stepIndex ? 'active' : ''} ${complete ? 'complete' : ''}`}
              onClick={() => onStepSelect(index)}
              disabled={index > stepIndex + 1}
            >
              <span className="step-icon">{complete ? <Check size={16} /> : <Icon size={16} />}</span>
              <span>{step.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="sidebar-security">
        <ShieldCheck size={18} />
        <div><strong>Payments by Prava</strong><span>Card details stay private.</span></div>
      </div>
    </aside>
  );
}

function OnboardingTopbar({ stepIndex, onExit }) {
  return (
    <header className="onboarding-topbar">
      <div className="mobile-brand"><Brand /></div>
      <span className="mobile-step">Step {stepIndex + 1} of {STEPS.length}</span>
      <button className="icon-button" aria-label="Exit onboarding" data-tooltip="Exit" onClick={onExit}><X size={18} /></button>
    </header>
  );
}

function PageHeading({ eyebrow, title, description, status }) {
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {status}
    </div>
  );
}

function NavigationActions({ onBack, onNext, nextLabel = 'Continue', nextDisabled = false, showBack = true }) {
  return (
    <div className="navigation-actions">
      {showBack ? <button className="button secondary-button" onClick={onBack}><ArrowLeft size={17} /> Back</button> : <span />}
      <button className="button primary-button" onClick={onNext} disabled={nextDisabled}>{nextLabel} <ArrowRight size={17} /></button>
    </div>
  );
}

function ProfileStep({ setup, updateSetup, onNext }) {
  const profile = setup.profile;
  const update = (field, value) => {
    const nextProfile = { ...profile, [field]: value };
    nextProfile.phone = toE164(
      nextProfile.countryCode,
      nextProfile.localPhone
    );
    updateSetup({ ...setup, profile: nextProfile });
  };
  const ageValid = profile.age === '' || (
    Number.isInteger(Number(profile.age))
    && Number(profile.age) >= 0
    && Number(profile.age) <= 120
  );
  const genderValid = profile.gender !== 'Self-described'
    || Boolean(profile.genderDescription?.trim());
  return (
    <>
      <PageHeading eyebrow="Account owner" title="Tell us about you" description="These details identify the person who controls the card and family permissions." />
      <div className="form-grid two-columns">
        <label className="field-group"><span>Full name</span><input value={profile.name} onChange={(e) => update('name', e.target.value)} autoComplete="name" /></label>
        <div className="field-group">
          <span>Phone number</span>
          <div className="phone-input-row">
            <select aria-label="Country code" value={profile.countryCode} onChange={(e) => update('countryCode', e.target.value)}>
              <option value="+91">IN +91</option>
              <option value="+1">US/CA +1</option>
              <option value="+44">UK +44</option>
              <option value="+61">AU +61</option>
              <option value="+65">SG +65</option>
              <option value="+971">AE +971</option>
            </select>
            <input
              aria-label="Phone number without country code"
              value={profile.localPhone}
              onChange={(e) => update('localPhone', e.target.value)}
              inputMode="tel"
              autoComplete="tel-national"
              placeholder="98765 43210"
            />
          </div>
          <small className="phone-field-hint">
            The selected country code is added automatically.
          </small>
        </div>
        <label className="field-group"><span>Country</span><select value={profile.country} onChange={(e) => update('country', e.target.value)}><option>India</option><option>United States</option><option>United Kingdom</option><option>Singapore</option><option>United Arab Emirates</option></select></label>
        <label className="field-group"><span>Delivery postal code (optional)</span><input value={profile.postal} onChange={(e) => update('postal', e.target.value)} inputMode="numeric" /></label>
        <label className="field-group">
          <span>Age (optional)</span>
          <input
            value={profile.age ?? ''}
            onChange={(e) => update('age', e.target.value)}
            type="number"
            min="0"
            max="120"
            step="1"
            inputMode="numeric"
            placeholder="For example, 42"
          />
        </label>
        <label className="field-group">
          <span>Gender (optional)</span>
          <select value={profile.gender || ''} onChange={(e) => update('gender', e.target.value)}>
            <option value="">Prefer not to say</option>
            <option value="Woman">Woman</option>
            <option value="Man">Man</option>
            <option value="Non-binary">Non-binary</option>
            <option value="Self-described">Self-described</option>
          </select>
        </label>
        {profile.gender === 'Self-described' && (
          <label className="field-group">
            <span>Describe gender</span>
            <input
              value={profile.genderDescription || ''}
              onChange={(e) => update('genderDescription', e.target.value)}
              maxLength={40}
              placeholder="How should Trakko understand this?"
            />
          </label>
        )}
      </div>
      <div className="inline-note privacy-context-note"><ShieldCheck size={17} /><span>Why we ask: age and gender help Trakko avoid irrelevant questions and unsuitable wellness suggestions. Both are optional and are not sent to merchants as part of checkout.</span></div>
      <div className="inline-note"><Bell size={17} /><span>Payment approvals and important order updates will go to <strong>{profile.phone}</strong>.</span></div>
      <NavigationActions showBack={false} onNext={onNext} nextDisabled={!profile.name.trim() || profile.localPhone.replace(/\D/g, '').length < 8 || !ageValid || !genderValid} />
    </>
  );
}

function CardStep({
  setup,
  updateSetup,
  onBack,
  onNext,
  continueLabel = 'Continue',
}) {
  const [configured, setConfigured] = useState(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingSession, setPendingSession] = useState(null);
  const knownMethodKeysRef = useRef(new Set());
  const [savedMethods, setSavedMethods] = useState(
    Array.isArray(setup.cards) ? setup.cards : []
  );
  const [addingCard, setAddingCard] = useState(!setup.card.connected);

  const methodKey = (method) =>
    String(
      method.id
      || `${method.provider || 'prava'}:${method.last4}:${method.expMonth}:${method.expYear}`
    );

  const applySavedMethods = (methods, { closeForm = true } = {}) => {
    const validMethods = Array.isArray(methods)
      ? methods.filter((method) => method?.last4)
      : [];
    setSavedMethods(validMethods);
    const preferred =
      validMethods.find((method) => method.isDefault)
      || validMethods[0];
    if (preferred) {
      updateSetup((current) => ({
        ...current,
        cards: validMethods,
        card: {
          connected: true,
          id: preferred.id,
          last4: preferred.last4,
          brand: preferred.brand || 'Card',
          expMonth: preferred.expMonth,
          expYear: preferred.expYear,
        },
      }));
      if (closeForm) setAddingCard(false);
    }
    return validMethods;
  };

  const refreshSavedMethods = async (options) => {
    const result = await api('/api/payments/payment-methods');
    return applySavedMethods(result.paymentMethods || [], options);
  };

  useEffect(() => {
    let active = true;
    Promise.allSettled([
      api('/api/config'),
      api('/api/payments/payment-methods'),
    ])
      .then(([configResult, methodsResult]) => {
        if (!active) return;
        if (configResult.status === 'fulfilled') {
          const config = configResult.value;
          setConfigured(config.pravaConfigured ? config : false);
        } else {
          setConfigured(false);
          setStatus(configResult.reason.message);
        }
        if (methodsResult.status === 'fulfilled') {
          applySavedMethods(methodsResult.value.paymentMethods || []);
        } else if (!setup.card.connected) {
          setStatus(methodsResult.reason.message);
        }
      })
      .catch((error) => {
        setConfigured(false);
        setStatus(error.message);
      });
    return () => {
      active = false;
    };
  }, []);

  const connect = async () => {
    if (!configured) return;
    let hostedWindow = null;
    try {
      hostedWindow = window.open('', '_blank');
      if (hostedWindow) {
        hostedWindow.opener = null;
        hostedWindow.document.title = 'Opening Prava secure card setup…';
        hostedWindow.document.body.textContent = 'Opening Prava secure card setup…';
      }
    } catch {
      hostedWindow = null;
    }
    setBusy(true);
    setStatus('Creating a secure Prava card setup session…');
    knownMethodKeysRef.current = new Set(savedMethods.map(methodKey));
    try {
      const session = await api('/api/payments/tokenization-session', {
        method: 'POST',
      });
      if (!session.approvalUrl) {
        throw new Error('Prava did not return its hosted card setup URL.');
      }
      setPendingSession(session);
      if (hostedWindow) {
        hostedWindow.location.replace(session.approvalUrl);
        setStatus(
          'Prava secure card setup opened in a new tab. Complete OTP and passkey verification, then return here.'
        );
      } else {
        setStatus(
          'Your browser blocked the secure Prava tab. Use Open Prava card setup below.'
        );
      }
    } catch (error) {
      hostedWindow?.close();
      setStatus(error.message);
    } finally {
      setBusy(false);
    }
  };

  const reconcileHostedCard = async ({ quiet = false } = {}) => {
    if (!quiet) setBusy(true);
    try {
      const methods = await refreshSavedMethods({ closeForm: false });
      const knownMethods = knownMethodKeysRef.current;
      const newlySaved = methods.find(
        (method) => !knownMethods.has(methodKey(method))
      );
      if (newlySaved || (knownMethods.size === 0 && methods.length > 0)) {
        const method = newlySaved || methods[0];
        applySavedMethods(methods);
        setPendingSession(null);
        setAddingCard(false);
        setStatus(
          `Card ending ${method.last4} saved. You can continue to checkout.`
        );
        return true;
      }
      if (!quiet) {
        setStatus(
          'No new Prava card is visible yet. Finish the hosted card setup, then refresh again.'
        );
      }
      return false;
    } catch (error) {
      if (!quiet) setStatus(`Could not refresh saved cards: ${error.message}`);
      return false;
    } finally {
      if (!quiet) setBusy(false);
    }
  };

  useEffect(() => {
    if (!pendingSession?.sessionId) return undefined;
    let active = true;
    let timer;
    let inFlight = false;
    const poll = async () => {
      if (!active || inFlight) return;
      if (timer) window.clearTimeout(timer);
      inFlight = true;
      const completed = await reconcileHostedCard({ quiet: true });
      inFlight = false;
      if (!completed && active) timer = window.setTimeout(poll, 4_000);
    };
    const onFocus = () => poll();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') poll();
    };
    timer = window.setTimeout(poll, 4_000);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [pendingSession?.sessionId]);

  const displayedMethods = savedMethods.length
    ? savedMethods
    : setup.cards?.length
      ? setup.cards
    : setup.card.connected
      ? [setup.card]
      : [];
  const hasSavedCard = displayedMethods.length > 0;

  return (
    <>
      <PageHeading
        eyebrow="Payment source"
        title={hasSavedCard ? 'Saved family cards' : 'Add the family card'}
        description="Cards are tokenized by Prava. Tokko stores only their masked references."
        status={hasSavedCard ? <StatusPill tone="success"><CheckCircle2 size={14} /> {displayedMethods.length} saved</StatusPill> : null}
      />
      {hasSavedCard && (
        <div className="saved-payment-method-list">
          {displayedMethods.map((method) => (
            <div className="saved-payment-method" key={methodKey(method)}>
              <span className="saved-payment-icon"><CreditCard size={19} /></span>
              <span><strong>{String(method.brand || 'Card').toUpperCase()} •••• {method.last4}</strong><small>Expires {method.expMonth}/{method.expYear}</small></span>
              {method.isDefault && <StatusPill tone="success">Default</StatusPill>}
              {!method.isDefault && <CheckCircle2 size={17} />}
            </div>
          ))}
          {!addingCard && <button type="button" className="button secondary-button" onClick={() => { setAddingCard(true); setPendingSession(null); setStatus(''); }}><Plus size={16} /> Add another card</button>}
        </div>
      )}
      {(!hasSavedCard || addingCard) && (
        <div className="secure-card-form">
          <div className="secure-card-header">
            <div><ExternalLink size={17} /><strong>Hosted card setup</strong></div>
            <span>Powered by Prava</span>
          </div>
          <p className="secure-form-intro">Tokko creates the session, then Prava collects the card on its own hosted page in a new tab. No card form is embedded in Tokko.</p>
          <button className="button primary-button full-button" onClick={connect} disabled={busy || !configured}><LockKeyhole size={16} /> {busy ? 'Creating secure session…' : pendingSession ? 'Create a new card session' : 'Create secure card session'}</button>
          {pendingSession?.approvalUrl && (
            <div className="mandate-approval-callout">
              <div><strong>Complete card setup with Prava</strong><span>Enter the card, verify the sandbox OTP or issuer OTP, and approve the passkey. Tokko refreshes cards when you return.</span></div>
              <a className="button primary-button" href={pendingSession.approvalUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} /> Open Prava card setup</a>
            </div>
          )}
          {pendingSession && <button type="button" className="button secondary-button full-button" disabled={busy} onClick={() => reconcileHostedCard()}><RefreshCw size={16} /> {busy ? 'Refreshing cards…' : 'I’ve finished, refresh saved cards'}</button>}
          {configured === false && <div className="support-callout warning-callout"><CircleAlert size={18} /><div><strong>Prava is unavailable</strong><span>The backend does not currently have a matching Prava public/secret key pair.</span></div></div>}
          {status && <p className={`form-message ${/could not|failed|unavailable|add https/i.test(status) ? 'error-message' : ''}`} role="status">{status}</p>}
          <div className="security-caption"><ShieldCheck size={16} /><span>Prava tokenizes the card on its hosted domain. Tokko receives only masked card metadata.</span></div>
        </div>
      )}
      <NavigationActions
        onBack={onBack}
        onNext={onNext}
        nextLabel={hasSavedCard ? continueLabel : 'Continue without a card'}
      />
    </>
  );
}

function ApprovalsStep({ setup, updateSetup, onBack, onNext }) {
  return (
    <>
      <PageHeading eyebrow="Owner security" title="Activate payment approvals" description="Your device biometrics confirm that approval comes from you, not the AI." status={setup.passkeyActive ? <StatusPill tone="success"><CheckCircle2 size={14} /> Active</StatusPill> : null} />
      <div className="approval-visual">
        <div className={`fingerprint-orbit ${setup.passkeyActive ? 'active' : ''}`}><Fingerprint size={42} /></div>
        <div><strong>{setup.passkeyActive ? 'Passkey activated' : 'Use this device for approvals'}</strong><span>{setup.passkeyActive ? 'One-time payments and mandates can now be authorized.' : 'Face ID, Touch ID, fingerprint, or Windows Hello will be used.'}</span></div>
        {!setup.passkeyActive && <button className="button primary-button" onClick={() => updateSetup({ ...setup, passkeyActive: true })}><Fingerprint size={17} /> Activate passkey</button>}
      </div>
      <div className="approval-list">
        <div><BadgeCheck size={18} /><div><strong>One-time approval</strong><span>Review the merchant, items, and total before the card is used.</span></div><StatusPill tone={setup.passkeyActive ? 'success' : 'neutral'}>{setup.passkeyActive ? 'Ready' : 'Waiting'}</StatusPill></div>
        <div><ShieldCheck size={18} /><div><strong>Family mandates</strong><span>Pre-approve limits for selected people and recurring needs.</span></div><StatusPill>Set up later</StatusPill></div>
      </div>
      <NavigationActions
        onBack={onBack}
        onNext={onNext}
        nextLabel={setup.passkeyActive ? 'Continue' : 'Set up later'}
      />
    </>
  );
}

function ZeptoStep({ setup, onConnect, onBack, onNext }) {
  return (
    <>
      <PageHeading
        eyebrow="Merchant connection"
        title="Connect your Zepto account"
        description="Choose the family phone to use, then verify the Zepto account in a secure popup."
        status={<StatusPill tone={setup.zeptoConnected ? 'success' : 'warning'}>{setup.zeptoConnected ? <><CheckCircle2 size={14} /> Connected</> : <><CircleAlert size={14} /> Not connected</>}</StatusPill>}
      />
      <div className="merchant-connect-row">
        <div className="zepto-mark">Z</div>
        <div><strong>Zepto</strong><span>{setup.zeptoConnected ? `Connected with ${setup.zeptoPhone}` : 'Groceries, household needs, and medicines'}</span></div>
        {setup.zeptoConnected ? <button className="button secondary-button" onClick={onConnect}><RefreshCw size={16} /> Reconnect</button> : <button className="button primary-button" onClick={onConnect}>Connect <ExternalLink size={16} /></button>}
      </div>
      <div className="handoff-strip">
        <div><span>1</span><strong>Open Zepto</strong></div><ArrowRight size={16} />
        <div><span>2</span><strong>Verify with OTP</strong></div><ArrowRight size={16} />
        <div><span>3</span><strong>Return connected</strong></div>
      </div>
      <div className="inline-note"><LockKeyhole size={17} /><span>Your Zepto OTP is sent only through the secure connection flow and is never stored in this browser.</span></div>
      <NavigationActions onBack={onBack} onNext={onNext} nextLabel={setup.zeptoConnected ? 'Continue' : 'Continue in limited mode'} />
    </>
  );
}

function ZeptoConnect({ setup, updateSetup, onConnected, onCancel }) {
  const choices = [
    {
      id: 'account_holder',
      name: setup.profile.name || 'Account holder',
      relationship: 'You',
      phone: setup.profile.phone,
    },
    ...setup.members.map((member) => ({
      id: member.phone,
      name: member.name,
      relationship: member.role === 'Other dependent'
        ? member.otherRelationship || 'Dependent'
        : member.role,
      phone: member.phone,
    })),
  ];
  const existingChoice = choices.some((choice) => choice.id === setup.merchantAuthPhone)
    ? setup.merchantAuthPhone
    : 'account_holder';
  const [phase, setPhase] = useState('choose');
  const [selectedChoice, setSelectedChoice] = useState(existingChoice);
  const [otp, setOtp] = useState('');
  const [pendingId, setPendingId] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const phone = choices.find((choice) => choice.id === selectedChoice)?.phone || '';
  const indianPhoneSupported = /^\+91\d{10}$/.test(phone);

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === 'Escape' && phase !== 'success') onCancel();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onCancel, phase]);

  const requestOtp = async () => {
    const result = await api('/api/merchant/zepto/connect/start', {
      method: 'POST',
    });
    setPendingId(result.pendingId);
    setPhase('otp');
    setStatus(`OTP sent to ${result.phone}.`);
    return result;
  };

  const startConnection = async (event) => {
    event?.preventDefault();
    if (!indianPhoneSupported) {
      setStatus('Zepto currently supports Indian +91 mobile numbers only. Choose an Indian family number.');
      return;
    }
    setBusy(true);
    setStatus('Saving your choice and requesting a Zepto OTP…');
    try {
      const nextSetup = { ...setup, merchantAuthPhone: selectedChoice };
      const state = await api('/api/onboarding/profile', {
        method: 'PUT',
        body: onboardingPayload(nextSetup),
      });
      const consented = await api('/api/onboarding/merchant-consent', {
        method: 'PUT',
        body: { consented: true },
      });
      updateSetup(setupFromUserState(consented || state, nextSetup));
      await requestOtp();
    } catch (error) {
      setStatus(error.message);
    } finally {
      setBusy(false);
    }
  };

  const resendOtp = async () => {
    setBusy(true);
    setStatus('Requesting a new Zepto OTP…');
    try {
      await requestOtp();
    } catch (error) {
      setStatus(error.message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (event) => {
    event.preventDefault();
    setBusy(true);
    setStatus('Verifying securely with Zepto…');
    try {
      const result = await api('/api/merchant/zepto/connect/verify', {
        method: 'POST',
        body: { pendingId, otp },
      });
      setPhase('success');
      setStatus('');
      window.setTimeout(() => onConnected(result.phone), 650);
    } catch (error) {
      setStatus(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="merchant-modal-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="merchant-modal" role="dialog" aria-modal="true" aria-labelledby="zepto-connect-title">
        <header className="merchant-modal-header">
          <div className="merchant-header-brand"><div className="zepto-mark small">Z</div><strong>Connect Zepto</strong></div>
          <span className="merchant-security"><LockKeyhole size={14} /> Secure merchant session</span>
          <button className="icon-button subtle" aria-label="Close Zepto connection" onClick={onCancel}><X size={19} /></button>
        </header>
        <div className="merchant-login-panel merchant-modal-panel">
          <p className="eyebrow">Zepto account</p>
          <h1 id="zepto-connect-title">{phase === 'choose' ? 'Which number should Zepto use?' : phase === 'otp' ? 'Enter your verification code' : 'Zepto is connected'}</h1>
          <p>{phase === 'choose' ? 'Choose the account holder or a dependent. Tokko stores this choice and asks Zepto to send the OTP only after you continue.' : phase === 'otp' ? `We sent a code to ${phone}.` : 'Your merchant token is encrypted in the backend and will be reused without another OTP until it expires or you reconnect.'}</p>
          {phase === 'choose' && (
            <form onSubmit={startConnection}>
              <div className="merchant-phone-options" role="radiogroup" aria-label="Phone number for Zepto">
                {choices.map((choice) => {
                  const supported = /^\+91\d{10}$/.test(choice.phone);
                  return (
                    <label className={`merchant-phone-option ${selectedChoice === choice.id ? 'selected' : ''}`} key={`${choice.id}-${choice.phone}`}>
                      <input type="radio" name="zepto-phone" value={choice.id} checked={selectedChoice === choice.id} onChange={() => { setSelectedChoice(choice.id); setStatus(''); }} />
                      <span><strong>{choice.name}</strong><small>{choice.relationship} · {choice.phone}</small></span>
                      {supported ? <StatusPill tone="success">Supported</StatusPill> : <StatusPill tone="warning">Not supported</StatusPill>}
                    </label>
                  );
                })}
              </div>
              {!indianPhoneSupported && <div className="support-callout warning-callout"><CircleAlert size={17} /><div><strong>Merchant phone not supported</strong><span>Zepto currently accepts Indian +91 mobile numbers. Choose an Indian number to connect.</span></div></div>}
              <label className="merchant-consent-check"><input type="checkbox" checked readOnly /><span>I consent to Tokko using {phone || 'this number'} only to authenticate with Zepto.</span></label>
              <button className="button zepto-button full-button" type="submit" disabled={busy || !indianPhoneSupported}>{busy ? 'Sending OTP…' : 'Send OTP'} <ArrowRight size={17} /></button>
            </form>
          )}
          {phase === 'otp' && (
            <form onSubmit={verify}>
              <label className="field-group"><span>6-digit code</span><input className="otp-input" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="000000" maxLength={6} autoFocus /></label>
              <button className="button zepto-button full-button" type="submit" disabled={busy || otp.length !== 6}>{busy ? 'Verifying…' : 'Verify Zepto account'} <ArrowRight size={17} /></button>
              <button type="button" className="text-button centered-button" disabled={busy} onClick={resendOtp}>Resend OTP</button>
            </form>
          )}
          {phase === 'success' && (
            <div className="merchant-success">
              <div><CheckCircle2 size={28} /></div>
              <dl><div><dt>Account</dt><dd>{phone}</dd></div><div><dt>Merchant session</dt><dd>Ready</dd></div></dl>
              <button className="button zepto-button full-button" onClick={() => onConnected(phone)}>Continue in Tokko <ArrowRight size={17} /></button>
            </div>
          )}
          {status && <p className={`form-message ${/failed|invalid|expired|required|could not|not supported/i.test(status) ? 'error-message' : ''}`} role="status">{status}</p>}
          <div className="merchant-footnote"><LockKeyhole size={15} /><span>Credentials are handled in this merchant session.</span></div>
        </div>
      </section>
    </div>
  );
}

function FamilyStep({ setup, updateSetup, onBack, onNext }) {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const addMember = () => updateSetup({
    ...setup,
    members: [
      ...setup.members,
      {
        id: `new-${Date.now()}`,
        name: '',
        age: '',
        gender: '',
        genderDescription: '',
        role: 'Child',
        otherRelationship: '',
        phone: '+91',
        countryCode: '+91',
        localPhone: '',
        channel: 'Phone',
        selected: false,
      },
    ],
  });
  const removeMember = (id) => {
    const removed = setup.members.find((member) => member.id === id);
    updateSetup({
      ...setup,
      members: setup.members.filter((member) => member.id !== id),
      merchantAuthPhone:
        setup.merchantAuthPhone === removed?.phone
          ? 'account_holder'
          : setup.merchantAuthPhone,
    });
  };
  const updateMember = (id, patch) => {
    let selectedPhone = setup.merchantAuthPhone;
    const members = setup.members.map((member) => {
      if (member.id !== id) return member;
      const saved = phoneParts(member.phone);
      const parts = {
        countryCode: member.countryCode ?? saved.countryCode,
        localPhone: member.localPhone ?? saved.localPhone,
        ...patch,
      };
      const phone = toE164(parts.countryCode, parts.localPhone);
      if (selectedPhone === member.phone) selectedPhone = phone;
      return {
        ...member,
        ...patch,
        countryCode: parts.countryCode,
        localPhone: parts.localPhone,
        phone,
      };
    });
    updateSetup({
      ...setup,
      members,
      merchantAuthPhone: selectedPhone,
    });
  };
  const save = async () => {
    setBusy(true);
    setStatus('Saving family details…');
    try {
      const availablePhones = new Set(setup.members.map((member) => member.phone));
      const nextSetup = {
        ...setup,
        merchantAuthPhone:
          setup.merchantAuthPhone === 'account_holder'
          || availablePhones.has(setup.merchantAuthPhone)
            ? setup.merchantAuthPhone
            : 'account_holder',
      };
      const state = await api('/api/onboarding/profile', {
        method: 'PUT',
        body: onboardingPayload(nextSetup),
      });
      updateSetup(setupFromUserState(state, nextSetup));
      setStatus('Family details saved.');
      onNext();
    } catch (error) {
      setStatus(error.message);
    } finally {
      setBusy(false);
    }
  };
  const membersValid = setup.members.every((member) => {
      const saved = phoneParts(member.phone);
      const countryCode = member.countryCode || saved.countryCode;
      const localPhone = normalizeLocalPhone(
        countryCode,
        member.localPhone ?? saved.localPhone
      );
      return member.name.trim()
        && member.role.trim()
        && (member.role !== 'Other dependent'
          || member.otherRelationship?.trim())
        && localPhone.length >= 8
        && (member.age === '' || member.age === null || member.age === undefined || (
          Number.isInteger(Number(member.age))
          && Number(member.age) >= 0
          && Number(member.age) <= 120
        ))
        && (member.gender !== 'Self-described'
          || Boolean(member.genderDescription?.trim()));
    });
  return (
    <>
      <PageHeading eyebrow="Family access" title="Who can ask the assistant?" description="Dependents are optional. You can continue with only your account and add family members later." />
      <div className="inline-note privacy-context-note"><ShieldCheck size={17} /><span>Optional age and gender help Trakko tailor wellness questions safely, for example by avoiding child, elder, or pregnancy questions when they are irrelevant. These details are not sent to merchants during checkout.</span></div>
      <label className="field-group family-name-field"><span>Family space name</span><div className="input-with-icon"><House size={17} /><input value={setup.familyName} onChange={(e) => updateSetup({ ...setup, familyName: e.target.value })} /></div></label>
      <div className="members-header"><span>Family members</span><button className="button secondary-button" onClick={addMember}><Plus size={16} /> Add dependent</button></div>
      <div className="member-list">
        <div className="member-row owner-row">
          <span className="avatar avatar-owner">{setup.profile.name.slice(0, 2).toUpperCase() || 'ME'}</span>
          <div><strong>{setup.profile.name}</strong><span>Account holder · {setup.profile.phone}</span></div>
          <StatusPill tone="success">Owner</StatusPill>
        </div>
        {setup.members.map((member) => (
          <div className="dependent-form-card" key={member.id}>
            <div className="dependent-form-heading">
              <span className="avatar">{member.name.slice(0, 2).toUpperCase() || 'D'}</span>
              <strong>{member.name || 'New dependent'}</strong>
              <button className="icon-button subtle" aria-label={`Remove ${member.name || 'dependent'}`} data-tooltip="Remove member" onClick={() => removeMember(member.id)}><Trash2 size={16} /></button>
            </div>
            <div className="form-grid two-columns compact-grid">
              <label className="field-group"><span>Name</span><input value={member.name} onChange={(e) => updateMember(member.id, { name: e.target.value })} /></label>
              <label className="field-group"><span>Relationship</span><select value={member.role} onChange={(e) => updateMember(member.id, { role: e.target.value, ...(e.target.value !== 'Other dependent' ? { otherRelationship: '' } : {}) })}>{DEPENDENT_RELATIONSHIPS.map((relationship) => <option key={relationship}>{relationship}</option>)}<option>Other dependent</option></select></label>
              <label className="field-group">
                <span>Age (optional)</span>
                <input
                  aria-label={`${member.name || 'Dependent'} age`}
                  value={member.age ?? ''}
                  onChange={(e) => updateMember(member.id, { age: e.target.value })}
                  type="number"
                  min="0"
                  max="120"
                  step="1"
                  inputMode="numeric"
                  placeholder="Age"
                />
              </label>
              <label className="field-group">
                <span>Gender (optional)</span>
                <select aria-label={`${member.name || 'Dependent'} gender`} value={member.gender || ''} onChange={(e) => updateMember(member.id, { gender: e.target.value })}>
                  <option value="">Prefer not to say</option>
                  <option value="Woman">Woman</option>
                  <option value="Man">Man</option>
                  <option value="Non-binary">Non-binary</option>
                  <option value="Self-described">Self-described</option>
                </select>
              </label>
              {member.gender === 'Self-described' && (
                <label className="field-group">
                  <span>Describe gender</span>
                  <input
                    aria-label={`${member.name || 'Dependent'} gender description`}
                    value={member.genderDescription || ''}
                    onChange={(e) => updateMember(member.id, { genderDescription: e.target.value })}
                    maxLength={40}
                    placeholder="How should Trakko understand this?"
                  />
                </label>
              )}
              {member.role === 'Other dependent' && (
                <label className="field-group other-relationship-field">
                  <span>Specify relationship</span>
                  <input
                    aria-label={`${member.name || 'Dependent'} relationship`}
                    value={member.otherRelationship || ''}
                    onChange={(e) => updateMember(member.id, { otherRelationship: e.target.value })}
                    placeholder="For example, cousin or guardian"
                    required
                  />
                </label>
              )}
              <div className="field-group">
                <span>Phone number</span>
                <div className="phone-input-row">
                  <select aria-label={`${member.name || 'Dependent'} country code`} value={member.countryCode || phoneParts(member.phone).countryCode} onChange={(e) => updateMember(member.id, { countryCode: e.target.value })}><option value="+91">IN +91</option><option value="+1">US/CA +1</option><option value="+44">UK +44</option><option value="+61">AU +61</option><option value="+65">SG +65</option><option value="+971">AE +971</option></select>
                  <input aria-label={`${member.name || 'Dependent'} phone`} value={member.localPhone ?? phoneParts(member.phone).localPhone} onChange={(e) => updateMember(member.id, { localPhone: e.target.value })} inputMode="tel" placeholder="Number without country code" />
                </div>
                <small className="phone-field-hint">Country code is added automatically.</small>
              </div>
            </div>
          </div>
        ))}
      </div>
      {setup.members.length === 0 && <button className="empty-add-dependent" onClick={addMember}><Plus size={18} /> Add a dependent (optional)</button>}
      <div className="inline-note"><MessageCircle size={17} /><span>You will choose which family number, if any, to use with Zepto on the next step.</span></div>
      {status && <p className={`form-message ${/saved/i.test(status) ? '' : 'error-message'}`} role="status">{status}</p>}
      <div className="navigation-actions">
        <button className="button secondary-button" onClick={onBack}><ArrowLeft size={17} /> Back</button>
        <button className="button primary-button" onClick={save} disabled={busy || !setup.familyName.trim() || !membersValid}>{busy ? 'Saving…' : 'Save family and continue'} <ArrowRight size={17} /></button>
      </div>
    </>
  );
}

function MandateStep({ setup, updateSetup, onBack, onNext }) {
  const mandate = setup.mandate;
  const updateMandate = (patch) => updateSetup({ ...setup, mandate: { ...mandate, ...patch } });
  const toggleMember = (id) => updateSetup({ ...setup, members: setup.members.map((member) => member.id === id ? { ...member, selected: !member.selected } : member) });
  return (
    <>
      <PageHeading eyebrow="Automatic payments" title="Set a family mandate" description="Selected family members can place matching orders without waiting for a fresh approval." status={mandate.active ? <StatusPill tone="success"><CheckCircle2 size={14} /> Active</StatusPill> : <StatusPill>Optional</StatusPill>} />
      <div className="mandate-layout">
        <div className="mandate-section">
          <h3>Who can use it</h3>
          <div className="check-list">
            {setup.members.map((member) => (
              <label key={member.id} className="check-row"><input type="checkbox" checked={member.selected} onChange={() => toggleMember(member.id)} /><span className="avatar small-avatar">{member.name.slice(0, 2).toUpperCase()}</span><span><strong>{member.name}</strong><small>{member.role}</small></span></label>
            ))}
          </div>
        </div>
        <div className="mandate-section">
          <h3>Spending limit</h3>
          <div className="form-grid two-columns compact-grid">
            <label className="field-group"><span>{mandate.period} limit</span><div className="currency-input"><span>₹</span><input type="number" value={mandate.total} onChange={(e) => updateMandate({ total: Number(e.target.value) })} /></div></label>
            <label className="field-group"><span>Per-order limit</span><div className="currency-input"><span>₹</span><input type="number" value={mandate.perOrder} onChange={(e) => updateMandate({ perOrder: Number(e.target.value) })} /></div></label>
          </div>
          <label className="field-group"><span>Renews</span><select value={mandate.period} onChange={(e) => updateMandate({ period: e.target.value })}><option>Weekly</option><option>Monthly</option></select></label>
        </div>
      </div>
      <div className="rule-list">
        <label className="toggle-row"><div><ShoppingBag size={18} /><span><strong>Groceries</strong><small>Food, household, and personal care</small></span></div><input type="checkbox" role="switch" checked={mandate.groceries} onChange={(e) => updateMandate({ groceries: e.target.checked })} /></label>
        <label className="toggle-row"><div><ReceiptText size={18} /><span><strong>Medicines</strong><small>Subject to medicine and merchant checks</small></span></div><input type="checkbox" role="switch" checked={mandate.medicines} onChange={(e) => updateMandate({ medicines: e.target.checked })} /></label>
        <label className="toggle-row"><div><Banknote size={18} /><span><strong>Cash-on-delivery fallback</strong><small>Tell the requester before the payment method changes</small></span></div><input type="checkbox" role="switch" checked={mandate.codFallback} onChange={(e) => updateMandate({ codFallback: e.target.checked })} /></label>
      </div>
      {!mandate.active ? (
        <div className="activate-bar"><Fingerprint size={20} /><div><strong>Activate with your passkey</strong><span>The mandate can be paused or revoked at any time.</span></div><button className="button primary-button" onClick={() => updateMandate({ active: true })}>Activate mandate</button></div>
      ) : (
        <div className="success-bar"><CheckCircle2 size={19} /><span>Mandate active for {setup.members.filter((member) => member.selected).map((member) => member.name).join(', ') || 'selected family members'}.</span></div>
      )}
      <NavigationActions onBack={onBack} onNext={onNext} />
    </>
  );
}

function ReviewStep({ setup, onBack, onFinish }) {
  const selectedMembers = setup.members.filter((member) => member.selected);
  const checks = [
    { icon: UserRound, label: 'Account owner', value: setup.profile.name, ready: true },
    { icon: CreditCard, label: 'Family card', value: setup.card.connected ? `Visa ending ${setup.card.last4}` : 'Not connected', ready: setup.card.connected },
    { icon: Fingerprint, label: 'Payment approvals', value: setup.passkeyActive ? 'Passkey active' : 'Not active', ready: setup.passkeyActive },
    { icon: Store, label: 'Zepto account', value: setup.zeptoConnected ? 'Connected' : 'Limited mode', ready: setup.zeptoConnected, warning: !setup.zeptoConnected },
    { icon: Users, label: 'Family members', value: `${setup.members.length + 1} people`, ready: true },
    { icon: ShieldCheck, label: 'Family mandate', value: setup.mandate.active ? `₹${setup.mandate.total} ${setup.mandate.period.toLowerCase()} · ${selectedMembers.length} member${selectedMembers.length === 1 ? '' : 's'}` : 'Fresh approval required', ready: true },
  ];
  return (
    <>
      <PageHeading eyebrow="Ready to go" title={`Welcome to ${setup.familyName}`} description="Review the setup before opening the card-owner dashboard." />
      <div className="review-list">
        {checks.map(({ icon: Icon, label, value, ready, warning }) => (
          <div className="review-row" key={label}>
            <span className="review-icon"><Icon size={18} /></span>
            <div><strong>{label}</strong><span>{value}</span></div>
            {warning ? <StatusPill tone="warning">Action needed</StatusPill> : ready ? <CheckCircle2 className="ready-check" size={19} /> : <CircleAlert size={19} />}
          </div>
        ))}
      </div>
      {!setup.zeptoConnected && <div className="support-callout warning-callout"><CircleAlert size={18} /><div><strong>Zepto ordering is unavailable</strong><span>You can finish onboarding and connect Zepto from the dashboard later.</span></div></div>}
      <div className="navigation-actions"><button className="button secondary-button" onClick={onBack}><ArrowLeft size={17} /> Back</button><button className="button primary-button" onClick={onFinish}>Open dashboard <LayoutDashboard size={17} /></button></div>
    </>
  );
}

function Onboarding({ setup, setSetup, stepIndex, setStepIndex, onExit, onZeptoConnect, onFinish }) {
  const [scrollDepth, setScrollDepth] = useState(0);
  const mainRef = useRef(null);
  const goNext = () => setStepIndex((current) => Math.min(current + 1, STEPS.length - 1));
  const goBack = () => setStepIndex((current) => Math.max(current - 1, 0));
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (!mainRef.current) return;
      const savedScroll = Number(localStorage.getItem(`tokko-onboarding-scroll-${STEPS[stepIndex].id}`)) || 0;
      mainRef.current.scrollTop = savedScroll;
    });
    setScrollDepth(0);
    return () => window.cancelAnimationFrame(frame);
  }, [stepIndex]);
  const handleStudioScroll = (event) => {
    const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
    const available = Math.max(scrollHeight - clientHeight, 1);
    setScrollDepth(Math.min(scrollTop / available, 1));
    localStorage.setItem(`tokko-onboarding-scroll-${STEPS[stepIndex].id}`, String(scrollTop));
  };
  let content;
  switch (STEPS[stepIndex].id) {
    case 'profile': content = <ProfileStep setup={setup} updateSetup={setSetup} onNext={goNext} />; break;
    case 'card': content = <CardStep setup={setup} updateSetup={setSetup} onBack={goBack} onNext={goNext} />; break;
    case 'approvals': content = <ApprovalsStep setup={setup} updateSetup={setSetup} onBack={goBack} onNext={goNext} />; break;
    case 'zepto': content = <ZeptoStep setup={setup} onConnect={onZeptoConnect} onBack={goBack} onNext={goNext} />; break;
    case 'family': content = <FamilyStep setup={setup} updateSetup={setSetup} onBack={goBack} onNext={goNext} />; break;
    case 'mandate': content = <MandateStep setup={setup} updateSetup={setSetup} onBack={goBack} onNext={goNext} />; break;
    default: content = <ReviewStep setup={setup} onBack={goBack} onFinish={onFinish} />;
  }
  const aisleDepth = (stepIndex / (STEPS.length - 1)) * 0.18 + scrollDepth * 0.035;
  return (
    <main className="onboarding-page">
      <AisleBackdrop depth={aisleDepth} />
      <ProgressNav stepIndex={stepIndex} onStepSelect={setStepIndex} setup={setup} />
      <section className="onboarding-main" ref={mainRef} onScroll={handleStudioScroll}>
        <OnboardingTopbar stepIndex={stepIndex} onExit={onExit} />
        <div className="mobile-progress"><span style={{ width: `${((stepIndex + 1) / STEPS.length) * 100}%` }} /></div>
        <div className="step-content" key={STEPS[stepIndex].id}>{content}</div>
      </section>
    </main>
  );
}

const TERMINAL_ORDER_STATUSES = new Set([
  'CANCELLED',
  'CANCELED',
  'DELIVERED',
  'FAILED',
  'REFUNDED',
]);

function findOrderArray(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (
      value.some((entry) =>
        entry
        && typeof entry === 'object'
        && (entry.id || entry.orderId || entry.order_id || entry.code)
      )
    ) {
      return value;
    }
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

function orderProducts(order) {
  if (Array.isArray(order?.productsNamesAndCounts)) {
    return order.productsNamesAndCounts.map((product) => ({
      name: product.name,
      count: Number(product.count || 1),
      packSize: product.packSize || product.packsize || '',
    }));
  }
  return (Array.isArray(order?.shipments) ? order.shipments : [])
    .flatMap((shipment) =>
      (Array.isArray(shipment?.products) ? shipment.products : []).map((product) => ({
        name: product.productName || product.name || 'Item',
        count: Number(product.quantityOrdered || product.quantity || 1),
        packSize: product.packsize || product.packSize || '',
      }))
    );
}

function normalizeOrderRecord(order) {
  const products = orderProducts(order);
  const status = String(
    order?.formattedStatus
    || order?.status
    || order?.shipments?.[0]?.formattedStatus
    || 'UNKNOWN'
  ).toUpperCase();
  const amountPaise = Number(
    order?.grandTotalAmount
    ?? order?.billSummary?.totalBill
    ?? order?.totalAmount
  );
  const placedTime = order?.placedTime || order?.createdAt || order?.created_at || null;
  const shipment = order?.shipments?.[0] || {};
  const etaMinutes = Number(
    order?.etaMinutes
    ?? order?.totalArrivalTimeInMinutes
    ?? order?.committedEtaInMins
    ?? shipment?.totalArrivalTimeInMinutes
    ?? shipment?.committedEtaInMins
    ?? shipment?.etaInMins
  );
  return {
    ...order,
    id: order?.id || order?.orderId || order?.order_id || null,
    code: order?.code || order?.orderCode || order?.order_code || null,
    status,
    products,
    itemCount:
      Number(order?.itemQuantityCount)
      || products.reduce((total, product) => total + product.count, 0),
    amountPaise: Number.isFinite(amountPaise) ? amountPaise : null,
    placedTime,
    etaMinutes:
      Number.isFinite(etaMinutes) && etaMinutes >= 0 ? etaMinutes : null,
  };
}

function parseOrderResponse(value) {
  const rows = findOrderArray(value);
  return rows ? rows.map(normalizeOrderRecord) : [];
}

function orderAmount(order) {
  return Number.isFinite(order.amountPaise)
    ? `₹${(order.amountPaise / 100).toFixed(2)}`
    : '—';
}

function orderItemsSummary(order) {
  if (!order.products.length) {
    return `${order.itemCount || 0} item${order.itemCount === 1 ? '' : 's'}`;
  }
  const visible = order.products
    .slice(0, 2)
    .map((product) => `${product.name}${product.count > 1 ? ` ×${product.count}` : ''}`);
  const remaining = order.products.length - visible.length;
  return `${visible.join(', ')}${remaining > 0 ? ` +${remaining}` : ''}`;
}

function orderTime(order) {
  if (!order.placedTime) return order.code ? `Order ${order.code}` : 'Zepto order';
  const parsed = new Date(order.placedTime);
  if (Number.isNaN(parsed.getTime())) return String(order.placedTime);
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}

function orderStatusTone(status) {
  if (status === 'DELIVERED') return 'success';
  if (['CANCELLED', 'CANCELED', 'FAILED'].includes(status)) return 'warning';
  return 'info';
}

function orderEta(order) {
  if (TERMINAL_ORDER_STATUSES.has(order.status)) return null;
  const eta = Number(order.etaMinutes);
  return Number.isFinite(eta) && eta >= 0 ? Math.ceil(eta) : null;
}

function normalizeAddressRecord(address) {
  const nestedAddress =
    address?.address && typeof address.address === 'object'
      ? address.address
      : {};
  const value = { ...nestedAddress, ...address };
  const detail =
    value.shortAddress
    || value.short_address
    || value.formattedAddress
    || value.formatted_address
    || value.displayAddress
    || value.display_address
    || value.addressLine
    || value.address_line
    || (typeof value.address === 'string' ? value.address : '')
    || [
      value.flatDetails || value.flat_details || value.addressLine1 || value.address_line_1,
      value.buildingName || value.building_name || value.addressLine2 || value.address_line_2,
      value.landmark,
      value.city,
      value.state,
      value.pincode || value.postalCode || value.postal_code,
    ].filter(Boolean).join(', ');
  return {
    ...address,
    id:
      value.id
      || value._id
      || value.addressId
      || value.address_id
      || value.userAddressId
      || value.user_address_id
      || null,
    label:
      value.label
      || value.name
      || value.type
      || value.addressType
      || value.address_type
      || 'Saved address',
    formattedAddress: detail,
  };
}

function findAddressArray(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const addressRecords = value.filter((entry) =>
      entry
      && typeof entry === 'object'
      && !Array.isArray(entry)
      && [
        'id', '_id', 'addressId', 'address_id', 'userAddressId',
        'user_address_id', 'formattedAddress', 'formatted_address',
        'shortAddress', 'short_address', 'displayAddress', 'flatDetails',
        'addressLine', 'address_line', 'addressLine1', 'address_line_1',
        'pincode',
      ].some((key) => entry[key] !== undefined)
    );
    if (addressRecords.length > 0) return addressRecords;
    for (const entry of value) {
      const nested = findAddressArray(entry, depth + 1);
      if (nested) return nested;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const preferredKeys = [
    'addresses',
    'savedAddresses',
    'saved_addresses',
    'userAddresses',
    'user_addresses',
    'items',
    'data',
    'result',
    'structuredContent',
  ];
  for (const key of preferredKeys) {
    if (value[key] !== undefined) {
      const nested = findAddressArray(value[key], depth + 1);
      if (nested) return nested;
    }
  }
  for (const nestedValue of Object.values(value)) {
    const nested = findAddressArray(nestedValue, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function addressTextValues(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => addressTextValues(entry, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.values(value)
      .flatMap((entry) => addressTextValues(entry, depth + 1));
  }
  return [];
}

function parseAddressText(data) {
  const text = String(data || '').trim();
  if (/^[\[{]/.test(text)) {
    try {
      return parseAddressResponse(JSON.parse(text));
    } catch {
      // Continue with the Zepto MCP text response.
    }
  }
  const [visible, internal = ''] = text.split(/\n---\n/);
  const ids = new Map(
    Array.from(
      internal.matchAll(/^\s*(\d+)[.)]\s+.*?(?:→|->)?\s*(?:Address\s*)?ID:\s*["']?([^"'\s,]+)["']?/gim),
      (match) => [match[1], match[2]]
    )
  );
  const lineAddresses = Array.from(
    visible.matchAll(/^\s*(\d+)[.)]\s+\**([^:\n*]+?)\**\s*:\s*(.+)$/gm),
    (match) => ({
      id: ids.get(match[1]) || null,
      label: match[2].trim(),
      formattedAddress: match[3].trim(),
    })
  );
  if (lineAddresses.length > 0) return lineAddresses;
  return Array.from(
    visible.matchAll(
      /(?:^|\n)\s*(\d+)[.)]\s+\**([^\n:*]+?)\**\s*(?:\n|\r\n)([\s\S]*?)(?=(?:\r?\n)\s*\d+[.)]|\s*$)/g
    ),
    (match) => {
      const block = match[3];
      const inlineId =
        block.match(/(?:Address\s*)?ID:\s*["']?([^"'\s,]+)/i)?.[1]
        || ids.get(match[1])
        || null;
      const blockDetail =
        block.match(/(?:Address|Location):\s*(.+)/i)?.[1]
        || block
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !/(?:Address\s*)?ID:/i.test(line))
          .join(', ');
      return {
        id: inlineId,
        label: match[2].trim(),
        formattedAddress: blockDetail.trim(),
      };
    }
  );
}

function parseAddressResponse(data) {
  if (typeof data === 'string') return parseAddressText(data);
  const values = findAddressArray(data);
  if (values) return values.map(normalizeAddressRecord);
  for (const text of addressTextValues(data).sort((a, b) => b.length - a.length)) {
    const parsed = parseAddressText(text);
    if (parsed.length > 0) return parsed;
  }
  return [];
}

function parseProductResponse(data) {
  if (typeof data !== 'string') {
    const values = data?.products || data?.items || data?.data?.products || data?.data || data || [];
    return Array.isArray(values) ? values : [];
  }
  const [visible, internal = ''] = data.split(/\n---\n/);
  const ids = new Map(
    Array.from(
      internal.matchAll(/^\[(\d+)\]\s+pvid:\s*([^,\s]+),\s*spid:\s*([^\s]+)/gm),
      (match) => [match[1], {
        productVariantId: match[2],
        storeProductId: match[3],
      }]
    )
  );
  return Array.from(
    visible.matchAll(/^(\d+)\.\s+(.+?)\s+-\s+₹([\d,.]+)\s+\((.+)\)$/gm),
    (match) => ({
      name: match[2].trim(),
      priceRupees: Number(match[3].replace(/,/g, '')),
      packSize: match[4].trim(),
      ...(ids.get(match[1]) || {}),
    })
  );
}

function normalizeCartItem(item) {
  return {
    ...item,
    name: item.name || item.label || item.productName || item.product_name || 'Item',
    quantity: Number(item.quantity ?? item.qty ?? item.count ?? 0),
    productVariantId:
      item.productVariantId
      || item.product_variant_id
      || item.pvid
      || item.variantId
      || item.id
      || '',
    storeProductId:
      item.storeProductId
      || item.store_product_id
      || item.spid
      || item.productId
      || '',
  };
}

function normalizeCartResponse(data) {
  if (typeof data !== 'string') {
    const candidates = [
      data,
      data?.items,
      data?.cartItems,
      data?.products,
      data?.cart?.items,
      data?.cart?.cartItems,
      data?.data,
      data?.data?.items,
      data?.data?.cartItems,
      data?.data?.cart?.items,
      data?.result,
      data?.result?.items,
      data?.result?.cartItems,
    ];
    const values = candidates.find(Array.isArray);
    return {
      items: values ? values.map(normalizeCartItem) : [],
      readable: Boolean(values),
      explicitlyEmpty: Boolean(values && values.length === 0),
    };
  }
  const text = data.trim();
  if (/^[\[{]/.test(text)) {
    try {
      return normalizeCartResponse(JSON.parse(text));
    } catch {
      // Continue with the Zepto MCP text format.
    }
  }
  const items = Array.from(
    data.matchAll(/^[ \t]*\d+\.\s+(.+?)\s+-\s+₹([\d,.]+)\s+\(Qty:\s*([\d.]+)\)[ \t]*\r?\n[ \t]*pvid:\s*([^,\s]+),\s*spid:\s*([^\s]+)/gm),
    (match) => ({
      name: match[1].trim(),
      priceRupees: Number(match[2].replace(/,/g, '')),
      quantity: Number(match[3]),
      productVariantId: match[4],
      storeProductId: match[5],
    })
  );
  const explicitlyEmpty = /(?:cart is empty|empty cart|no (?:cart )?items)/i.test(text);
  return {
    items,
    readable: items.length > 0 || explicitlyEmpty,
    explicitlyEmpty,
  };
}

function productId(product) {
  return product.productVariantId
    || product.product_variant_id
    || product.pvid
    || product.variantId
    || product.id
    || '';
}

function storeProductId(product) {
  return product.storeProductId
    || product.store_product_id
    || product.spid
    || product.productId
    || '';
}

function productPrice(product) {
  if (product.priceRupees !== undefined) return `₹${Number(product.priceRupees).toFixed(2)}`;
  const value = Number(product.price ?? product.sellingPrice);
  if (!Number.isFinite(value)) return '';
  return `₹${(value > 100 ? value / 100 : value).toFixed(2)}`;
}

function productPriceRupees(product) {
  if (Number.isFinite(Number(product.priceRupees))) {
    return Number(product.priceRupees);
  }
  const value = Number(product.price ?? product.sellingPrice);
  if (!Number.isFinite(value)) return 0;
  return value > 100 ? value / 100 : value;
}

function merchantResultText(data) {
  return typeof data === 'string' ? data : JSON.stringify(data || {});
}

function merchantOnlinePaymentAvailable(data) {
  if (typeof data?.onlinePaymentAvailable === 'boolean') {
    return data.onlinePaymentAvailable;
  }
  const text = merchantResultText(data).replace(/[_-]+/g, ' ');
  if (
    /\b(?:pay(?:ment)?\s*online|online\s*pay(?:ment)?|prepaid|payment\s*link|card(?:s|\s*payment)?|upi|wallets?|net\s*banking|digital\s*payment)\b/i.test(text)
  ) {
    return true;
  }
  return !(
    /\b(?:cash\s+on\s+delivery|cod)\s+only\b/i.test(text)
    || (
      /\b(?:cash\s+on\s+delivery|cod)\b/i.test(text)
      && !/\b(?:online|prepaid|card|upi|wallet|payment\s*link)\b/i.test(text)
    )
  );
}

function orderPreviewAmount(data) {
  const rawBreakdownTotal = data?.priceBreakdown?.totalPaise;
  const breakdownTotal = Number(rawBreakdownTotal);
  if (
    rawBreakdownTotal !== null
    && rawBreakdownTotal !== undefined
    && rawBreakdownTotal !== ''
    && Number.isFinite(breakdownTotal)
    && breakdownTotal >= 0
  ) {
    return `₹${(breakdownTotal / 100).toFixed(2)}`;
  }
  const direct = Number(
    data?.toPayAmount
    ?? data?.amountToPay
    ?? data?.amount
    ?? data?.total
    ?? data?.orderTotal
    ?? data?.data?.toPayAmount
    ?? data?.data?.amountToPay
  );
  if (Number.isFinite(direct) && direct > 0) {
    return `₹${(direct > 100 ? direct / 100 : direct).toFixed(2)}`;
  }
  const match = merchantResultText(data).match(/Amount To Pay:\s*₹\s*([\d,.]+)/i);
  return match ? `₹${match[1]}` : 'the displayed total';
}

function formatPaise(value) {
  const amount = Number(value);
  return Number.isFinite(amount)
    ? `₹${(amount / 100).toFixed(2)}`
    : '—';
}

function ZeptoPriceBreakdown({ breakdown, fallbackAmount }) {
  const lines = Array.isArray(breakdown?.lines) ? breakdown.lines : [];
  const rawTotal = breakdown?.totalPaise;
  const totalAvailable =
    rawTotal !== null
    && rawTotal !== undefined
    && rawTotal !== ''
    && Number.isFinite(Number(rawTotal));
  if (!lines.length && !totalAvailable) {
    return (
      <div className="zepto-price-breakdown compact">
        <div className="price-summary-title">
          <strong>Complete price breakdown</strong>
          <span>Zepto checkout</span>
        </div>
        <div className="price-total"><span>Order total</span><strong>{fallbackAmount}</strong></div>
        <small>Zepto MCP did not return separate taxes or charges for this preview.</small>
      </div>
    );
  }
  return (
    <div className="zepto-price-breakdown">
      <div className="price-summary-title">
        <strong>Complete price breakdown</strong>
        <span>Zepto checkout</span>
      </div>
      {lines.map((line) => (
        <div key={line.key} className={line.informational ? 'price-informational' : ''}>
          <span>{line.label}</span>
          <strong>{line.subtract ? '−' : ''}{formatPaise(line.amountPaise)}</strong>
        </div>
      ))}
      <div className="price-total">
        <span>Total payable</span>
        <strong>{totalAvailable ? formatPaise(breakdown.totalPaise) : fallbackAmount}</strong>
      </div>
      <small>All available amounts are consolidated here from the Zepto checkout preview. Item total is calculated from Zepto item prices when Zepto omits its subtotal.</small>
    </div>
  );
}

function onlineOrderDetails(data) {
  const text = merchantResultText(data);
  const orderId =
    data?.orderId
    || data?.order_id
    || data?.id
    || data?.order?.id
    || data?.order?.orderId
    || data?.data?.orderId
    || data?.data?.order_id
    || data?.data?.id
    || data?.result?.orderId
    || data?.result?.order_id
    || data?.result?.id
    || data?.recoveredOrder?.id
    || text.match(/Order\s*ID:\s*\**\s*([A-Za-z0-9_-]+)/i)?.[1]
    || null;
  const suppliedLink =
    data?.paymentLink
    || data?.paymentUrl
    || data?.payment_url
    || data?.url
    || data?.data?.paymentLink
    || data?.data?.paymentUrl
    || data?.order?.paymentLink
    || data?.order?.paymentUrl
    || data?.result?.paymentLink
    || data?.result?.paymentUrl
    || null;
  const matchedLink = text.match(/https?:\/\/[^\s<>"']+/i)?.[0] || null;
  const paymentLink = String(suppliedLink || matchedLink || '').replace(/[)\].,]+$/, '');
  return {
    orderId,
    paymentLink: /^https:\/\//i.test(paymentLink) ? paymentLink : null,
  };
}

function merchantPaymentStatus(data) {
  const direct =
    data?.paymentStatus
    || data?.status
    || data?.data?.paymentStatus
    || data?.data?.status;
  if (direct) return String(direct).toUpperCase();
  const text = merchantResultText(data).toUpperCase();
  return (
    ['CANCELLED', 'CANCELED', 'FAILED', 'SUCCESS', 'COMPLETED', 'PAID', 'PENDING', 'PROCESSING']
      .find((value) => text.includes(value))
    || 'UNKNOWN'
  );
}

function ShopPage({ setup, onConnectZepto, onAddCard }) {
  const cartStorageKey = `tokko-zepto-cart:${setup.zeptoPhone || setup.profile.phone || 'default'}`;
  const initialContactPhone = phoneParts(setup.profile.phone);
  const [addresses, setAddresses] = useState([]);
  const [selectedAddress, setSelectedAddress] = useState('');
  const [query, setQuery] = useState('');
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState(() => {
    const stored = readStoredValue(cartStorageKey, []);
    return Array.isArray(stored) ? stored : [];
  });
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutStatus, setCheckoutStatus] = useState('');
  const [checkoutPreview, setCheckoutPreview] = useState(null);
  const [pricePreview, setPricePreview] = useState(null);
  const [mandates, setMandates] = useState([]);
  const [codDecisionDismissed, setCodDecisionDismissed] = useState(false);
  const [savedCards, setSavedCards] = useState(
    setup.cards?.length
      ? setup.cards
      : setup.card?.connected
        ? [setup.card]
        : []
  );
  const [selectedCardKey, setSelectedCardKey] = useState('');
  const [onlineAvailable, setOnlineAvailable] = useState(false);
  const [onlineOrder, setOnlineOrder] = useState(null);
  const [onlineFailures, setOnlineFailures] = useState(0);
  const [lastZeptoPaymentStatus, setLastZeptoPaymentStatus] = useState(null);
  const [activeCheckoutFlow, setActiveCheckoutFlow] = useState(null);
  const [pravaPaymentResult, setPravaPaymentResult] = useState(null);
  const [addressFormOpen, setAddressFormOpen] = useState(false);
  const [addressBusy, setAddressBusy] = useState(false);
  const [locationBusy, setLocationBusy] = useState(false);
  const [addressStatus, setAddressStatus] = useState('');
  const [addressForm, setAddressForm] = useState({
    type: 'HOME',
    name: 'Home',
    flatDetails: '',
    buildingName: '',
    floor: '',
    landmark: '',
    shortAddress: '',
    contactName: setup.profile.name || '',
    contactCountryCode: initialContactPhone.countryCode,
    contactLocalPhone: initialContactPhone.localPhone,
    latitude: '',
    longitude: '',
  });
  const checkoutCardKey = (method) =>
    String(
      method.id
      || `${method.provider || 'prava'}:${method.last4}:${method.expMonth}:${method.expYear}`
    );
  const savedCard =
    savedCards.find((method) => checkoutCardKey(method) === selectedCardKey)
    || savedCards.find((method) => method.isDefault)
    || savedCards[0]
    || null;

  useEffect(() => {
    localStorage.setItem(cartStorageKey, JSON.stringify(cart));
  }, [cart, cartStorageKey]);

  const loadCart = async ({ preserveEmpty = false } = {}) => {
    const data = await api('/api/cart');
    const normalized = normalizeCartResponse(data);
    if (
      normalized.readable
      && (normalized.items.length > 0 || !preserveEmpty)
    ) {
      setCart(normalized.items);
    }
    return normalized;
  };

  useEffect(() => {
    if (!setup.zeptoConnected) return;
    let active = true;
    Promise.all([api('/api/addresses'), api('/api/cart')])
      .then(([addressData, cartData]) => {
        if (!active) return;
        const nextAddresses = parseAddressResponse(addressData);
        const nextCart = normalizeCartResponse(cartData);
        setAddresses(nextAddresses);
        if (nextCart.readable) {
          setCart((current) =>
            nextCart.items.length || !current.length
              ? nextCart.items
              : current
          );
        }
        if (!nextAddresses.length) {
          setStatus(
            `Zepto returned no saved addresses for ${setup.zeptoPhone || setup.profile.phone}. Refresh or reconnect if this is not the intended Zepto account.`
          );
        }
        const first = nextAddresses[0];
        const firstId = first?.id;
        if (firstId) {
          setSelectedAddress(firstId);
          api('/api/addresses/select', {
            method: 'POST',
            body: { addressId: firstId },
          }).catch(() => {});
        }
      })
      .catch((error) => setStatus(error.message));
    return () => {
      active = false;
    };
  }, [setup.zeptoConnected, cartStorageKey]);

  const refreshAddresses = async () => {
    setStatus('Refreshing saved addresses from Zepto…');
    try {
      const addressData = await api('/api/addresses');
      const nextAddresses = parseAddressResponse(addressData);
      setAddresses(nextAddresses);
      if (!nextAddresses.length) {
        setStatus(
          `Zepto returned no saved addresses for ${setup.zeptoPhone || setup.profile.phone}. Reconnect Zepto if this is the wrong account.`
        );
        return;
      }
      const currentStillExists = nextAddresses.some(
        (address) => address.id === selectedAddress
      );
      const nextId = currentStillExists
        ? selectedAddress
        : nextAddresses.find((address) => address.id)?.id;
      if (nextId) {
        setSelectedAddress(nextId);
        await api('/api/addresses/select', {
          method: 'POST',
          body: { addressId: nextId },
        });
      }
      setStatus(`${nextAddresses.length} saved Zepto address${nextAddresses.length === 1 ? '' : 'es'} loaded.`);
    } catch (error) {
      setStatus(`Could not refresh Zepto addresses: ${error.message}`);
    }
  };

  const chooseAddress = async (addressId) => {
    setSelectedAddress(addressId);
    setCheckoutPreview(null);
    setPricePreview(null);
    setCodDecisionDismissed(false);
    setOnlineOrder(null);
    setLastZeptoPaymentStatus(null);
    setStatus('Selecting delivery address…');
    try {
      await api('/api/addresses/select', {
        method: 'POST',
        body: { addressId },
      });
      if (cartOpen && cart.length) {
        const preview = await api('/api/order', {
          method: 'POST',
          body: {
            userAddressId: addressId,
            confirmOrder: false,
            useZeptoCash: false,
            riderTip: 0,
          },
        });
        setPricePreview({
          amount: orderPreviewAmount(preview),
          priceBreakdown: preview.priceBreakdown || {},
        });
      }
      setStatus('Delivery address selected.');
    } catch (error) {
      setStatus(error.message);
    }
  };

  const updateAddressForm = (key, value) => {
    setAddressForm((current) => ({ ...current, [key]: value }));
  };

  const getBrowserLocation = () => new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('This browser does not support location access.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      }),
      (error) => reject(
        new Error(`Location access failed: ${error.message}`)
      ),
      {
        enableHighAccuracy: true,
        timeout: 15_000,
        maximumAge: 300_000,
      }
    );
  });

  const optionalAddressCoordinates = () => {
    const suppliedLatitude = addressForm.latitude.trim();
    const suppliedLongitude = addressForm.longitude.trim();
    if (!suppliedLatitude && !suppliedLongitude) return {};
    if (!suppliedLatitude || !suppliedLongitude) {
      throw new Error(
        'Enter both latitude and longitude, or leave both blank.'
      );
    }
    const latitude = Number(suppliedLatitude);
    const longitude = Number(suppliedLongitude);
    if (
      !Number.isFinite(latitude)
      || latitude < -90
      || latitude > 90
      || !Number.isFinite(longitude)
      || longitude < -180
      || longitude > 180
      || (latitude === 0 && longitude === 0)
    ) {
      throw new Error(
        'Enter valid coordinates, or leave both latitude and longitude blank.'
      );
    }
    return { latitude, longitude };
  };

  const captureBrowserLocation = async () => {
    setLocationBusy(true);
    setAddressStatus('Requesting your browser location…');
    try {
      const coordinates = await getBrowserLocation();
      setAddressForm((current) => ({
        ...current,
        latitude: String(coordinates.latitude),
        longitude: String(coordinates.longitude),
      }));
      setAddressStatus('Location captured. You can now save the address.');
    } catch (error) {
      setAddressStatus(
        `${error.message} Location is optional; you can leave both coordinate fields blank.`
      );
    } finally {
      setLocationBusy(false);
    }
  };

  const saveAddressToZepto = async (event) => {
    event.preventDefault();
    const localPhone = normalizeLocalPhone(
      addressForm.contactCountryCode,
      addressForm.contactLocalPhone
    );
    if (
      addressForm.contactCountryCode !== '+91'
      || !/^[6-9]\d{9}$/.test(localPhone)
    ) {
      setAddressStatus('Zepto requires a valid 10-digit Indian delivery mobile number.');
      return;
    }
    setAddressBusy(true);
    setAddressStatus(
      'Saving this address to your Zepto account…'
    );
    try {
      const previousIds = new Set(
        addresses.map((address) => address.id).filter(Boolean)
      );
      const coordinates = optionalAddressCoordinates();
      const savedResponse = await api('/api/addresses', {
        method: 'POST',
        body: {
          type: addressForm.type,
          name: addressForm.name.trim(),
          flatDetails: addressForm.flatDetails.trim(),
          buildingName: addressForm.buildingName.trim(),
          floor: addressForm.floor.trim(),
          landmark: addressForm.landmark.trim(),
          shortAddress: addressForm.shortAddress.trim(),
          contactName: addressForm.contactName.trim(),
          contactNumber: toE164(
            addressForm.contactCountryCode,
            localPhone
          ),
          ...coordinates,
        },
      });
      let refreshed = parseAddressResponse(savedResponse);
      if (!refreshed.length) {
        refreshed = parseAddressResponse(await api('/api/addresses'));
      }
      setAddresses(refreshed);
      const matchingAddress =
        refreshed.find((address) =>
          address.id && !previousIds.has(address.id)
        )
        || [...refreshed].reverse().find((address) =>
          address.id
          && String(address.name || address.label || address.type || '')
            .toLowerCase() === addressForm.name.trim().toLowerCase()
        );
      if (matchingAddress?.id) {
        await chooseAddress(matchingAddress.id);
      }
      setAddressFormOpen(false);
      setAddressStatus('');
      setStatus(
        matchingAddress?.id
          ? 'Address saved to your Zepto account and selected.'
          : 'Address saved to your Zepto account. Refresh the address list if Zepto takes a moment to return it.'
      );
      setCheckoutStatus('Delivery address saved to Zepto.');
      setAddressForm((current) => ({
        ...current,
        name: current.type === 'HOME' ? 'Home' : current.type === 'WORK' ? 'Work' : '',
        flatDetails: '',
        buildingName: '',
        floor: '',
        landmark: '',
        shortAddress: '',
        latitude: '',
        longitude: '',
      }));
    } catch (error) {
      setAddressStatus(error.message);
    } finally {
      setAddressBusy(false);
    }
  };

  const search = async (event) => {
    event.preventDefault();
    if (!query.trim()) return;
    if (!selectedAddress) {
      setStatus('Select a saved delivery address first.');
      return;
    }
    setBusy(true);
    setStatus(`Searching Zepto for “${query.trim()}”…`);
    setProducts([]);
    try {
      const found = [];
      const seen = new Set();
      for (let pageNumber = 0; pageNumber < 50; pageNumber += 1) {
        const data = await api(`/api/search?q=${encodeURIComponent(query.trim())}&pageNumber=${pageNumber}`);
        const pageProducts = parseProductResponse(data);
        if (!pageProducts.length) break;
        let added = 0;
        for (const product of pageProducts) {
          const id = productId(product) || `${product.name}:${product.packSize}:${product.price}`;
          if (seen.has(id)) continue;
          seen.add(id);
          found.push(product);
          added += 1;
        }
        setProducts([...found]);
        setStatus(`${found.length} matches found—checking for more…`);
        if (!added || pageProducts.length < 10) break;
      }
      setStatus(found.length ? `${found.length} Zepto matches found.` : 'No products found.');
      await loadCart({ preserveEmpty: true });
    } catch (error) {
      setStatus(error.message);
    } finally {
      setBusy(false);
    }
  };

  const quantityFor = (product) => {
    const id = productId(product);
    return Number(cart.find((item) => productId(item) === id)?.quantity || 0);
  };

  const setQuantity = async (product, quantity) => {
    const variantId = productId(product);
    const storeId = storeProductId(product);
    if (!variantId || !storeId) {
      setStatus('Zepto did not return the product identifiers.');
      return;
    }
    const nextQuantity = Math.max(0, quantity);
    const previousCart = cart;
    const existingIndex = cart.findIndex((item) => productId(item) === variantId);
    const optimisticItem = normalizeCartItem({
      ...product,
      productVariantId: variantId,
      storeProductId: storeId,
      quantity: nextQuantity,
    });
    const optimisticCart = [...cart];
    if (existingIndex >= 0 && nextQuantity === 0) {
      optimisticCart.splice(existingIndex, 1);
    } else if (existingIndex >= 0) {
      optimisticCart[existingIndex] = {
        ...optimisticCart[existingIndex],
        ...optimisticItem,
      };
    } else if (nextQuantity > 0) {
      optimisticCart.push(optimisticItem);
    }
    setCart(optimisticCart);
    if (nextQuantity > 0) setCartOpen(true);
    setCheckoutPreview(null);
    setPricePreview(null);
    setCodDecisionDismissed(false);
    setOnlineOrder(null);
    setStatus(`Updating ${product.name || product.label}…`);
    try {
      await api('/api/cart', {
        method: 'POST',
        body: {
          deviceId: setup.zeptoPhone || setup.profile.phone || 'tokko-web',
          cartItems: [{
            productVariantId: variantId,
            storeProductId: storeId,
            quantity: nextQuantity,
            name: product.name || product.label || 'Item',
            label: product.label || product.name || 'Item',
            price: product.price ?? (
              Number.isFinite(product.priceRupees)
                ? Math.round(product.priceRupees * 100)
                : undefined
            ),
            mrp: product.mrp,
            imageUrl: product.imageUrl || product.image,
            packSize: product.packSize || product.quantityLabel,
          }],
        },
      });
      await loadCart({ preserveEmpty: nextQuantity > 0 });
      if (nextQuantity > 0) await loadCheckout();
      setStatus(`Cart quantity updated to ${nextQuantity}.`);
    } catch (error) {
      setCart(previousCart);
      setStatus(error.message);
    }
  };

  const cartUnits = cart.reduce(
    (total, item) => total + Number(item.quantity || 0),
    0
  );

  const loadCheckout = async () => {
    setCartOpen(true);
    setCheckoutStatus('Loading cart and payment options…');
    const [cartResult, savedResult, zeptoResult, priceResult, mandateResult] = await Promise.allSettled([
      loadCart({ preserveEmpty: true }),
      api('/api/payments/payment-methods'),
      api('/api/payment-methods'),
      selectedAddress && cartUnits
        ? api('/api/order', {
            method: 'POST',
            body: {
              userAddressId: selectedAddress,
              confirmOrder: false,
              useZeptoCash: false,
              riderTip: 0,
            },
          })
        : Promise.resolve(null),
      api('/api/payments/mandates').catch(() => ({ mandates: [] })),
    ]);
    if (savedResult.status === 'fulfilled') {
      const methods = savedResult.value?.paymentMethods || [];
      const availableMethods = methods.length
        ? methods
        : setup.card?.connected
          ? [setup.card]
          : [];
      const preferred =
        availableMethods.find((method) => method.isDefault)
        || availableMethods[0];
      setSavedCards(availableMethods);
      setSelectedCardKey(preferred ? checkoutCardKey(preferred) : '');
    }
    if (zeptoResult.status === 'fulfilled') {
      setOnlineAvailable(merchantOnlinePaymentAvailable(zeptoResult.value));
    } else {
      setOnlineAvailable(false);
    }
    if (priceResult.status === 'fulfilled' && priceResult.value) {
      setPricePreview({
        amount: orderPreviewAmount(priceResult.value),
        priceBreakdown: priceResult.value.priceBreakdown || {},
      });
    } else if (priceResult.status === 'rejected') {
      setPricePreview(null);
    }
    if (mandateResult.status === 'fulfilled') {
      setMandates(mandateResult.value?.mandates || []);
    }
    const failures = [cartResult, savedResult, zeptoResult, priceResult]
      .filter((result) => result.status === 'rejected');
    setCheckoutStatus(
      failures.length
        ? 'Some live details could not be refreshed. Your visible cart is preserved; Cash on Delivery remains available.'
        : selectedAddress
          ? 'Review the complete total, then choose a payment method.'
          : 'Select an address to load the complete total.'
    );
  };

  const reviewCheckout = async (mode) => {
    if (!selectedAddress) {
      setCheckoutStatus('Select a delivery address first.');
      return;
    }
    if (!cartUnits) {
      setCheckoutStatus('Your cart is empty.');
      return;
    }
    if (mode === 'online' && !savedCard) {
      setCheckoutStatus('Add and tokenize a card with Prava before paying online.');
      return;
    }
    setCheckoutBusy(true);
    setLastZeptoPaymentStatus(null);
    setCheckoutStatus(
      mode === 'online'
        ? 'Preparing saved-card checkout…'
        : 'Preparing Cash on Delivery checkout…'
    );
    try {
      const id =
        checkoutPreview?.mode === mode && checkoutPreview?.id
          ? checkoutPreview.id
          : crypto.randomUUID();
      const preview = await api(
        mode === 'online' ? '/api/order/online' : '/api/order',
        {
          method: 'POST',
          body: {
            checkoutId: id,
            userAddressId: selectedAddress,
            confirmOrder: false,
            useZeptoCash: false,
            riderTip: 0,
            ...(mode === 'online'
              ? {
                  paymentMethodId: savedCard?.id,
                  mandateId: coveringMandate?.id,
                  allowCodFallback: setup.mandate?.codFallback !== false,
                }
              : {}),
          },
        }
      );
      const nextPreview = {
        id,
        mode,
        amount: orderPreviewAmount(preview),
        sandbox:
          mode === 'online'
          && preview.pravaEnvironment === 'sandbox',
        priceBreakdown: preview.priceBreakdown || {},
        paymentHandoff: preview.paymentHandoff || null,
        mandateId:
          preview.checkoutFlow?.pravaCharge?.mandateId
          || coveringMandate?.id
          || null,
      };
      setCheckoutPreview(nextPreview);
      setPricePreview({
        amount: orderPreviewAmount(preview),
        priceBreakdown: preview.priceBreakdown || {},
      });
      setOnlineFailures(
        Number(preview.checkoutFlow?.cardFailureCount || 0)
      );
      setActiveCheckoutFlow(preview.checkoutFlow || null);
      setPravaPaymentResult(preview.pravaPaymentResult || null);
      if (nextPreview.sandbox && mode === 'online') {
        await createOnlinePaymentAttempt(nextPreview);
      } else {
        setCheckoutStatus('Review the order details, then confirm.');
      }
    } catch (error) {
      setCheckoutStatus(`Could not prepare checkout: ${error.message}`);
    } finally {
      setCheckoutBusy(false);
    }
  };

  const clearPlacedCart = async () => {
    setCart([]);
    setCheckoutPreview(null);
    setPricePreview(null);
    setCodDecisionDismissed(false);
    setOnlineOrder(null);
    setActiveCheckoutFlow(null);
    setPravaPaymentResult(null);
  };

  const placeCodOrder = async ({ fallback = false } = {}) => {
    if (!selectedAddress) {
      setCheckoutStatus('Select a delivery address first.');
      return;
    }
    setCheckoutBusy(true);
    setCheckoutStatus(
      fallback
        ? 'Three online payments failed. Placing the order with Cash on Delivery…'
        : 'Placing your Cash on Delivery order…'
    );
    try {
      const result = await api('/api/order', {
        method: 'POST',
        body: {
          checkoutId: checkoutPreview?.id,
          userAddressId: selectedAddress,
          confirmOrder: true,
          useZeptoCash: false,
          riderTip: 0,
        },
      });
      const orderId = onlineOrderDetails(result).orderId;
      if (!orderId) {
        setCheckoutStatus(
          'Zepto accepted the COD request but its MCP order history has not confirmed a new order ID. Your cart was kept. Do not retry yet—check Orders first to avoid a duplicate.'
        );
        return;
      }
      await clearPlacedCart();
      setCheckoutStatus(
        fallback
          ? `Online payment failed three times. Cash on Delivery order ${orderId} was confirmed by Zepto.`
          : `Cash on Delivery order ${orderId} was confirmed by Zepto.`
      );
    } catch (error) {
      setCheckoutStatus(
        `${fallback ? 'COD fallback' : 'Cash on Delivery'} failed: ${error.message}`
      );
    } finally {
      setCheckoutBusy(false);
    }
  };

  const decideCodFallback = async (approve) => {
    if (!checkoutPreview?.id) return;
    setCheckoutBusy(true);
    setCheckoutStatus(
      approve
        ? 'COD approved. Asking Zepto to place the order…'
        : 'Keeping the cart without placing a COD order…'
    );
    try {
      const result = await api('/api/order/cod-decision', {
        method: 'POST',
        body: {
          checkoutId: checkoutPreview.id,
          approve,
        },
      });
      setActiveCheckoutFlow(result.checkoutFlow || null);
      setPravaPaymentResult(
        result.pravaPaymentResult || pravaPaymentResult
      );
      if (!approve) {
        setCodDecisionDismissed(true);
        setCheckoutStatus(
          'Cash on Delivery was declined. No order was created and your cart was kept.'
        );
        return;
      }
      const orderId = onlineOrderDetails(result).orderId;
      if (!orderId) {
        setCheckoutStatus(
          result.checkoutFlow?.failureMessage
          || 'COD was approved, but Zepto did not confirm an order ID. Your cart was kept.'
        );
        return;
      }
      await clearPlacedCart();
      setCheckoutStatus(
        `Cash on Delivery order ${orderId} was confirmed by Zepto after your approval.`
      );
    } catch (error) {
      setCheckoutStatus(`COD decision failed: ${error.message}`);
    } finally {
      setCheckoutBusy(false);
    }
  };

  const refreshPravaPaymentResult = async () => {
    if (!checkoutPreview?.id) return;
    setCheckoutBusy(true);
    try {
      const result = await api(
        `/api/payments/payment-results?checkoutId=${encodeURIComponent(checkoutPreview.id)}&limit=3`
      );
      setActiveCheckoutFlow(result.checkoutFlow || activeCheckoutFlow);
      setPravaPaymentResult(
        result.pravaPaymentResult
        || {
          provider: 'prava',
          flow: 'tokenization_session',
          sessionResults: result.sessionResults || [],
          note: result.note,
        }
      );
      setCheckoutStatus('Prava payment result refreshed.');
    } catch (error) {
      setCheckoutStatus(`Prava result could not be refreshed: ${error.message}`);
    } finally {
      setCheckoutBusy(false);
    }
  };

  const checkOnlinePaymentStatus = async (orderId = onlineOrder?.orderId) => {
    if (!orderId) {
      setCheckoutStatus('No online order is awaiting payment.');
      return;
    }
    setCheckoutBusy(true);
    setCheckoutStatus('Checking Zepto payment status…');
    try {
      const result = await api('/api/order/payment-status', {
        method: 'POST',
        body: {
          checkoutId: checkoutPreview?.id || onlineOrder?.checkoutId,
          orderId,
          poll: false,
        },
      });
      const flow = result.checkoutFlow;
      const paymentStatus = merchantPaymentStatus(result);
      setLastZeptoPaymentStatus(paymentStatus);
      setActiveCheckoutFlow(flow || null);
      setPravaPaymentResult(
        result.pravaPaymentResult || pravaPaymentResult
      );
      const sandboxMerchantAttempt =
        result.sandboxZeptoAttempt === true
        || flow?.sandboxPaymentAttempt === true
        || onlineOrder?.sandboxZeptoAttempt === true;
      const failureCount = Number(
        flow?.cardFailureCount || onlineFailures
      );
      setOnlineFailures(failureCount);
      if (flow?.status === 'COD_FALLBACK_CONFIRMED') {
        await clearPlacedCart();
        setCheckoutStatus(
          `Card payment was not received after three attempts. Zepto confirmed Cash on Delivery order ${flow.orderId}.`
        );
        return;
      }
      if (
        ['COD_FALLBACK_FAILED', 'COD_FALLBACK_UNCONFIRMED'].includes(flow?.status)
      ) {
        setOnlineOrder(null);
        setCheckoutStatus(flow.failureMessage);
        return;
      }
      if (['SUCCESS', 'COMPLETED', 'PAID'].includes(paymentStatus)) {
        await clearPlacedCart();
        setCheckoutStatus(
          `Card payment was received. Zepto order ${flow?.orderId || orderId} was placed.`
        );
        return;
      }
      if (['FAILED', 'CANCELLED', 'CANCELED'].includes(paymentStatus)) {
        setOnlineOrder(null);
        if (flow?.status === 'COD_PERMISSION_REQUIRED') {
          setCodDecisionDismissed(false);
          setCheckoutStatus(
            'Card payment failed three times. No COD order was created. Choose below whether Tokko may place one.'
          );
          return;
        }
        if (sandboxMerchantAttempt) {
          setCheckoutStatus(
            `${flow?.failureMessage || `Zepto reported the sandbox card payment ${paymentStatus.toLowerCase()}.`} ${Math.max(0, 3 - failureCount)} attempt${Math.max(0, 3 - failureCount) === 1 ? '' : 's'} remain before COD permission is requested.`
          );
          return;
        }
        const remaining = Math.max(0, 3 - failureCount);
        setCheckoutStatus(
          `Card payment was not received (attempt ${failureCount} of 3). ${remaining} card attempt${remaining === 1 ? '' : 's'} remain before Tokko asks for COD permission.`
        );
        return;
      }
      setCheckoutStatus(
        paymentStatus === 'UNKNOWN'
          ? 'Zepto did not return a definitive status. Check again before retrying.'
          : sandboxMerchantAttempt
            ? `Sandbox payment is ${paymentStatus.toLowerCase()}. Complete it on Zepto or check again.`
          : `Payment is ${paymentStatus.toLowerCase()}. Complete payment, then check again.`
      );
    } catch (error) {
      setCheckoutStatus(
        `Payment status could not be verified: ${error.message}. No COD order was created.`
      );
    } finally {
      setCheckoutBusy(false);
    }
  };

  const createOnlinePaymentAttempt = async (previewOverride = null) => {
    const paymentPreview = previewOverride || checkoutPreview;
    if (!paymentPreview) return;
    setCheckoutBusy(true);
    setCheckoutStatus(
      paymentPreview.sandbox
        ? 'Creating a real Zepto hosted-payment attempt with a Prava sandbox credential…'
        : `Creating online payment attempt ${onlineFailures + 1} of 3…`
    );
    try {
      const result = await api('/api/order/online', {
        method: 'POST',
        body: {
          checkoutId: paymentPreview.id,
          paymentMethodId: savedCard?.id,
          mandateId:
            paymentPreview.mandateId || coveringMandate?.id,
          allowCodFallback: true,
          userAddressId: selectedAddress,
          confirmOrder: true,
          useZeptoCash: false,
          riderTip: 0,
        },
      });
      const details = onlineOrderDetails(result);
      const flow = result.checkoutFlow;
      setLastZeptoPaymentStatus(merchantPaymentStatus(result));
      setActiveCheckoutFlow(flow || null);
      setPravaPaymentResult(
        result.pravaPaymentResult || pravaPaymentResult
      );
      const sandboxMerchantAttempt =
        result.sandboxZeptoAttempt === true
        || flow?.sandboxPaymentAttempt === true;
      const failureCount = Number(
        flow?.cardFailureCount || onlineFailures
      );
      setOnlineFailures(failureCount);
      if (flow?.status === 'COD_FALLBACK_CONFIRMED') {
        await clearPlacedCart();
        setCheckoutStatus(
          `Card payment was not received after three attempts. Zepto confirmed Cash on Delivery order ${flow.orderId}.`
        );
        return;
      }
      if (
        ['COD_FALLBACK_FAILED', 'COD_FALLBACK_UNCONFIRMED'].includes(flow?.status)
      ) {
        setOnlineOrder(null);
        setCheckoutStatus(flow.failureMessage);
        return;
      }
      if (flow?.status === 'CARD_PAYMENT_RECEIVED') {
        await clearPlacedCart();
        setCheckoutStatus(
          `Card payment was received. Zepto order ${flow.orderId || details.orderId} was placed.`
        );
        return;
      }
      if (flow?.status === 'CARD_PAYMENT_FAILED') {
        setOnlineOrder(null);
        const remaining = Math.max(0, 3 - failureCount);
        setCheckoutStatus(
          `Card payment was not received (attempt ${failureCount} of 3). ${remaining} card attempt${remaining === 1 ? '' : 's'} remain before Tokko asks for COD permission.`
        );
        return;
      }
      if (flow?.status === 'COD_PERMISSION_REQUIRED') {
        setOnlineOrder(null);
        setCodDecisionDismissed(false);
        setCheckoutStatus(
          'Card payment failed three times. No COD order was created. Choose below whether Tokko may place one.'
        );
        return;
      }
      if (flow?.status === 'SANDBOX_ZEPTO_PAYMENT_FAILED') {
        setOnlineOrder(null);
        const remaining = Math.max(0, 3 - failureCount);
        setCheckoutStatus(
          `${flow.failureMessage || 'The Prava sandbox attempt was closed as failed.'} Terminal sandbox attempt ${failureCount} of 3. ${remaining} attempt${remaining === 1 ? '' : 's'} remain before Tokko asks for COD permission.`
        );
        return;
      }
      if (!details.orderId) {
        setCheckoutStatus(
          'Card payment was not received and Zepto did not confirm an order ID. Your cart was kept.'
        );
        return;
      }
      setOnlineOrder({
        ...details,
        checkoutId: paymentPreview.id,
        sandboxZeptoAttempt: sandboxMerchantAttempt,
        paymentHandoff:
          result.paymentHandoff || null,
      });
      setCheckoutStatus(
        sandboxMerchantAttempt
            ? 'Zepto created a hosted payment attempt. Enter the Prava sandbox virtual PAN, expiry, and dynamic CVV there, then return and check payment status.'
          : details.paymentLink && result.paymentHandoff?.mode === 'prava_mandate'
          ? 'Prava issued a single-use credential. Enter it on Zepto’s secure card page, complete payment, then check status.'
          : details.paymentLink
            ? 'Card payment has not been received. Open Zepto secure payment, complete it, then check status.'
          : 'Card payment has not been received. Check Zepto payment status before taking another action.'
      );
    } catch (error) {
      setCheckoutStatus(
        `Card payment was not received: ${error.message}. Your cart was kept.`
      );
    } finally {
      setCheckoutBusy(false);
    }
  };

  const confirmCheckout = async () => {
    if (!checkoutPreview) return;
    if (checkoutPreview.mode === 'online') {
      await createOnlinePaymentAttempt();
    } else {
      await placeCodOrder();
    }
  };

  const activeMandate = summarizePravaMandates(mandates);
  const previewTotalRupees = (() => {
    const paise = pricePreview?.priceBreakdown?.totalPaise;
    if (
      paise !== null
      && paise !== undefined
      && Number.isFinite(Number(paise))
    ) {
      return Number(paise) / 100;
    }
    const displayed = String(pricePreview?.amount || '').replace(/[₹,\s]/g, '');
    return /^\d+(?:\.\d+)?$/.test(displayed) ? Number(displayed) : null;
  })();
  const mandateRemaining = activeMandate
    ? Math.max(0, Number(activeMandate.remaining || 0))
    : null;
  const coveringMandate = singlePravaMandateForAmount(
    mandates,
    previewTotalRupees
  );
  const mandateInsufficient =
    activeMandate
    && Number.isFinite(previewTotalRupees)
    && !coveringMandate;
  const codPermissionRequired =
    activeCheckoutFlow?.status === 'COD_PERMISSION_REQUIRED';

  if (!setup.zeptoConnected) {
    return <section className="empty-working-state"><div className="zepto-mark">Z</div><h2>Connect Zepto to start shopping</h2><p>Tokko will reuse the selected family phone after OTP verification.</p><button className="button zepto-button" onClick={onConnectZepto}>Connect Zepto</button></section>;
  }

  return (
    <div className="shop-page">
      <div className="dashboard-heading"><div><p className="eyebrow">Zepto personal shopper</p><h1>Find something for the family</h1><p>Saved addresses and products come directly from the Zepto MCP APIs.</p></div><button type="button" className="cart-summary cart-summary-button" onClick={loadCheckout}><ShoppingCart size={18} /> {cartUnits} item{cartUnits === 1 ? '' : 's'}<span>View cart</span></button></div>
      <section className="dashboard-section shop-addresses">
        <div className="section-heading"><div><h2>Select delivery address</h2><p>Choose one of your saved Zepto addresses for checkout</p></div><button type="button" className="button secondary-button compact-button" onClick={() => { setAddressStatus(''); setAddressFormOpen(true); }}><Plus size={15} /> Add address</button></div>
        <div className="address-chip-list">
          {addresses.map((address) => {
            const id = address.id;
            const label = address.type || address.name || address.label || 'Saved address';
            const detail = address.shortAddress || address.formattedAddress || address.address || address.displayAddress || '';
            return <button type="button" key={id || `${label}-${detail}`} aria-pressed={selectedAddress === id} className={`address-chip ${selectedAddress === id ? 'selected' : ''}`} onClick={() => id && chooseAddress(id)}><span className="address-chip-title"><strong>{label}</strong>{selectedAddress === id && <small><Check size={12} /> Selected</small>}</span><span>{detail}</span></button>;
          })}
          {!addresses.length && <div className="empty-address-state"><span>No saved addresses were returned by the connected Zepto account.</span><div><button type="button" className="button secondary-button" onClick={refreshAddresses}><RefreshCw size={14} /> Refresh</button><button type="button" className="button secondary-button" onClick={onConnectZepto}>Reconnect Zepto</button></div></div>}
        </div>
      </section>
      <form className="shop-search" onSubmit={search}>
        <Search size={20} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search milk, fruit, snacks…" />
        <button className="button primary-button" disabled={busy}>{busy ? 'Searching…' : 'Search'}</button>
      </form>
      {status && <p className="form-message" role="status">{status}</p>}
      <div className="shop-product-grid">
        {products.map((product, index) => {
          const quantity = quantityFor(product);
          const image = product.imageUrl || product.image;
          return (
            <article className="shop-product-card" key={productId(product) || `${product.name}-${index}`}>
              <div className="shop-product-image">
                {image ? <img src={image} alt="" loading="lazy" /> : <ShoppingBag size={30} />}
              </div>
              <div className="shop-product-copy"><strong>{product.name || product.label || 'Product'}</strong><span>{product.packSize || product.quantityLabel || ''}</span><b>{productPrice(product)}</b></div>
              {quantity > 0 ? <div className="shop-quantity"><button type="button" aria-label={`Decrease ${product.name}`} onClick={() => setQuantity(product, quantity - 1)}><Minus size={16} /></button><span>{quantity}</span><button type="button" aria-label={`Increase ${product.name}`} onClick={() => setQuantity(product, quantity + 1)}><Plus size={16} /></button></div> : <button type="button" className="button secondary-button" onClick={() => setQuantity(product, 1)}>Add to cart</button>}
            </article>
          );
        })}
      </div>
      {cartOpen && (
        <div className="shop-cart-overlay" onMouseDown={() => setCartOpen(false)}>
          <aside className="shop-cart-drawer" role="dialog" aria-modal="true" aria-label="Shopping cart and checkout" onMouseDown={(event) => event.stopPropagation()}>
            <div className="shop-cart-header">
              <div><p className="eyebrow">Your Zepto cart</p><h2>{cartUnits} item{cartUnits === 1 ? '' : 's'}</h2></div>
              <button type="button" className="icon-button subtle" aria-label="Close cart" onClick={() => setCartOpen(false)}><X size={20} /></button>
            </div>

            <div className="shop-cart-items">
              {cart.map((item, index) => {
                const quantity = Number(item.quantity || 0);
                const image = item.imageUrl || item.image;
                return (
                  <article className="shop-cart-item" key={`${productId(item) || item.name}-${index}`}>
                    <div className="shop-cart-item-image">{image ? <img src={image} alt="" /> : <ShoppingBag size={22} />}</div>
                    <div className="shop-cart-item-copy"><strong>{item.name || item.label}</strong><span>{item.packSize || item.quantityLabel || ''}</span><b>{productPrice(item)}</b></div>
                    <div className="shop-cart-quantity">
                      <button type="button" aria-label={`Decrease ${item.name}`} onClick={() => setQuantity(item, quantity - 1)}><Minus size={14} /></button>
                      <span>{quantity}</span>
                      <button type="button" aria-label={`Increase ${item.name}`} onClick={() => setQuantity(item, quantity + 1)}><Plus size={14} /></button>
                    </div>
                  </article>
                );
              })}
              {!cart.length && <div className="shop-cart-empty"><ShoppingCart size={30} /><strong>Your cart is empty</strong><span>Add a product to start checkout.</span></div>}
            </div>
            {!cart.length && checkoutStatus && (
              <p className="checkout-status" role="status">{checkoutStatus}</p>
            )}

            {!!cart.length && (
              <div className="shop-checkout">
                <section>
                  <div className="shop-checkout-heading checkout-heading-action"><MapPin size={18} /><div><strong>Deliver to</strong><span>Select a saved address</span></div><button type="button" onClick={() => { setAddressStatus(''); setAddressFormOpen(true); }}><Plus size={13} /> Add address</button></div>
                  <div className="checkout-address-list">
                    {addresses.map((address) => {
                      const id = address.id;
                      const label = address.type || address.name || address.label || 'Saved address';
                      const detail = address.shortAddress || address.formattedAddress || address.address || address.displayAddress || '';
                      return (
                        <button type="button" key={`checkout-${id || `${label}-${detail}`}`} className={`checkout-address ${selectedAddress === id ? 'selected' : ''}`} onClick={() => id && chooseAddress(id)}>
                          <span className="checkout-address-radio">{selectedAddress === id && <Check size={12} />}</span>
                          <span><strong>{label}</strong><small>{detail}</small></span>
                        </button>
                      );
                    })}
                    {!addresses.length && <p className="checkout-note">No saved addresses were returned. Add one above, refresh the account list, or reconnect Zepto.</p>}
                  </div>
                </section>

                <section className="checkout-price-before-payment">
                  <div className="shop-checkout-heading"><ReceiptText size={18} /><div><strong>Order total</strong><span>Review every charge before choosing payment</span></div></div>
                  {pricePreview ? (
                    <ZeptoPriceBreakdown
                      breakdown={pricePreview.priceBreakdown}
                      fallbackAmount={pricePreview.amount}
                    />
                  ) : (
                    <div className="checkout-price-loading">
                      <RefreshCw size={16} />
                      <span>{selectedAddress ? 'Loading the complete Zepto amount breakdown…' : 'Select a delivery address to calculate the complete total.'}</span>
                    </div>
                  )}
                </section>

                {mandateInsufficient && !codDecisionDismissed && (
                  <section className="mandate-cod-consent" role="alert">
                    <div className="mandate-cod-consent-heading"><CircleAlert size={18} /><div><strong>No single mandate can cover this cart</strong><span>Prava reports {formatMandateAmount(mandateRemaining, activeMandate.currency)} combined available, but Zepto accepts one card credential per payment. The payable total is {formatMandateAmount(previewTotalRupees, activeMandate.currency)}.</span></div></div>
                    <p>Do you permit Tokko to place this order with Cash on Delivery instead?</p>
                    <div>
                      <button type="button" className="button secondary-button" disabled={checkoutBusy} onClick={() => setCodDecisionDismissed(true)}>No, keep my cart</button>
                      <button type="button" className="button primary-button" disabled={checkoutBusy} onClick={() => placeCodOrder()}><Banknote size={16} /> Yes, place COD order</button>
                    </div>
                  </section>
                )}

                {codPermissionRequired && !codDecisionDismissed && (
                  <section className="mandate-cod-consent" role="alert">
                    <div className="mandate-cod-consent-heading">
                      <CircleAlert size={18} />
                      <div>
                        <strong>Three card attempts failed</strong>
                        <span>Each attempt created a Zepto hosted-payment order and a distinct Prava mandate transaction. Tokko has not created a COD order.</span>
                      </div>
                    </div>
                    <p>Do you permit Tokko to place this cart with Cash on Delivery now?</p>
                    <div>
                      <button type="button" className="button secondary-button" disabled={checkoutBusy} onClick={() => decideCodFallback(false)}>No, keep my cart</button>
                      <button type="button" className="button primary-button" disabled={checkoutBusy} onClick={() => decideCodFallback(true)}><Banknote size={16} /> Yes, place COD order</button>
                    </div>
                  </section>
                )}

                <section>
                  <div className="shop-checkout-heading"><CreditCard size={18} /><div><strong>Payment method</strong><span>Choose how you want to pay</span></div></div>
                  {!!savedCards.length && <div className="checkout-card-list">{savedCards.map((method) => {
                    const key = checkoutCardKey(method);
                    const selected = savedCard && checkoutCardKey(savedCard) === key;
                    return (
                      <button type="button" key={key} className={`checkout-saved-card ${selected ? 'selected' : ''}`} onClick={() => setSelectedCardKey(key)}>
                        <span className="checkout-address-radio">{selected && <Check size={12} />}</span>
                        <CreditCard size={18} />
                        <span className="checkout-card-copy"><strong>{String(method.brand || 'Card').toUpperCase()} •••• {method.last4}</strong><small>Saved with Prava{method.expMonth ? ` · expires ${method.expMonth}/${method.expYear}` : ''}</small></span>
                      </button>
                    );
                  })}</div>}
                  <div className="checkout-payment-actions">
                    <button type="button" className="button primary-button" disabled={checkoutBusy || !selectedAddress || !savedCard || !onlineAvailable} onClick={() => reviewCheckout('online')}><CreditCard size={17} /> Pay online</button>
                    <button type="button" className="button secondary-button" disabled={checkoutBusy || !selectedAddress} onClick={() => reviewCheckout('cod')}><Banknote size={17} /> Cash on Delivery</button>
                  </div>
                  {!savedCard && <div className="checkout-missing-card"><p className="checkout-note">No tokenized Prava card is saved. Add one securely now or use Cash on Delivery.</p><button type="button" className="button secondary-button" onClick={() => { setCartOpen(false); onAddCard?.(); }}><Plus size={15} /> Add card with Prava</button></div>}
                  {savedCard && <button type="button" className="checkout-add-card" onClick={() => { setCartOpen(false); onAddCard?.(); }}><Plus size={13} /> Add another card</button>}
                  {savedCard && !onlineAvailable && <p className="checkout-note">Zepto did not return online payment as available. Cash on Delivery remains available.</p>}
                  {savedCard && onlineAvailable && coveringMandate && <p className="checkout-note">Mandate {coveringMandate.id} can cover this total. After confirmation, Tokko asks Prava for a fresh single-use card credential and presents it only for Zepto’s secure payment page.</p>}
                  {savedCard && onlineAvailable && !activeMandate && <p className="checkout-note">Create and approve a Prava mandate before using the saved card for Zepto. The mandate lets Prava mint a merchant- and amount-scoped credential without another OTP or CVV prompt.</p>}
                  {onlineFailures > 0 && (
                    <div className="card-attempt-status" role="status">
                      <CircleAlert size={16} />
                      <span><strong>Card payment not received</strong>{onlineFailures} of 3 attempts failed</span>
                    </div>
                  )}
                </section>

                {checkoutPreview && (
                  <div className="checkout-confirmation">
                    <div className="checkout-confirmation-copy">
                      <strong>{checkoutPreview.sandbox ? 'Try this sandbox credential on Zepto' : `Confirm ${checkoutPreview.mode === 'online' ? 'online payment' : 'Cash on Delivery'}`}</strong>
                      <span>{checkoutPreview.amount} total · {checkoutPreview.sandbox ? 'Zepto will create an online-payment order. After three terminal failures, Tokko asks before COD.' : 'the complete breakdown is shown above payment methods.'}</span>
                    </div>
                    <button type="button" className="button primary-button" disabled={checkoutBusy || codPermissionRequired || (checkoutPreview.mode === 'online' && !coveringMandate)} onClick={confirmCheckout}>{checkoutBusy ? (checkoutPreview.sandbox ? 'Creating Zepto attempt…' : 'Placing order…') : (checkoutPreview.sandbox ? 'Try this sandbox credential on Zepto' : 'Confirm order')}</button>
                  </div>
                )}

                {onlineOrder && (
                  <div className="zepto-card-handoff">
                    <div className="zepto-card-handoff-heading">
                      <span><CreditCard size={18} /></span>
                      <div>
                        <strong>{onlineOrder.paymentHandoff?.sandbox ? 'Prava sandbox credential' : 'Continue with card on Zepto'}</strong>
                        <small>{onlineOrder.paymentHandoff?.card ? `${String(onlineOrder.paymentHandoff.card.brand || 'Card').toUpperCase()} •••• ${onlineOrder.paymentHandoff.card.last4}` : 'Selected saved card'}</small>
                      </div>
                    </div>
                    {onlineOrder.orderId && (
                      <div className="payment-attempt-summary" role="status">
                        <span><strong>Zepto order</strong><code>{onlineOrder.orderId}</code></span>
                        <span><strong>Current payment status</strong><b>{lastZeptoPaymentStatus || 'NOT CHECKED'}</b></span>
                      </div>
                    )}
                    {onlineOrder.paymentHandoff?.mode === 'prava_mandate' && onlineOrder.paymentHandoff.credentials && (
                      <div className="prava-payment-credential" role="group" aria-label="Single-use Prava card credential">
                        <p><BadgeCheck size={14} /> Prava issued this {onlineOrder.paymentHandoff.sandbox ? 'sandbox ' : ''}credential for {formatMandateAmount(onlineOrder.paymentHandoff.amount, onlineOrder.paymentHandoff.currency)} at Zepto. It is kept only in this browser tab.</p>
                        <div className="prava-token-explanation">
                          <strong>Actual payment token returned by Prava</strong>
                          <span><code>credentials.token</code> is a single-use virtual PAN, so it intentionally looks like a card number. It is not your saved card number.</span>
                          <small>Mandate: {onlineOrder.paymentHandoff.mandateId} · Transaction: {onlineOrder.paymentHandoff.transactionId}</small>
                        </div>
                        <label>
                          <span>Prava tokenized PAN (credentials.token)</span>
                          <span className="credential-copy-row">
                            <input readOnly value={onlineOrder.paymentHandoff.credentials.token} autoComplete="off" />
                            <button type="button" onClick={async () => { await navigator.clipboard.writeText(onlineOrder.paymentHandoff.credentials.token); setCheckoutStatus('Prava credentials.token copied.'); }}>Copy</button>
                          </span>
                        </label>
                        <div className="credential-detail-grid">
                          <label>
                            <span>Expiry</span>
                            <span className="credential-copy-row">
                              <input readOnly value={`${onlineOrder.paymentHandoff.credentials.expiryMonth}/${onlineOrder.paymentHandoff.credentials.expiryYear}`} autoComplete="off" />
                              <button type="button" onClick={async () => { await navigator.clipboard.writeText(`${onlineOrder.paymentHandoff.credentials.expiryMonth}/${onlineOrder.paymentHandoff.credentials.expiryYear}`); setCheckoutStatus('Prava expiry copied.'); }}>Copy</button>
                            </span>
                          </label>
                          <label>
                            <span>Dynamic CVV</span>
                            <span className="credential-copy-row">
                              <input readOnly value={onlineOrder.paymentHandoff.credentials.dynamicCvv} autoComplete="off" />
                              <button type="button" onClick={async () => { await navigator.clipboard.writeText(onlineOrder.paymentHandoff.credentials.dynamicCvv); setCheckoutStatus('Single-use Prava CVV copied.'); }}>Copy</button>
                            </span>
                          </label>
                        </div>
                        <small>{onlineOrder.paymentHandoff.sandbox ? 'Open the Zepto hosted payment page below, choose card, and enter these sandbox values. Return to Tokko to check the result.' : 'Open Zepto below, choose card, and enter these one-time values. Do not refresh Tokko until payment status is confirmed.'}</small>
                        {onlineOrder.paymentHandoff.automaticInsertion === false && onlineOrder.paymentLink && (
                          <p className="checkout-note"><CircleAlert size={14} /> Automatic insertion is unavailable for this Zepto link: Prava’s public Browser Harness requires a Shopify UCP checkout, while Zepto’s MCP exposes no credential field.</p>
                        )}
                      </div>
                    )}
                    <div className="online-payment-actions">
                      {onlineOrder.paymentLink && <a className="button primary-button" href={onlineOrder.paymentLink} target="_blank" rel="noreferrer"><ExternalLink size={16} /> Continue to Zepto card payment</a>}
                      {!onlineOrder.paymentLink && onlineOrder.orderId && <button type="button" className="button primary-button" disabled>Zepto payment link unavailable</button>}
                      {onlineOrder.orderId && <button type="button" className="button secondary-button" disabled={checkoutBusy} onClick={() => checkOnlinePaymentStatus()}><RefreshCw size={16} /> Check Zepto payment status</button>}
                    </div>
                    {!onlineOrder.paymentLink && onlineOrder.orderId && <p className="checkout-note"><CircleAlert size={14} /> Zepto created an order ID but did not return a hosted-payment URL. This cannot be completed or counted as one of the three Prava payment attempts.</p>}
                  </div>
                )}
                {pravaPaymentResult && (
                  <section className="prava-payment-result" aria-label="Prava payment result">
                    <div className="shop-checkout-heading checkout-heading-action">
                      <BadgeCheck size={18} />
                      <div><strong>Prava payment result</strong><span>Credential values are redacted from this diagnostic view</span></div>
                      <button type="button" disabled={checkoutBusy} onClick={refreshPravaPaymentResult}><RefreshCw size={13} /> Refresh</button>
                    </div>
                    <pre>{JSON.stringify(pravaPaymentResult, null, 2)}</pre>
                  </section>
                )}
                {checkoutStatus && <p className="checkout-status" role="status">{checkoutStatus}</p>}
              </div>
            )}
          </aside>
        </div>
      )}
      {addressFormOpen && (
        <div className="address-form-overlay" onMouseDown={() => !addressBusy && setAddressFormOpen(false)}>
          <section className="address-form-dialog" role="dialog" aria-modal="true" aria-labelledby="add-zepto-address-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="address-form-header">
              <div><p className="eyebrow">Connected Zepto account</p><h2 id="add-zepto-address-title">Add delivery address</h2><span>This will be saved to Zepto, not only in Tokko.</span></div>
              <button type="button" className="icon-button subtle" aria-label="Close address form" disabled={addressBusy} onClick={() => setAddressFormOpen(false)}><X size={19} /></button>
            </div>
            <form className="address-form-fields" onSubmit={saveAddressToZepto}>
              <div className="form-grid two-columns">
                <label className="field-group"><span>Address type</span><select value={addressForm.type} onChange={(event) => updateAddressForm('type', event.target.value)}><option value="HOME">Home</option><option value="WORK">Work</option><option value="OTHER">Other</option></select></label>
                <label className="field-group"><span>Address label</span><input required value={addressForm.name} onChange={(event) => updateAddressForm('name', event.target.value)} placeholder="Home, Office, Parents…" /></label>
                <label className="field-group"><span>Flat / House number</span><input required value={addressForm.flatDetails} onChange={(event) => updateAddressForm('flatDetails', event.target.value)} placeholder="Flat 4B or House 18" /></label>
                <label className="field-group"><span>Building / Society (optional)</span><input value={addressForm.buildingName} onChange={(event) => updateAddressForm('buildingName', event.target.value)} placeholder="Building or society name" /></label>
                <label className="field-group"><span>Floor (optional)</span><input value={addressForm.floor} onChange={(event) => updateAddressForm('floor', event.target.value)} placeholder="4" /></label>
                <label className="field-group"><span>Landmark (optional)</span><input value={addressForm.landmark} onChange={(event) => updateAddressForm('landmark', event.target.value)} placeholder="Near metro station" /></label>
                <label className="field-group address-wide-field"><span>Area, city, and state</span><input required value={addressForm.shortAddress} onChange={(event) => updateAddressForm('shortAddress', event.target.value)} placeholder="Park Street, Kolkata, West Bengal" /></label>
                <label className="field-group"><span>Delivery contact name</span><input required value={addressForm.contactName} onChange={(event) => updateAddressForm('contactName', event.target.value)} autoComplete="name" /></label>
                <div className="field-group">
                  <span>Delivery contact phone</span>
                  <div className="phone-input-row">
                    <select aria-label="Delivery contact country code" value={addressForm.contactCountryCode} onChange={(event) => updateAddressForm('contactCountryCode', event.target.value)}>
                      <option value="+91">IN +91</option>
                      <option value="+1">US/CA +1</option>
                      <option value="+44">UK +44</option>
                      <option value="+61">AU +61</option>
                      <option value="+65">SG +65</option>
                      <option value="+971">AE +971</option>
                    </select>
                    <input required aria-label="Delivery contact phone without country code" value={addressForm.contactLocalPhone} onChange={(event) => updateAddressForm('contactLocalPhone', event.target.value)} inputMode="tel" autoComplete="tel-national" placeholder="98765 43210" />
                  </div>
                </div>
                <label className="field-group"><span>Latitude (optional)</span><input value={addressForm.latitude} onChange={(event) => updateAddressForm('latitude', event.target.value)} inputMode="decimal" placeholder="22.5726" /></label>
                <label className="field-group"><span>Longitude (optional)</span><input value={addressForm.longitude} onChange={(event) => updateAddressForm('longitude', event.target.value)} inputMode="decimal" placeholder="88.3639" /></label>
              </div>
              <div className="address-location-note"><MapPin size={17} /><span>Coordinates are optional. If blank, Tokko estimates a pin from the area, city, and state. Use browser location only when you want a more precise pin. Area lookup © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>.</span><button type="button" disabled={locationBusy || addressBusy} onClick={captureBrowserLocation}>{locationBusy ? 'Requesting…' : 'Use browser location'}</button></div>
              {addressStatus && <p className={`form-message ${/failed|required|valid|does not support/i.test(addressStatus) ? 'error-message' : ''}`} role="status">{addressStatus}</p>}
              <div className="address-form-actions"><button type="button" className="button secondary-button" disabled={addressBusy} onClick={() => setAddressFormOpen(false)}>Cancel</button><button type="submit" className="button primary-button" disabled={addressBusy}><MapPin size={16} /> {addressBusy ? 'Saving to Zepto…' : 'Save to Zepto account'}</button></div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}

const SHOPPER_SUGGESTIONS = [
  {
    label: 'Daily wellness',
    detail: 'Compare live merchant prices',
    prompt: 'find daily wellness supplements',
    icon: Sparkles,
  },
  {
    label: 'Ashwagandha',
    detail: 'Live India and US health-and-wellness UCPs',
    prompt: 'find ashwagandha',
    icon: Search,
  },
  {
    label: 'Protein',
    detail: 'Lowest live price first',
    prompt: 'find plant protein',
    icon: RefreshCw,
  },
  {
    label: 'Hair care',
    detail: 'Browse matching variants',
    prompt: 'find hair care products',
    icon: ShoppingBag,
  },
];

const SHOPPER_LANGUAGES = [
  { locale: 'en-IN', label: 'English' },
  { locale: 'hi-IN', label: 'हिन्दी' },
  { locale: 'bn-IN', label: 'বাংলা' },
  { locale: 'ta-IN', label: 'தமிழ்' },
  { locale: 'te-IN', label: 'తెలుగు' },
  { locale: 'mr-IN', label: 'मराठी' },
  { locale: 'gu-IN', label: 'ગુજરાતી' },
  { locale: 'kn-IN', label: 'ಕನ್ನಡ' },
  { locale: 'ml-IN', label: 'മലയാളം' },
  { locale: 'pa-IN', label: 'ਪੰਜਾਬੀ' },
];

function blobAsBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The selected media could not be read.'));
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.readAsDataURL(blob);
  });
}

const HERMES_TOOL_LABELS = {
  create_wellness_checkout: 'creating merchant checkout',
  add_saved_address: 'saving address',
  check_payment_status: 'checking payment',
  checkout_current_cart: 'routing family payment',
  create_online_payment_order: 'creating online order',
  create_order: 'placing order',
  create_upi_reserve_pay_order: 'creating upi order',
  create_wallet_order: 'creating wallet order',
  get_location_serviceability: 'checking delivery area',
  get_order_detail: 'checking order',
  get_past_order_items: 'checking family favourites',
  get_payment_methods: 'checking payment options',
  get_product_details: 'checking product details',
  get_user_details: 'checking zepto account',
  empty_wellness_cart: 'emptying cart',
  list_order_history: 'checking recent orders',
  list_saved_addresses: 'checking saved addresses',
  search_multiple_products: 'searching zepto',
  search_products: 'searching zepto',
  search_wellness_merchants: 'comparing live UCP catalogues',
  remove_wellness_cart_item: 'removing cart item',
  select_prava_card: 'selecting saved Prava card',
  select_saved_address: 'selecting address',
  select_store: 'selecting store',
  start_zepto_reconnect: 'sending zepto otp',
  verify_zepto_reconnect: 'verifying zepto otp',
  update_cart: 'updating cart',
  update_drop_zone: 'updating delivery area',
  update_user_name: 'updating zepto account',
  view_cart: 'checking cart',
};

function hermesActivityLabel(tool) {
  const label = HERMES_TOOL_LABELS[tool.name]
    || String(tool.name || 'merchant action').replaceAll('_', ' ');
  if (tool.status === 'failed') return `${label} failed`;
  if (tool.status === 'blocked') return `${label} blocked`;
  return label;
}

function ShopperMessage({
  message,
  busy,
  onApprove,
  onContinuePayment,
  onDecline,
  onEmptyCart,
  onResolveCartCountryConflict,
  onOrderDecision,
  onRemoveCartItem,
  onSelectOrderPayment,
  onReconnectZepto,
  onSelectPaymentCard,
  onSelectProduct,
  onShowMoreProducts,
  onSpeak,
  speaking,
}) {
  const assistant = message.role === 'assistant';
  const reconnectZepto = assistant && (message.tools || []).some((tool) =>
    ['search_products', 'search_multiple_products'].includes(tool.name)
    && tool.status === 'failed'
    && /429|too many requests|rate.?limit/i.test(String(tool.error || ''))
  );
  return (
    <article className={`shopper-message ${assistant ? 'assistant' : 'user'}`}>
      <div className="shopper-message-content">
        <div className="shopper-message-bubble">
          {message.pending && (
            <span className="shopper-thinking" aria-label="Tokko is thinking">
              <i /><i /><i />
            </span>
          )}
          {!message.pending && String(message.content || '').split('\n').map((line, index) => (
            <p key={`${message.id}-line-${index}`}>{line || '\u00a0'}</p>
          ))}
        </div>
        {assistant && !message.pending && message.content && (
          <button
            type="button"
            className={`shopper-speech-button ${speaking ? 'active' : ''}`}
            aria-label={speaking ? 'Stop reading response' : 'Read response aloud'}
            onClick={() => onSpeak(message)}
          >
            {speaking ? <VolumeX size={13} /> : <Volume2 size={13} />}
            {speaking ? 'stop voice' : 'read aloud'}
          </button>
        )}
        {!!message.tools?.length && (
          <div className="shopper-tool-activity" aria-label="Merchant activity">
            {message.tools.map((tool, index) => (
              <span className={tool.status === 'failed' ? 'failed' : ''} key={`${message.id}-${tool.name}-${index}`}>
                {tool.status === 'failed' ? <CircleAlert size={12} /> : <CheckCircle2 size={12} />}
                {hermesActivityLabel(tool)}
              </span>
            ))}
          </div>
        )}
        {message.cartCountryConflict && (
          <section className="shopper-country-conflict" aria-label="Cart delivery country conflict">
            <div>
              <CircleAlert size={18} />
              <span>
                <strong>Cart does not match this delivery country</strong>
                <small>
                  Current cart: {message.cartCountryConflict.cartCountry || 'another country'}
                  {' · '}Selected address: {message.cartCountryConflict.targetCountry || 'new country'}
                </small>
              </span>
            </div>
            <p>Clear the incompatible cart and Tokko will automatically retry your original search for this address.</p>
            <div className="shopper-country-conflict-actions">
              <button
                type="button"
                className="button primary-button compact-button"
                disabled={busy}
                onClick={() => onResolveCartCountryConflict(message, true)}
              >
                Clear Cart & Retry
              </button>
              <button
                type="button"
                className="button secondary-button compact-button"
                disabled={busy}
                onClick={() => onResolveCartCountryConflict(message, false)}
              >
                Keep Current Cart
              </button>
            </div>
          </section>
        )}
        {!!message.productChoices?.length && (
          <section className="ucp-product-results" aria-label="UCP product choices">
            <div className="ucp-product-results-heading">
              <div>
                <strong>Live merchant matches</strong>
                <span>India and US delivery results, grouped by currency and price</span>
              </div>
              <span>{message.productChoices.filter((product) => product.available).length} available</span>
            </div>
            <div className="ucp-product-grid">
              {message.productChoices.map((product, index) => (
                <article className={`ucp-product-card ${!product.available ? 'unavailable' : ''}`} key={`${product.selectionToken}-${index}`}>
                  <div className="ucp-product-image">
                    {product.imageUrl
                      ? <img src={product.imageUrl} alt="" loading="lazy" />
                      : <ShoppingBag size={24} />}
                  </div>
                  <div className="ucp-product-copy">
                    {product.searchQuery && <small>For: {product.searchQuery}</small>}
                    <small>{product.merchantName}{product.market ? ` · ${product.market}` : ''}</small>
                    <strong>{product.productName}</strong>
                    <span>{product.optionText || product.variantName}</span>
                    <b>{formatMandateAmount(product.price, product.currency)}</b>
                  </div>
                  <button
                    type="button"
                    className="button primary-button compact-button"
                    disabled={busy || !product.available}
                    onClick={() => onSelectProduct(product)}
                  >
                    {product.available ? 'Add & review price' : 'Unavailable'}
                  </button>
                </article>
              ))}
            </div>
            {message.productPagination?.hasMore && (
              <button
                type="button"
                className="button secondary-button ucp-show-more-button"
                disabled={busy}
                onClick={() => onShowMoreProducts(message)}
              >
                Show 10 more <ArrowRight size={14} />
              </button>
            )}
          </section>
        )}
        {message.cartSummary && (
          <section className="shopper-cart-summary" aria-label="Current wellness cart">
            <div className="shopper-cart-summary-heading">
              <ShoppingCart size={17} />
              <div>
                <span>Current Cart</span>
                <strong>{message.cartSummary.itemCount || 0} item{Number(message.cartSummary.itemCount || 0) === 1 ? '' : 's'}</strong>
              </div>
            </div>
            {!!message.cartSummary.items?.length ? (
              <div className="shopper-cart-summary-items">
                {message.cartSummary.items.map((item, index) => (
                  <div key={item.id || `cart-item-${index}`}>
                    <div>
                      <strong>{item.productName || 'Product'}</strong>
                      <small>{item.variantName || item.merchantName || ''} · quantity {item.quantity || 1}</small>
                    </div>
                    <button type="button" disabled={busy || !item.id} onClick={() => onRemoveCartItem(message, item)}>
                      <X size={13} /> Remove
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <small>Your cart is empty.</small>
            )}
            {!!message.cartSummary.items?.length && (
              <button type="button" className="button secondary-button compact-button" disabled={busy} onClick={() => onEmptyCart(message)}>
                Empty Cart
              </button>
            )}
          </section>
        )}
        {!!message.prescriptionReviewItems?.length && (
          <section className="shopper-approval-card" aria-label="Prescription review items">
            <div className="shopper-approval-icon"><ShieldCheck size={18} /></div>
            <div>
              <span>Prescription Review</span>
              <strong>{message.prescriptionReviewItems.map((item) => item.name).join(', ')}</strong>
              <small>Checkout is blocked until a licensed pharmacy verifies the prescription.</small>
            </div>
          </section>
        )}
        {reconnectZepto && (
          <button
            type="button"
            className="shopper-reconnect-action"
            disabled={busy}
            onClick={onReconnectZepto}
          >
            <RefreshCw size={13} /> Reconnect Zepto with OTP
          </button>
        )}
        {!!message.cardChoices?.length && (
          <section className="shopper-card-choice-list" aria-label="Choose a saved Prava card">
            <div>
              <CreditCard size={18} />
              <div>
                <span>Mandate does not cover this total</span>
                <strong>Choose a saved Prava card</strong>
              </div>
            </div>
            <div className="shopper-card-choice-buttons">
              {message.cardChoices.map((card) => (
                <button
                  type="button"
                  className="shopper-card-choice-button"
                  disabled={busy}
                  key={card.id}
                  onClick={() => onSelectPaymentCard(message, card)}
                >
                  <span>{card.brand}</span>
                  <strong>•••• {card.last4}</strong>
                  {card.isDefault && <small>Default</small>}
                </button>
              ))}
            </div>
          </section>
        )}
        {!!message.checkoutSummary?.totals?.length && (
          <section className="shopper-checkout-breakdown" aria-label="Merchant checkout total">
            <div className="shopper-checkout-breakdown-heading">
              <ReceiptText size={17} />
              <div>
                <span>Merchant quote</span>
                <strong>Cart and shipping total</strong>
              </div>
            </div>
            <div className="shopper-checkout-lines">
              {message.checkoutSummary.totals.map((line, index) => (
                <React.Fragment key={`${line.type}-${index}`}>
                  <div className={line.type === 'total' ? 'is-total' : ''}>
                    <span>{line.label}</span>
                    <strong>{formatMandateAmount(Number(line.amountMinor || 0) / 100, message.checkoutSummary.currency)}</strong>
                  </div>
                  {(line.lines || []).map((detail, detailIndex) => (
                    <div className="is-detail" key={`${line.type}-${index}-${detailIndex}`}>
                      <span>{detail.label}</span>
                      <strong>{formatMandateAmount(Number(detail.amountMinor || 0) / 100, message.checkoutSummary.currency)}</strong>
                    </div>
                  ))}
                </React.Fragment>
              ))}
            </div>
            <small>
              {message.checkoutSummary.shippingQuoted
                ? 'Shipping is included exactly as quoted by the merchant UCP.'
                : 'The merchant did not return a shipping charge. Tokko will not invent one.'}
            </small>
            {message.checkoutSummary.deliveryWindow && (
              <small>
                Delivery: {[
                  message.checkoutSummary.deliveryWindow.description,
                  message.checkoutSummary.deliveryWindow.earliest,
                  message.checkoutSummary.deliveryWindow.latest,
                ].filter(Boolean).join(' to ') || 'period not returned by merchant'}
              </small>
            )}
            <small>
              {message.checkoutSummary.forex?.appliedByTokko
                ? `${message.checkoutSummary.forex.ratePercent || 3}% forex charge is calculated on the complete merchant cart value of ${formatMandateAmount(Number(message.checkoutSummary.forex.baseAmountMinor || 0) / 100, message.checkoutSummary.currency)}. Mandate coverage uses the final total payable.`
                : message.checkoutSummary.forex?.returnedByMerchant
                  ? 'Foreign-exchange charges returned by the merchant are included above.'
                  : 'No separate foreign-exchange charge was returned by the merchant. Your card network may apply one later.'}
            </small>
            {message.checkoutSummary.confirmationRequired && (
              <div className="shopper-approval-actions">
                <button type="button" className="button secondary-button compact-button" disabled={busy} onClick={() => onOrderDecision(message, false)}>Do Not Place Order</button>
                <button type="button" className="button primary-button compact-button" disabled={busy} onClick={() => onOrderDecision(message, true)}><Check size={14} /> Proceed With Order</button>
              </div>
            )}
          </section>
        )}
        {message.paymentDecision && (
          <section className="shopper-card-choice-list" aria-label="Choose Prava payment flow">
            <div>
              <ShieldCheck size={18} />
              <div><span>Price confirmed</span><strong>Choose a payment category</strong></div>
            </div>
            <div className="shopper-payment-categories">
              <details>
                <summary>
                  <ShieldCheck size={16} />
                  <span><strong>Mandates</strong><small>{message.paymentDecision.recommendedMandate ? 'An active mandate covers the full cart' : 'No active mandate currently covers the full cart'}</small></span>
                  <ArrowRight size={14} />
                </summary>
                <div className="shopper-card-choice-buttons">
                  {message.paymentDecision.recommendedMandate && (
                    <button type="button" className="shopper-card-choice-button" disabled={busy} onClick={() => onSelectOrderPayment(message, { method: 'mandate' })}>
                      <span>Use Active Mandate</span>
                      <strong>{message.paymentDecision.recommendedMandate.currency} {message.paymentDecision.recommendedMandate.remaining || message.paymentDecision.recommendedMandate.approvedAmount}</strong>
                      <small>Smallest active mandate covering the cart</small>
                    </button>
                  )}
                  <button type="button" className="shopper-card-choice-button" disabled={busy || !message.paymentDecision.savedCards?.length} onClick={() => onSelectOrderPayment(message, { method: 'create_mandate', paymentMethodId: message.paymentDecision.savedCards?.find((card) => card.isDefault)?.id || message.paymentDecision.savedCards?.[0]?.id })}>
                    <span>Create Mandate</span><strong>Authorize this cart limit</strong><small>{message.paymentDecision.savedCards?.length ? 'Backed by your default saved card' : 'Save a card first'}</small>
                  </button>
                </div>
              </details>
              <details>
                <summary>
                  <CreditCard size={16} />
                  <span><strong>Saved Cards</strong><small>{message.paymentDecision.savedCards?.length ? `${message.paymentDecision.savedCards.length} saved card${message.paymentDecision.savedCards.length === 1 ? '' : 's'} available` : 'No saved cards yet'}</small></span>
                  <ArrowRight size={14} />
                </summary>
                <div className="shopper-card-choice-buttons">
                  {(message.paymentDecision.savedCards || []).map((card) => (
                    <button type="button" className="shopper-card-choice-button" disabled={busy} key={card.id} onClick={() => onSelectOrderPayment(message, { method: 'card', paymentMethodId: card.id })}>
                      <span>{card.isDefault ? 'Default Card' : `Saved ${card.brand}`}</span><strong>•••• {card.last4}</strong><small>Prava hosted approval, then payment result</small>
                    </button>
                  ))}
                  <button type="button" className="shopper-card-choice-button" disabled={busy} onClick={() => onSelectOrderPayment(message, { method: 'add_card' })}>
                    <span>Save New Card</span><strong>Add with Prava</strong><small>Secure hosted setup</small>
                  </button>
                </div>
              </details>
            </div>
          </section>
        )}
        {message.nextAction?.url && (
          <section className="shopper-payment-action" aria-label="Payment action">
            <div>
              <CreditCard size={18} />
              <div>
                <span>{message.nextAction.type === 'merchant_ucp_checkout' ? 'Merchant Checkout' : 'Secure Payment Step'}</span>
                <strong>{message.nextAction.label || 'Continue Payment'}</strong>
              </div>
            </div>
            {message.nextAction.paymentSelection?.selected && (
              <div className="shopper-payment-choice">
                <span>Tokko selected</span>
                <strong>
                  {message.nextAction.paymentSelection.displayLabel
                    || (message.nextAction.paymentSelection.route === 'mandate'
                      ? 'Active Prava mandate'
                      : 'Saved Prava card')}
                </strong>
                <small>
                  {message.nextAction.paymentSelection.merchantInstrumentSelected
                    ? 'Selected in the merchant checkout.'
                    : 'The merchant may still ask you to confirm this payment method.'}
                </small>
              </div>
            )}
            {message.nextAction.paymentHandoff?.credentials && (
              <div className="shopper-payment-credential">
                <span>Virtual Card</span>
                <code>{message.nextAction.paymentHandoff.credentials.token}</code>
                <span>Expiry</span>
                <code>{message.nextAction.paymentHandoff.credentials.expiryMonth}/{message.nextAction.paymentHandoff.credentials.expiryYear}</code>
                <span>Dynamic CVV</span>
                <code>{message.nextAction.paymentHandoff.credentials.dynamicCvv}</code>
              </div>
            )}
            <a
              className="button primary-button compact-button"
              href={message.nextAction.url}
              target={['prava_card_approval', 'prava_mandate_approval'].includes(message.nextAction.type) ? '_self' : '_blank'}
              rel={['prava_card_approval', 'prava_mandate_approval'].includes(message.nextAction.type) ? undefined : 'noreferrer'}
            >
              <ExternalLink size={14} /> {message.nextAction.label || 'Continue Payment'}
            </a>
            {message.nextAction.type === 'merchant_ucp_checkout' && (
              <a className="shopper-payment-link-text" href={message.nextAction.url} target="_blank" rel="noreferrer">
                {message.nextAction.url}
              </a>
            )}
            {['prava_card_approval', 'prava_mandate_approval'].includes(message.nextAction.type) && (
              <button
                type="button"
                className="button secondary-button compact-button"
                disabled={busy}
                onClick={() => onContinuePayment(message)}
              >
                <CheckCircle2 size={14} /> I Approved, Continue
              </button>
            )}
          </section>
        )}
        {message.sandboxPaymentCredential?.token && (
          <section className="shopper-payment-credential sandbox-token" aria-label="Prava sandbox payment token">
            <span>
              {message.sandboxPaymentCredential.sessionId
                ? 'Prava Sandbox Saved-Card Token'
                : 'Prava Sandbox Mandate Charge Token'}
            </span>
            <code>{message.sandboxPaymentCredential.token}</code>
            <small>
              transaction {message.sandboxPaymentCredential.transactionId || 'pending'}
              {message.sandboxPaymentCredential.mandateId
                ? ` · mandate ${message.sandboxPaymentCredential.mandateId}`
                : message.sandboxPaymentCredential.sessionId
                  ? ` · session ${message.sandboxPaymentCredential.sessionId}`
                  : ''}
            </small>
            <small>
              This temporary virtual PAN came directly from Prava’s
              {message.sandboxPaymentCredential.sessionId
                ? ' payment-result API'
                : ' mandate Charge API'} and is not stored by Tokko.
            </small>
          </section>
        )}
        {message.pendingAction && (
          <section className="shopper-approval-card" aria-label="Action confirmation">
            <div className="shopper-approval-icon"><ShieldCheck size={18} /></div>
            <div>
              <span>Ready for your approval</span>
              <strong>{message.pendingAction.description}</strong>
              <small>This one-time approval expires in 10 min.</small>
            </div>
            <div className="shopper-approval-actions">
              <button type="button" className="button secondary-button compact-button" disabled={busy} onClick={() => onDecline(message)}>No, leave it</button>
              <button type="button" className="button primary-button compact-button" disabled={busy} onClick={() => onApprove(message)}><Check size={14} /> Yes, approve</button>
            </div>
          </section>
        )}
      </div>
    </article>
  );
}

function ShopperPage({
  setup,
  onZeptoReconnected,
  pravaMandateCallback,
  pravaCardCallback,
}) {
  const initialContactPhone = phoneParts(setup.profile.phone);
  const [messages, setMessages] = useState(() => {
    const saved = readShopperSession(SHOPPER_SESSION_MESSAGES_KEY, []);
    return Array.isArray(saved) && saved.length ? saved : [{
      id: 'tokko-welcome',
      role: 'assistant',
      content: 'before we shop, choose the delivery address for this session.',
    }];
  });
  const [addresses, setAddresses] = useState([]);
  const [addressesBusy, setAddressesBusy] = useState(false);
  const [selectedAddress, setSelectedAddress] = useState(() => String(
    readShopperSession(SHOPPER_SESSION_ADDRESS_KEY, '') || ''
  ));
  const [addressChooserOpen, setAddressChooserOpen] = useState(() => !String(
    readShopperSession(SHOPPER_SESSION_ADDRESS_KEY, '') || ''
  ));
  const [addressSelectingId, setAddressSelectingId] = useState('');
  const [addressFormOpen, setAddressFormOpen] = useState(false);
  const [addressBusy, setAddressBusy] = useState(false);
  const [addressStatus, setAddressStatus] = useState('');
  const [addressForm, setAddressForm] = useState({
    type: 'HOME',
    name: 'Home',
    countryCode: String(setup.deliveryPreference?.countryCode || 'IN').toUpperCase(),
    flatDetails: '',
    buildingName: '',
    floor: '',
    landmark: '',
    shortAddress: '',
    contactName: setup.profile.name || '',
    contactCountryCode: initialContactPhone.countryCode,
    contactLocalPhone: initialContactPhone.localPhone,
  });
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [speechLanguage, setSpeechLanguage] = usePersistentState('tokko-shopper-language', 'en-IN');
  const [autoSpeak, setAutoSpeak] = usePersistentState('tokko-shopper-auto-speak', false);
  const [speakingId, setSpeakingId] = useState('');
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const endRef = useRef(null);
  const speechRecognitionRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const microphoneStreamRef = useRef(null);
  const recordingTimerRef = useRef(null);
  const voiceMountedRef = useRef(true);
  const mediaInputRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages, busy]);

  useEffect(() => {
    try {
      sessionStorage.setItem(
        SHOPPER_SESSION_MESSAGES_KEY,
        JSON.stringify(safeShopperSessionMessages(messages))
      );
    } catch {
      // Session persistence is best-effort when browser storage is unavailable.
    }
  }, [messages]);

  useEffect(() => {
    if (!pravaMandateCallback) return;
    const messageId = `prava-mandate-callback-${pravaMandateCallback.callbackId || 'latest'}`;
    setMessages((current) => {
      if (current.some((message) => message.id === messageId)) return current;
      if (pravaMandateCallback.error) {
        return [...current, {
          id: messageId,
          role: 'assistant',
          content: `prava returned from mandate approval, but the charge credential is not ready yet: ${pravaMandateCallback.error}`,
        }];
      }
      return [...current, {
        id: messageId,
        role: 'assistant',
        content:
          `prava approved the mandate. i called the mandate charge api for ${pravaMandateCallback.currency} ${pravaMandateCallback.chargeAmount} and received this single-use sandbox token.`,
        sandboxPaymentCredential:
          pravaMandateCallback.sandboxPaymentCredential || null,
      }];
    });
  }, [pravaMandateCallback?.callbackId, pravaMandateCallback?.status, pravaMandateCallback?.error]);

  useEffect(() => {
    if (!pravaCardCallback) return;
    const messageId = `prava-card-callback-${pravaCardCallback.orderId || 'latest'}`;
    setMessages((current) => {
      if (current.some((message) => message.id === messageId)) return current;
      if (pravaCardCallback.error) {
        return [...current, {
          id: messageId,
          role: 'assistant',
          content: `prava returned from saved-card approval, but the payment result is not ready: ${pravaCardCallback.error}`,
        }];
      }
      if (!pravaCardCallback.tokenIssued) {
        return [...current, {
          id: messageId,
          role: 'assistant',
          content: `prava payment result is still ${pravaCardCallback.pravaStatus || 'pending'}. retry continue payment in a moment.`,
        }];
      }
      return [...current, {
        id: messageId,
        role: 'assistant',
        content: pravaCardCallback.sandboxPaymentCredential?.token
          ? 'prava approved the saved-card payment. the payment-result api returned this single-use sandbox token.'
          : 'prava approved the saved-card payment and issued a one-time credential. tokko stored only its fingerprint.',
        sandboxPaymentCredential:
          pravaCardCallback.sandboxPaymentCredential || null,
      }];
    });
  }, [pravaCardCallback?.orderId, pravaCardCallback?.tokenIssued, pravaCardCallback?.error]);

  useEffect(() => {
    try {
      if (selectedAddress) {
        sessionStorage.setItem(SHOPPER_SESSION_ADDRESS_KEY, selectedAddress);
      } else {
        sessionStorage.removeItem(SHOPPER_SESSION_ADDRESS_KEY);
      }
    } catch {
      // Session persistence is best-effort when browser storage is unavailable.
    }
  }, [selectedAddress]);

  const loadShopperAddresses = async ({ preserveSelection = false } = {}) => {
    setAddressesBusy(true);
    setAddressStatus('Loading saved addresses from Tokko…');
    try {
      const result = await api('/api/addresses');
      const nextAddresses = parseAddressResponse(result);
      setAddresses(nextAddresses);
      const retained = preserveSelection
        && nextAddresses.find((address) =>
          String(address.id || '') === String(selectedAddress || '')
        );
      setSelectedAddress(retained ? String(retained.id) : '');
      setAddressChooserOpen(!retained);
      setAddressStatus(
        retained
          ? `${retained.label || 'Delivery address'} restored for this browser session.`
          : nextAddresses.length
          ? 'Choose one address before asking Tokko to shop.'
          : 'No saved Tokko addresses were returned. Add one below.'
      );
    } catch (error) {
      setAddressStatus(`Could not load Tokko addresses: ${error.message}`);
    } finally {
      setAddressesBusy(false);
    }
  };

  useEffect(() => {
    loadShopperAddresses({ preserveSelection: true });
  }, []);

  useEffect(() => {
    voiceMountedRef.current = true;
    return () => {
      voiceMountedRef.current = false;
      window.speechSynthesis?.cancel();
      speechRecognitionRef.current?.abort?.();
      if (recordingTimerRef.current) window.clearTimeout(recordingTimerRef.current);
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      microphoneStreamRef.current?.getTracks?.().forEach((track) => track.stop());
    };
  }, []);

  const selectShopperAddress = async (address) => {
    const addressId = String(address?.id || '').trim();
    if (!addressId || addressSelectingId || busy) return;
    setAddressSelectingId(addressId);
    setAddressStatus(`Selecting ${address.label || 'this address'}…`);
    try {
      let result;
      try {
        result = await api('/api/addresses/select', {
          method: 'POST',
          body: { addressId },
        });
      } catch (error) {
        if (error.details?.code !== 'cart_delivery_country_conflict') throw error;
        const conflict = error.details.conflict || {};
        const replace = window.confirm(
          `Your current cart is for ${conflict.cartCountry || 'another country'}, while this address is in ${conflict.targetCountry || 'a different country'}.\n\nClear the current cart and switch delivery address?`
        );
        if (!replace) {
          setAddressStatus('Kept your current cart and delivery address unchanged.');
          return;
        }
        result = await api('/api/addresses/select', {
          method: 'POST',
          body: { addressId, replaceCart: true },
        });
      }
      setSelectedAddress(addressId);
      setAddressChooserOpen(false);
      setAddressStatus(
        result.cartCleared
          ? `${address.label || 'Delivery address'} selected and the incompatible cart was cleared.`
          : `${address.label || 'Delivery address'} selected. Tokko is ready to shop.`
      );
      const readable = address.formattedAddress || address.shortAddress || address.label || 'selected address';
      setMessages((current) => [
        ...current,
        {
          id: `tokko-address-${Date.now()}`,
          role: 'assistant',
          content: `delivery address confirmed: ${readable}${result.cartCleared ? '\n\nthe previous country’s cart was cleared.' : ''}\n\nask me anything for shopping.`,
        },
      ]);
    } catch (error) {
      setAddressStatus(`Could not select this Tokko address: ${error.message}`);
    } finally {
      setAddressSelectingId('');
    }
  };

  const confirmedAddress = addresses.find(
    (address) => String(address.id || '') === selectedAddress
  ) || (String(setup.deliveryPreference?.addressId || '') === selectedAddress
    ? setup.deliveryPreference
    : null);
  const deliveryCountryIsPreset = DELIVERY_COUNTRY_OPTIONS.some(
    (country) => country.code === addressForm.countryCode
  );
  const contactCountryCodeIsPreset = PHONE_COUNTRY_CODE_OPTIONS.some(
    (country) => country.code === addressForm.contactCountryCode
  );

  const updateShopperAddressForm = (key, value) => {
    setAddressForm((current) => ({ ...current, [key]: value }));
  };

  const saveShopperAddress = async (event) => {
    event.preventDefault();
    const countryCode = String(addressForm.countryCode || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(countryCode)) {
      setAddressStatus('Enter the delivery country as a two-letter code, for example IN, US, GB, or AE.');
      return;
    }
    const contactCountryCode = `+${String(
      addressForm.contactCountryCode || ''
    ).replace(/\D/g, '')}`;
    const localPhone = normalizeLocalPhone(
      contactCountryCode,
      addressForm.contactLocalPhone
    );
    const contactNumber = toE164(contactCountryCode, localPhone);
    if (!/^\+[1-9]\d{7,14}$/.test(contactNumber)) {
      setAddressStatus('Enter a valid international delivery phone using its country calling code.');
      return;
    }
    setAddressBusy(true);
    setAddressStatus('Saving the address to Tokko…');
    try {
      const previousIds = new Set(addresses.map((address) => address.id).filter(Boolean));
      const saved = await api('/api/addresses', {
        method: 'POST',
        body: {
          type: addressForm.type,
          name: addressForm.name.trim(),
          countryCode,
          flatDetails: addressForm.flatDetails.trim(),
          buildingName: addressForm.buildingName.trim(),
          floor: addressForm.floor.trim(),
          landmark: addressForm.landmark.trim(),
          shortAddress: addressForm.shortAddress.trim(),
          contactName: addressForm.contactName.trim(),
          contactNumber,
        },
      });
      let nextAddresses = parseAddressResponse(saved);
      if (saved.savedAddressId && nextAddresses.length) {
        nextAddresses = [
          ...addresses.filter((address) =>
            String(address.id || '') !== String(saved.savedAddressId)
          ),
          ...nextAddresses,
        ];
      }
      if (!nextAddresses.length) {
        nextAddresses = parseAddressResponse(await api('/api/addresses'));
      }
      setAddresses(nextAddresses);
      const added = nextAddresses.find((address) =>
        address.id && !previousIds.has(address.id)
      ) || [...nextAddresses].reverse().find((address) =>
        address.id
        && String(address.label || '').toLowerCase()
          === addressForm.name.trim().toLowerCase()
      );
      setAddressFormOpen(false);
      setAddressForm((current) => ({
        ...current,
        name: current.type === 'HOME' ? 'Home' : current.type === 'WORK' ? 'Work' : '',
        flatDetails: '',
        buildingName: '',
        floor: '',
        landmark: '',
        shortAddress: '',
      }));
      if (added?.id) {
        await selectShopperAddress(added);
      } else {
        setAddressStatus(
          'Address saved to Tokko. Refresh the list if it does not appear immediately.'
        );
      }
    } catch (error) {
      setAddressStatus(`Could not save the Tokko address: ${error.message}`);
    } finally {
      setAddressBusy(false);
    }
  };

  const conversationMessages = (values) => values
    .filter((message) => !message.pending && message.content)
    .map(({ role, content }) => ({ role, content }));

  const speakText = (text, id) => {
    if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
      setStatus('Text to speech is not supported by this browser.');
      return;
    }
    if (speakingId === id) {
      window.speechSynthesis.cancel();
      setSpeakingId('');
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(String(text || ''));
    utterance.lang = speechLanguage;
    utterance.rate = 0.96;
    const localePrefix = speechLanguage.split('-')[0].toLowerCase();
    const voice = window.speechSynthesis.getVoices().find((candidate) => (
      candidate.lang?.toLowerCase() === speechLanguage.toLowerCase()
    )) || window.speechSynthesis.getVoices().find((candidate) => (
      candidate.lang?.toLowerCase().startsWith(`${localePrefix}-`)
    ));
    if (voice) utterance.voice = voice;
    utterance.onend = () => setSpeakingId('');
    utterance.onerror = () => setSpeakingId('');
    setSpeakingId(id);
    window.speechSynthesis.speak(utterance);
  };

  const startBrowserSpeechRecognition = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setStatus('Voice commands are not supported by this browser. Use Chrome, Edge, or Safari.');
      return;
    }
    window.speechSynthesis?.cancel();
    setSpeakingId('');
    const recognition = new SpeechRecognition();
    const startingDraft = draft.trim();
    recognition.lang = speechLanguage;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      setListening(true);
      setStatus('Listening for your voice command…');
    };
    recognition.onresult = (event) => {
      let transcript = '';
      let hasFinalResult = false;
      for (let index = 0; index < event.results.length; index += 1) {
        transcript += event.results[index][0]?.transcript || '';
        hasFinalResult ||= event.results[index].isFinal;
      }
      const nextDraft = [startingDraft, transcript.trim()].filter(Boolean).join(' ');
      setDraft(nextDraft.slice(0, 6_000));
      if (hasFinalResult) {
        setStatus('Voice command captured. Review it, then press send.');
      }
    };
    recognition.onerror = (event) => {
      const messages = {
        'not-allowed': 'Microphone access was denied. Allow microphone access for this site and retry.',
        'audio-capture': 'No microphone was found on this device.',
        'no-speech': 'I did not hear anything. Tap the microphone and try again.',
        network: 'The browser speech service is offline. Check your connection and retry.',
      };
      setStatus(messages[event.error] || `Voice command failed: ${event.error || 'unknown error'}`);
      setListening(false);
    };
    recognition.onend = () => {
      setListening(false);
      speechRecognitionRef.current = null;
    };
    speechRecognitionRef.current = recognition;
    try {
      recognition.start();
    } catch (error) {
      setListening(false);
      speechRecognitionRef.current = null;
      setStatus(`Voice command could not start: ${error.message}`);
    }
  };

  const startRecordedVoiceCommand = async () => {
    const startingDraft = draft.trim();
    let stream;
    try {
      setStatus('Opening the microphone…');
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      microphoneStreamRef.current = stream;
      const mimeCandidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/mp4',
      ];
      const mimeType = mimeCandidates.find((candidate) =>
        typeof MediaRecorder.isTypeSupported !== 'function'
        || MediaRecorder.isTypeSupported(candidate)
      );
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      const chunks = [];
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunks.push(event.data);
      };
      recorder.onerror = (event) => {
        if (!voiceMountedRef.current) return;
        setListening(false);
        setStatus(
          event.error?.message
          || 'The microphone recording stopped unexpectedly. Please retry.'
        );
      };
      recorder.onstop = async () => {
        if (recordingTimerRef.current) {
          window.clearTimeout(recordingTimerRef.current);
          recordingTimerRef.current = null;
        }
        stream.getTracks().forEach((track) => track.stop());
        microphoneStreamRef.current = null;
        mediaRecorderRef.current = null;
        if (!voiceMountedRef.current) return;
        setListening(false);
        const audio = new Blob(chunks, {
          type: recorder.mimeType || mimeType || 'audio/webm',
        });
        if (audio.size < 32) {
          setStatus('I did not hear anything. Tap the microphone and try again.');
          return;
        }
        setTranscribing(true);
        setStatus('Turning your voice into a shopping request…');
        try {
          const result = await api('/api/hermes/transcribe', {
            method: 'POST',
            body: {
              audioBase64: await blobAsBase64(audio),
              mimeType: audio.type.split(';')[0],
              language: speechLanguage,
            },
          });
          const nextDraft = [startingDraft, result.transcript]
            .filter(Boolean)
            .join(' ')
            .slice(0, 6_000);
          setDraft(nextDraft);
          setStatus('Voice command captured. Review it, then press send.');
        } catch (error) {
          setStatus(`Voice command failed: ${error.message}`);
        } finally {
          setTranscribing(false);
        }
      };
      recorder.start(250);
      setListening(true);
      setStatus('Listening… tap the microphone again when you are done.');
      recordingTimerRef.current = window.setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, 15_000);
    } catch (error) {
      stream?.getTracks?.().forEach((track) => track.stop());
      microphoneStreamRef.current = null;
      mediaRecorderRef.current = null;
      setListening(false);
      const denied = /denied|notallowed|permission/i.test(
        `${error.name || ''} ${error.message || ''}`
      );
      setStatus(
        denied
          ? 'Microphone access was denied. Allow microphone access for this site and retry.'
          : `Voice command could not start: ${error.message || 'microphone unavailable'}`
      );
    }
  };

  const toggleVoiceCommand = async () => {
    if (listening) {
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop();
      } else {
        speechRecognitionRef.current?.stop?.();
        setListening(false);
      }
      return;
    }
    if (transcribing) return;
    window.speechSynthesis?.cancel();
    setSpeakingId('');
    if (
      navigator.mediaDevices?.getUserMedia
      && typeof window.MediaRecorder !== 'undefined'
    ) {
      await startRecordedVoiceCommand();
      return;
    }
    startBrowserSpeechRecognition();
  };

  const appendHermesResult = (result, waitingId) => {
    setMessages((current) => current.map((message) => (
      message.id === waitingId
        ? {
            id: waitingId,
            role: 'assistant',
            content: result.message,
            tools: result.tools || [],
            pendingAction: result.pendingAction || null,
            nextAction: result.nextAction || null,
            productChoices: result.productChoices || [],
            merchantStatuses: result.merchantStatuses || [],
            productQuery: result.productQuery || null,
            productPagination: result.productPagination || null,
            productGroups: result.productGroups || [],
            prescriptionReviewItems: result.prescriptionReviewItems || [],
            cardChoices: result.cardChoices || [],
            checkoutSummary: result.checkoutSummary || null,
            paymentDecision: result.paymentDecision || null,
            cartSummary: result.cartSummary || null,
            cartCountryConflict: result.cartCountryConflict || null,
            sandboxPaymentCredential: result.sandboxPaymentCredential || null,
            paymentLink: result.paymentLink || null,
          }
        : message
    )));
    if ((result.tools || []).some((tool) => (
      tool.name === 'verify_zepto_reconnect' && tool.status === 'completed'
    ))) {
      onZeptoReconnected?.();
    }
    if (autoSpeak && result.message) speakText(result.message, waitingId);
  };

  const requestHermesChat = (body) => api('/api/hermes/chat', {
    method: 'POST',
    body,
  });

  const sendMessage = async (supplied) => {
    const content = String(supplied ?? draft).trim();
    if (!content || busy) return;
    const command = content.toLowerCase().replace(/\s+/g, ' ');
    if (['/addresses', 'addresses', 'list addresses', 'show addresses'].includes(command)) {
      await loadShopperAddresses({ preserveSelection: true });
      setDraft('');
      return;
    }
    if (['/reselect', 'reselect', 'reselect address', 'change address'].includes(command)) {
      await loadShopperAddresses();
      setDraft('');
      return;
    }
    if (['/addaddress', 'add address', 'new address'].includes(command)) {
      setAddressStatus('Add the delivery address below.');
      setAddressFormOpen(true);
      setDraft('');
      return;
    }
    const cartManagementCommand = /^(?:\/cart|show (?:me )?(?:my )?cart|view (?:my )?cart|what(?:'s| is) in (?:my )?cart|my cart|\/emptycart|empty (?:my )?cart|clear (?:my )?cart|remove\b|delete\b|take\b)/i.test(command);
    if (!selectedAddress && !cartManagementCommand) {
      setAddressChooserOpen(true);
      setAddressStatus('Choose a delivery address before shopping.');
      return;
    }
    speechRecognitionRef.current?.stop?.();
    setListening(false);
    const userMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: content.slice(0, 6_000),
    };
    const waitingId = `tokko-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const requestMessages = [...messages, userMessage];
    setMessages([...requestMessages, {
      id: waitingId,
      role: 'assistant',
      content: '',
      pending: true,
    }]);
    setDraft('');
    setBusy(true);
    setStatus('');
    try {
      const result = await requestHermesChat({
        messages: conversationMessages(requestMessages),
        language: speechLanguage,
      });
      appendHermesResult(result, waitingId);
    } catch (error) {
      appendHermesResult({
        message: `i’m sorry, i could not finish that: ${error.message}`.toLowerCase(),
        tools: [],
      }, waitingId);
      setStatus(error.message);
    } finally {
      setBusy(false);
    }
  };

  const uploadShoppingMedia = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || busy || uploadingMedia) return;
    if (!selectedAddress) {
      setAddressChooserOpen(true);
      setAddressStatus('Choose a delivery address before using an upload.');
      return;
    }
    if (file.size > 2_250_000) {
      setStatus('Upload must be 2.25 MB or smaller.');
      return;
    }
    const allowed = new Set(['application/pdf', 'image/heic', 'image/jpeg', 'image/png', 'image/webp']);
    if (!allowed.has(file.type)) {
      setStatus('Upload a JPEG, PNG, WebP, HEIC, or PDF file.');
      return;
    }
    const userMessage = {
      id: `user-upload-${Date.now()}`,
      role: 'user',
      content: `uploaded ${file.type === 'application/pdf' ? 'a prescription/document' : 'a shopping image'}: ${file.name}`,
    };
    const waitingId = `tokko-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const requestMessages = [...messages, userMessage];
    setMessages([...requestMessages, {
      id: waitingId,
      role: 'assistant',
      content: '',
      pending: true,
    }]);
    setUploadingMedia(true);
    setBusy(true);
    setStatus('Reading the upload…');
    try {
      const result = await api('/api/hermes/media', {
        method: 'POST',
        body: {
          dataBase64: await blobAsBase64(file),
          mimeType: file.type,
          declaredType: file.type === 'application/pdf' ? 'prescription' : 'auto',
          language: speechLanguage,
          messages: conversationMessages(requestMessages),
        },
      });
      appendHermesResult(result, waitingId);
      setStatus('');
    } catch (error) {
      appendHermesResult({
        message: `i could not process that upload: ${error.message}`.toLowerCase(),
        tools: [],
      }, waitingId);
      setStatus(error.message);
    } finally {
      setUploadingMedia(false);
      setBusy(false);
    }
  };

  const approveAction = async (pendingMessage) => {
    if (busy || !pendingMessage.pendingAction?.token) return;
    const waitingId = `tokko-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const priorMessages = messages.filter((message) => message.id !== pendingMessage.id);
    const approvalMessage = {
      id: `user-approved-${Date.now()}`,
      role: 'user',
      content: 'yes, approved',
    };
    setMessages([
      ...priorMessages,
      {
        ...pendingMessage,
        pendingAction: null,
        content: pendingMessage.content.replace(/\s*good to send\?\s*$/i, ''),
      },
      approvalMessage,
      { id: waitingId, role: 'assistant', content: '', pending: true },
    ]);
    setBusy(true);
    setStatus('');
    try {
      const result = await requestHermesChat({
          messages: conversationMessages(priorMessages),
          approvalToken: pendingMessage.pendingAction.token,
          language: speechLanguage,
      });
      appendHermesResult(result, waitingId);
    } catch (error) {
      appendHermesResult({
        message: `i’m sorry, i could not confirm the approved action result: ${error.message}`.toLowerCase(),
        tools: [],
      }, waitingId);
      setStatus(error.message);
    } finally {
      setBusy(false);
    }
  };

  const declineAction = (pendingMessage) => {
    if (busy) return;
    setMessages((current) => [
      ...current.map((message) => (
        message.id === pendingMessage.id
          ? { ...message, pendingAction: null }
          : message
      )),
      {
        id: `user-declined-${Date.now()}`,
        role: 'user',
        content: 'no, leave it',
      },
      {
        id: `tokko-declined-${Date.now()}`,
        role: 'assistant',
        content: 'theek hai, i did not make that change.',
      },
    ]);
  };

  const continuePayment = async (paymentMessage) => {
    const checkoutId = paymentMessage.nextAction?.checkoutId;
    if (!checkoutId || busy) return;
    const waitingId = `tokko-payment-${Date.now()}`;
    setMessages((current) => [
      ...current,
      {
        id: `user-payment-${Date.now()}`,
        role: 'user',
        content: 'prava approval completed, continue checkout',
      },
      { id: waitingId, role: 'assistant', content: '', pending: true },
    ]);
    setBusy(true);
    setStatus('Checking Prava approval and continuing checkout…');
    try {
      const isUcpPayment = ['prava_card_approval', 'prava_mandate_approval'].includes(paymentMessage.nextAction?.type)
        && paymentMessage.nextAction?.orderId;
      const result = await api(
        isUcpPayment
          ? `/api/merchants/ucp/orders/${checkoutId}/payment/continue`
          : '/api/hermes/checkout/continue',
        { method: 'POST', body: isUcpPayment ? {} : { checkoutId } }
      );
      appendHermesResult(isUcpPayment ? {
        message: result.tokenIssued
          ? result.sandboxPaymentCredential?.token
            ? 'prava returned the sandbox mandate-charge token. it is shown below for this test session and is not stored.'
            : 'prava returned the payment credential. tokko saved only its fingerprint against this order.'
          : `prava is still ${result.pravaStatus || 'pending'}. finish the hosted approval and try again.`,
        tools: [],
        sandboxPaymentCredential: result.sandboxPaymentCredential || null,
      } : result, waitingId);
      setStatus('');
    } catch (error) {
      appendHermesResult({
        message: `i’m sorry, i could not continue the payment: ${error.message}`.toLowerCase(),
        tools: [],
      }, waitingId);
      setStatus(error.message);
    } finally {
      setBusy(false);
    }
  };

  const selectUcpProduct = async (product) => {
    if (!selectedAddress) {
      setAddressChooserOpen(true);
      setAddressStatus('Choose a delivery address before checkout.');
      return;
    }
    if (busy || !product?.selectionToken || !product.available) return;
    const waitingId = `tokko-ucp-checkout-${Date.now()}`;
    const userMessage = {
      id: `user-ucp-selection-${Date.now()}`,
      role: 'user',
      content: `i select ${product.productName}, ${product.variantName}, from ${product.merchantName}`,
    };
    setMessages((current) => [
      ...current,
      userMessage,
      { id: waitingId, role: 'assistant', content: '', pending: true },
    ]);
    setBusy(true);
    setStatus(`Adding ${product.productName} to your ${product.merchantName} cart…`);
    try {
      let cartSummary = null;
      if (product.choiceId) {
        try {
          const added = await api('/api/merchants/ucp/cart/items', {
            method: 'POST',
            body: { choiceId: product.choiceId, quantity: 1 },
          });
          cartSummary = added.cart || null;
        } catch (error) {
          if (error.details?.code !== 'merchant_cart_conflict') throw error;
          const conflict = error.details.conflict || {};
          const replace = window.confirm(
            `Your cart currently contains ${conflict.currentMerchantName || 'another merchant'}. `
            + `A single order cannot mix merchants. Press OK to replace that cart with ${product.merchantName}, or Cancel to keep the current cart.`
          );
          if (!replace) {
            appendHermesResult({
              message: `i kept your current ${conflict.currentMerchantName || 'merchant'} cart unchanged.`,
              tools: [],
            }, waitingId);
            setStatus('Current cart kept.');
            return;
          }
          const replaced = await api('/api/merchants/ucp/cart/items', {
            method: 'POST',
            body: { choiceId: product.choiceId, quantity: 1, replaceCart: true },
          });
          cartSummary = replaced.cart || null;
        }
      }
      const result = await api(
        product.choiceId ? '/api/merchants/ucp/cart/checkout' : '/api/merchants/ucp/checkout',
        {
          method: 'POST',
          body: product.choiceId
            ? {}
            : { selectionToken: product.selectionToken, quantity: 1 },
        }
      );
      appendHermesResult({
        message:
          `${result.merchantName} returned the final ${result.currency} ${result.totalAmount} quote. `
          + 'review every charge and delivery estimate, then choose whether to proceed.',
        tools: [{
          name: 'create_wellness_checkout',
          status: 'completed',
          result,
        }],
        checkoutSummary: {
          orderId: result.orderId,
          currency: result.currency,
          totalAmount: result.totalAmount,
          ...(result.quote || {}),
          confirmationRequired: true,
        },
        cartSummary,
      }, waitingId);
      setStatus('');
    } catch (error) {
      appendHermesResult({
        message: `i’m sorry, ${product.merchantName} could not create that checkout: ${error.message}`.toLowerCase(),
        tools: [{ name: 'create_wellness_checkout', status: 'failed', error: error.message }],
      }, waitingId);
      setStatus(error.message);
    } finally {
      setBusy(false);
    }
  };

  const removeUcpCartItem = async (_sourceMessage, item) => {
    if (busy || !item?.id) return;
    const waitingId = `trakko-cart-remove-${Date.now()}`;
    setMessages((current) => [
      ...current.map((message) => ({
        ...message,
        ...(message.checkoutSummary
          ? { checkoutSummary: { ...message.checkoutSummary, confirmationRequired: false } }
          : {}),
        paymentDecision: null,
      })),
      { id: waitingId, role: 'assistant', content: '', pending: true },
    ]);
    setBusy(true);
    try {
      const result = await api(`/api/merchants/ucp/cart/items/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      appendHermesResult({
        message: `removed ${item.productName || 'that item'} from your cart.`.toLowerCase(),
        tools: [{ name: 'remove_wellness_cart_item', status: 'completed' }],
        cartSummary: result.cart,
      }, waitingId);
    } catch (error) {
      appendHermesResult({ message: `i could not remove that cart item: ${error.message}`.toLowerCase(), tools: [] }, waitingId);
    } finally {
      setBusy(false);
    }
  };

  const emptyUcpCart = async () => {
    if (busy) return;
    const waitingId = `trakko-cart-empty-${Date.now()}`;
    setMessages((current) => [
      ...current.map((message) => ({
        ...message,
        ...(message.checkoutSummary
          ? { checkoutSummary: { ...message.checkoutSummary, confirmationRequired: false } }
          : {}),
        paymentDecision: null,
      })),
      { id: waitingId, role: 'assistant', content: '', pending: true },
    ]);
    setBusy(true);
    try {
      const result = await api('/api/merchants/ucp/cart', { method: 'DELETE' });
      appendHermesResult({
        message: result.removedCount ? 'done, i emptied your cart.' : 'your cart was already empty.',
        tools: [{ name: 'empty_wellness_cart', status: 'completed' }],
        cartSummary: result.cart,
      }, waitingId);
    } catch (error) {
      appendHermesResult({ message: `i could not empty the cart: ${error.message}`.toLowerCase(), tools: [] }, waitingId);
    } finally {
      setBusy(false);
    }
  };

  const resolveCartCountryConflict = async (sourceMessage, shouldRetry) => {
    if (busy) return;
    if (!shouldRetry) {
      setMessages((current) => current.map((message) => (
        message.id === sourceMessage.id
          ? {
              ...message,
              content: 'kept your current cart unchanged. choose a compatible delivery address when you are ready.',
              cartCountryConflict: null,
            }
          : message
      )));
      return;
    }
    const retryQuery = String(sourceMessage.cartCountryConflict?.retryQuery || '').trim();
    if (!retryQuery) {
      setStatus('The original search is no longer available. Empty the cart, then search again.');
      return;
    }
    setBusy(true);
    setStatus('Clearing the incompatible cart…');
    try {
      await api('/api/merchants/ucp/cart', { method: 'DELETE' });
      setMessages((current) => current.map((message) => (
        message.id === sourceMessage.id
          ? {
              ...message,
              content: `cleared the incompatible cart. retrying: ${retryQuery}`,
              cartCountryConflict: null,
              cartSummary: null,
            }
          : message
      )));
      setStatus('');
      await sendMessage(retryQuery);
    } catch (error) {
      setStatus(`Could not clear the incompatible cart: ${error.message}`);
    } finally {
      setBusy(false);
    }
  };

  const decideUcpOrder = async (sourceMessage, proceed) => {
    const orderId = sourceMessage.checkoutSummary?.orderId;
    if (!orderId || busy) return;
    const waitingId = `trakko-ucp-decision-${Date.now()}`;
    setMessages((current) => [
      ...current.map((message) => message.id === sourceMessage.id
        ? { ...message, checkoutSummary: { ...message.checkoutSummary, confirmationRequired: false } }
        : message),
      { id: `user-ucp-decision-${Date.now()}`, role: 'user', content: proceed ? 'proceed with order' : 'do not place order' },
      { id: waitingId, role: 'assistant', content: '', pending: true },
    ]);
    setBusy(true);
    try {
      const result = await api(`/api/merchants/ucp/orders/${orderId}/decision`, {
        method: 'POST', body: { proceed },
      });
      appendHermesResult({
        message: proceed
          ? 'price confirmed. choose how you want prava to authorize this order.'
          : 'okay, i did not place the order and no payment was attempted.',
        tools: [],
        paymentDecision: proceed ? { orderId, ...(result.paymentOptions || {}) } : null,
      }, waitingId);
    } catch (error) {
      appendHermesResult({ message: `i could not save that choice: ${error.message}`.toLowerCase(), tools: [] }, waitingId);
    } finally {
      setBusy(false);
    }
  };

  const selectUcpOrderPayment = async (sourceMessage, choice) => {
    const decision = sourceMessage.paymentDecision || {};
    if (!decision.orderId || busy) return;
    const waitingId = `trakko-ucp-payment-${Date.now()}`;
    setMessages((current) => [...current, { id: waitingId, role: 'assistant', content: '', pending: true }]);
    setBusy(true);
    try {
      const result = await api(`/api/merchants/ucp/orders/${decision.orderId}/payment`, {
        method: 'POST',
        body: {
          method: choice.method,
          mandateId: choice.mandateId,
          paymentMethodId: choice.paymentMethodId,
          frequency: 'monthly',
          returnContext: { channel: 'web', page: 'assistant' },
        },
      });
      appendHermesResult({
        message: result.tokenIssued
          ? result.sandboxPaymentCredential?.token
            ? 'prava issued a sandbox mandate-charge token. it is shown below for this test session and is not stored.'
            : 'prava issued a single-use payment credential and tokko linked its fingerprint to this order.'
          : 'open the prava-hosted page to approve this payment step. no merchant checkout link is exposed.',
        tools: [],
        sandboxPaymentCredential: result.sandboxPaymentCredential || null,
        nextAction: result.nextAction?.url ? {
          ...result.nextAction,
          orderId: decision.orderId,
          checkoutId: decision.orderId,
        } : null,
      }, waitingId);
    } catch (error) {
      appendHermesResult({ message: `i could not start that prava flow: ${error.message}`.toLowerCase(), tools: [] }, waitingId);
    } finally {
      setBusy(false);
    }
  };

  const selectUcpPaymentCard = async (sourceMessage, card) => {
    if (busy || !card?.token) return;
    const waitingId = `tokko-ucp-card-${Date.now()}`;
    setMessages((current) => [
      ...current.map((message) => (
        message.id === sourceMessage.id
          ? { ...message, cardChoices: [] }
          : message
      )),
      {
        id: `user-ucp-card-${Date.now()}`,
        role: 'user',
        content: `use ${card.brand} ending ${card.last4}`,
      },
      { id: waitingId, role: 'assistant', content: '', pending: true },
    ]);
    setBusy(true);
    setStatus('Selecting the saved Prava card…');
    try {
      const result = await api('/api/merchants/ucp/payment-choice', {
        method: 'POST',
        body: { token: card.token },
      });
      appendHermesResult({
        message: `${result.savedCard.brand} ending ${result.savedCard.last4} is selected. the merchant may still ask you to confirm the card because it does not advertise a prava payment handler.`,
        tools: [{ name: 'select_prava_card', status: 'completed' }],
        nextAction: result.nextAction,
      }, waitingId);
      setStatus('');
    } catch (error) {
      appendHermesResult({
        message: `i could not select that saved card: ${error.message}`.toLowerCase(),
        tools: [{ name: 'select_prava_card', status: 'failed', error: error.message }],
      }, waitingId);
      setStatus(error.message);
    } finally {
      setBusy(false);
    }
  };

  const showMoreProducts = async (sourceMessage) => {
    if (!selectedAddress) {
      setAddressChooserOpen(true);
      setAddressStatus('Choose a delivery address before shopping.');
      return;
    }
    const query = String(sourceMessage.productQuery || '').trim();
    const offset = Number(sourceMessage.productPagination?.nextOffset || 10);
    if (!query || busy) return;
    const waitingId = `tokko-ucp-more-${Date.now()}`;
    setMessages((current) => [
      ...current,
      { id: waitingId, role: 'assistant', content: '', pending: true },
    ]);
    setBusy(true);
    setStatus('Loading up to 10 more preferred matches…');
    try {
      const result = await api('/api/merchants/ucp/search', {
        method: 'POST',
        body: { query, limit: 10, offset },
      });
      appendHermesResult({
        message: result.products?.length
          ? `here are the next ${result.products.length} matches, sorted by native price within each market.`
          : 'there are no more image-backed matches for this search.',
        tools: [{ name: 'search_wellness_merchants', status: 'completed' }],
        productChoices: result.products || [],
        merchantStatuses: result.merchants || [],
        productQuery: result.query || query,
        productPagination: result.pagination || null,
      }, waitingId);
      setStatus('');
    } catch (error) {
      appendHermesResult({
        message: `i could not load more matches: ${error.message}`.toLowerCase(),
        tools: [],
      }, waitingId);
      setStatus(error.message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (event) => {
    event.preventDefault();
    sendMessage();
  };

  return (
    <div className="subpage shopper-page">
      <section className="shopper-shell">
        <header className="shopper-header">
          <div className="shopper-identity">
            <span className="shopper-orb"><ShoppingBag size={21} /></span>
            <div>
              <p className="eyebrow">Your family shopping workspace</p>
              <h1>Personal shopper</h1>
              <span>Compare live wellness catalogues, review the final quote, and approve payment on Prava’s secure page.</span>
            </div>
          </div>
          <div className="shopper-connection connected" aria-label="Three live UCP merchants">
            <i /> India + US wellness UCPs
          </div>
        </header>

        <div className="shopper-command-bar">
          <div className="shopper-live-context" aria-label="Shopping readiness">
            <span><Users size={14} /><strong>{setup.members.length + 1}</strong> family members</span>
            <span><CreditCard size={14} /><strong>{setup.cards?.length || (setup.card?.connected ? 1 : 0)}</strong> saved cards</span>
            <span className={setup.mandate?.active ? 'ready' : ''}><ShieldCheck size={14} /> mandate {setup.mandate?.active ? 'ready' : 'optional'}</span>
          </div>
          <div className="shopper-voice-controls">
            <label>
              <Volume2 size={14} />
              <span>Voice language</span>
              <select
                aria-label="Tokko response and voice language"
                value={speechLanguage}
                onChange={(event) => {
                  window.speechSynthesis?.cancel();
                  setSpeakingId('');
                  setSpeechLanguage(event.target.value);
                }}
              >
                {SHOPPER_LANGUAGES.map((language) => (
                  <option key={language.locale} value={language.locale}>{language.label}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={autoSpeak ? 'active' : ''}
              aria-pressed={autoSpeak}
              onClick={() => setAutoSpeak((current) => !current)}
            >
              {autoSpeak ? <Volume2 size={14} /> : <VolumeX size={14} />}
              auto voice {autoSpeak ? 'on' : 'off'}
            </button>
          </div>
        </div>

        <section className="shopper-address-prompt" aria-label="Delivery address selection">
          <div className="shopper-address-heading">
            <span><MapPin size={17} /></span>
            <div>
              <strong>{selectedAddress && !addressChooserOpen ? `Delivering to ${confirmedAddress?.label || 'selected address'}` : 'Choose delivery address'}</strong>
              <small>{selectedAddress && !addressChooserOpen
                ? `${confirmedAddress?.countryCode ? `[${confirmedAddress.countryCode}] ` : ''}${confirmedAddress?.formattedAddress || confirmedAddress?.shortAddress || 'Address selected for this shopping session.'}`
                : 'Select a saved Tokko address before searching or checking out.'}</small>
            </div>
            <div className="shopper-address-actions">
              <button type="button" disabled={addressesBusy} onClick={() => loadShopperAddresses({ preserveSelection: true })}><ListFilter size={13} /> List</button>
              <button type="button" disabled={addressesBusy} onClick={() => loadShopperAddresses()}><RefreshCw size={13} /> Reselect</button>
              <button type="button" disabled={addressBusy} onClick={() => { setAddressStatus('Add the delivery address below.'); setAddressFormOpen(true); }}><Plus size={13} /> Add</button>
            </div>
          </div>
          {addressChooserOpen && (
            <>
              {addressesBusy ? (
                <div className="shopper-address-loading"><i /> Loading saved addresses…</div>
              ) : addresses.length ? (
                <div className="shopper-address-options" role="radiogroup" aria-label="Saved Tokko addresses">
                  {addresses.map((address, index) => {
                    const addressId = String(address.id || '');
                    const checked = addressId === selectedAddress;
                    return (
                      <label className={checked ? 'selected' : ''} key={addressId || `shopper-address-${index}`}>
                        <input
                          type="radio"
                          name="shopper-delivery-address"
                          value={addressId}
                          checked={checked}
                          disabled={!addressId || Boolean(addressSelectingId)}
                          onChange={() => selectShopperAddress(address)}
                        />
                        <span className="shopper-address-check">{checked && <Check size={12} />}</span>
                        <span>
                          <strong>{address.label || `Address ${index + 1}`}</strong>
                          <small>{address.countryCode ? `[${address.countryCode}] ` : ''}{address.formattedAddress || address.shortAddress || 'Saved Tokko address'}</small>
                        </span>
                        {addressSelectingId === addressId ? <RefreshCw className="spin" size={13} /> : <ArrowRight size={13} />}
                      </label>
                    );
                  })}
                </div>
              ) : (
                <button type="button" className="shopper-address-empty" onClick={() => setAddressFormOpen(true)}><Plus size={14} /> No saved address. Add one to continue.</button>
              )}
            </>
          )}
          {addressStatus && <p className="shopper-address-status" role="status">{addressStatus}</p>}
        </section>

        <div className="shopper-suggestions" aria-label="Suggested requests">
          {SHOPPER_SUGGESTIONS.map((suggestion) => {
            const SuggestionIcon = suggestion.icon;
            return (
              <button type="button" disabled={busy || !selectedAddress} key={suggestion.prompt} onClick={() => sendMessage(suggestion.prompt)}>
                <span><SuggestionIcon size={16} /></span>
                <span><strong>{suggestion.label}</strong><small>{suggestion.detail}</small></span>
                <ArrowRight size={14} />
              </button>
            );
          })}
        </div>

        <div className="shopper-conversation" aria-live="polite">
          {messages.map((message) => (
            <ShopperMessage
              key={message.id}
              message={message}
              busy={busy}
              onApprove={approveAction}
              onContinuePayment={continuePayment}
              onDecline={declineAction}
              onEmptyCart={emptyUcpCart}
              onResolveCartCountryConflict={resolveCartCountryConflict}
              onOrderDecision={decideUcpOrder}
              onRemoveCartItem={removeUcpCartItem}
              onReconnectZepto={() => sendMessage('reconnect zepto with otp')}
              onSelectPaymentCard={selectUcpPaymentCard}
              onSelectOrderPayment={selectUcpOrderPayment}
              onSelectProduct={selectUcpProduct}
              onShowMoreProducts={showMoreProducts}
              onSpeak={(selectedMessage) => speakText(selectedMessage.content, selectedMessage.id)}
              speaking={speakingId === message.id}
            />
          ))}
          <div ref={endRef} />
        </div>

        <form className="shopper-composer" onSubmit={submit}>
          <input
            ref={mediaInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
            hidden
            onChange={uploadShoppingMedia}
          />
          <label className="sr-only" htmlFor="tokko-shopper-message">Message Tokko</label>
          <textarea
            id="tokko-shopper-message"
            value={draft}
            disabled={busy || transcribing}
            maxLength={6_000}
            rows={1}
            placeholder={
              transcribing
                ? 'turning your voice into text…'
                : listening
                  ? 'listening… tap the microphone when you are done'
                  : !selectedAddress
                    ? 'select a delivery address to start shopping…'
                    : 'ask for a wellness product, brand, benefit, or ingredient…'
            }
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
              }
            }}
          />
          <div className="shopper-composer-actions">
            <button
              type="button"
              className="shopper-voice-command-button"
              disabled={busy || transcribing || uploadingMedia || !selectedAddress}
              aria-label="Upload product photo or prescription"
              onClick={() => mediaInputRef.current?.click()}
            >
              <Paperclip size={18} />
            </button>
            <button
              type="button"
              className={`shopper-voice-command-button ${listening ? 'listening' : ''}`}
              disabled={busy || transcribing || !selectedAddress}
              aria-label={listening ? 'Stop voice command' : 'Start voice command'}
              aria-pressed={listening}
              onClick={toggleVoiceCommand}
            >
              {listening ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
            <button type="submit" className="shopper-send-button" disabled={busy || transcribing || !draft.trim()} aria-label="Send message">
              <ArrowRight size={19} />
            </button>
          </div>
        </form>
        {listening && (
          <div className="shopper-listening-status" role="status">
            <i /><i /><i />
            listening in {SHOPPER_LANGUAGES.find((language) => language.locale === speechLanguage)?.label || 'English'}
          </div>
        )}
        {!listening && status && /voice|microphone|hear|speech|record|transcrib/i.test(status) && (
          <div className="shopper-voice-feedback" role="status">{status}</div>
        )}
        <footer className="shopper-footer">
          <span><ShieldCheck size={13} /> account changes always ask first</span>
          <span><Sparkles size={13} /> preferences improve with every successful shop</span>
        </footer>
        {status && <span className="sr-only" role="status">{status}</span>}
      </section>
      {addressFormOpen && (
        <div className="address-form-overlay" onMouseDown={() => !addressBusy && setAddressFormOpen(false)}>
          <section className="address-form-dialog" role="dialog" aria-modal="true" aria-labelledby="shopper-add-address-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="address-form-header">
              <div>
                <p className="eyebrow">Tokko delivery address</p>
                <h2 id="shopper-add-address-title">Add a new address</h2>
                <span>Type the address. Tokko will not request browser location.</span>
              </div>
              <button type="button" className="icon-button subtle" aria-label="Close address form" disabled={addressBusy} onClick={() => setAddressFormOpen(false)}><X size={19} /></button>
            </div>
            <form className="address-form-fields" onSubmit={saveShopperAddress}>
              <div className="form-grid two-columns">
                <label className="field-group"><span>Address type</span><select value={addressForm.type} onChange={(event) => updateShopperAddressForm('type', event.target.value)}><option value="HOME">Home</option><option value="WORK">Work</option><option value="OTHER">Other</option></select></label>
                <label className="field-group"><span>Address label</span><input required value={addressForm.name} onChange={(event) => updateShopperAddressForm('name', event.target.value)} placeholder="Home, Office, Parents…" /></label>
                <div className="field-group">
                  <span>Delivery country</span>
                  <div className="country-code-picker">
                    <select
                      aria-label="Delivery country code"
                      value={deliveryCountryIsPreset ? addressForm.countryCode : 'OTHER'}
                      onChange={(event) => updateShopperAddressForm(
                        'countryCode',
                        event.target.value === 'OTHER' ? '' : event.target.value
                      )}
                    >
                      {DELIVERY_COUNTRY_OPTIONS.map((country) => (
                        <option key={country.code} value={country.code}>{country.label}</option>
                      ))}
                      <option value="OTHER">Other country code…</option>
                    </select>
                    {!deliveryCountryIsPreset && (
                      <input
                        required
                        aria-label="Other delivery country code"
                        value={addressForm.countryCode}
                        onChange={(event) => updateShopperAddressForm('countryCode', event.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2))}
                        minLength={2}
                        maxLength={2}
                        pattern="[A-Za-z]{2}"
                        autoComplete="country"
                        placeholder="FR"
                      />
                    )}
                  </div>
                  <small>Tokko uses this ISO code to show only merchants that ship to this country.</small>
                </div>
                <label className="field-group"><span>Flat / House number</span><input required value={addressForm.flatDetails} onChange={(event) => updateShopperAddressForm('flatDetails', event.target.value)} placeholder="Flat 4B or House 18" /></label>
                <label className="field-group"><span>Building / Society (optional)</span><input value={addressForm.buildingName} onChange={(event) => updateShopperAddressForm('buildingName', event.target.value)} placeholder="Building or society name" /></label>
                <label className="field-group"><span>Floor (optional)</span><input value={addressForm.floor} onChange={(event) => updateShopperAddressForm('floor', event.target.value)} placeholder="4" /></label>
                <label className="field-group"><span>Landmark (optional)</span><input value={addressForm.landmark} onChange={(event) => updateShopperAddressForm('landmark', event.target.value)} placeholder="Near metro station" /></label>
                <label className="field-group address-wide-field"><span>Area, city, and state</span><input required value={addressForm.shortAddress} onChange={(event) => updateShopperAddressForm('shortAddress', event.target.value)} placeholder="Park Street, Kolkata, West Bengal" /></label>
                <label className="field-group"><span>Delivery contact name</span><input required value={addressForm.contactName} onChange={(event) => updateShopperAddressForm('contactName', event.target.value)} autoComplete="name" /></label>
                <div className="field-group">
                  <span>Delivery contact phone</span>
                  <div className="phone-input-row">
                    <div className="country-calling-code-picker">
                      <select
                        aria-label="Delivery contact country calling code"
                        value={contactCountryCodeIsPreset ? addressForm.contactCountryCode : 'OTHER'}
                        onChange={(event) => updateShopperAddressForm(
                          'contactCountryCode',
                          event.target.value === 'OTHER' ? '' : event.target.value
                        )}
                      >
                        {PHONE_COUNTRY_CODE_OPTIONS.map((country) => (
                          <option key={country.code} value={country.code}>{country.label}</option>
                        ))}
                        <option value="OTHER">Other…</option>
                      </select>
                      {!contactCountryCodeIsPreset && (
                        <input
                          required
                          aria-label="Other delivery contact country calling code"
                          value={addressForm.contactCountryCode}
                          onChange={(event) => updateShopperAddressForm('contactCountryCode', `+${event.target.value.replace(/\D/g, '').slice(0, 4)}`)}
                          inputMode="tel"
                          autoComplete="tel-country-code"
                          placeholder="+33"
                        />
                      )}
                    </div>
                    <input required aria-label="Delivery contact phone without country code" value={addressForm.contactLocalPhone} onChange={(event) => updateShopperAddressForm('contactLocalPhone', event.target.value)} inputMode="tel" autoComplete="tel-national" placeholder="98765 43210" />
                  </div>
                </div>
              </div>
              <div className="address-location-note hermes-address-note"><MapPin size={17} /><span>No browser geolocation or merchant account is used. This address is stored with the Tokko family.</span></div>
              {addressStatus && <p className={`form-message ${/could not|required|valid|failed/i.test(addressStatus) ? 'error-message' : ''}`} role="status">{addressStatus}</p>}
              <div className="address-form-actions"><button type="button" className="button secondary-button" disabled={addressBusy} onClick={() => setAddressFormOpen(false)}>Cancel</button><button type="submit" className="button primary-button" disabled={addressBusy}><MapPin size={16} /> {addressBusy ? 'Saving to Tokko…' : 'Save address'}</button></div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}

function DashboardSidebar({ page, setPage, onLogout, alertCount = 0, mobile = false, onNavigate, onClose }) {
  const links = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'assistant', label: 'Personal shopper', icon: MessageCircle },
    { id: 'connectors', label: 'Connectors', icon: Plug },
    { id: 'card', label: 'Cards', icon: CreditCard },
    { id: 'mandates', label: 'Mandates', icon: ShieldCheck },
    { id: 'alerts', label: 'Alerts', icon: Bell, count: alertCount || undefined },
    { id: 'family', label: 'Family', icon: Users },
  ];
  return (
    <aside className={`dashboard-sidebar ${mobile ? 'mobile-drawer' : ''}`}>
      <div className="sidebar-brand-row">
        <Brand />
        {mobile && <button className="icon-button subtle" aria-label="Close menu" onClick={onClose}><X size={18} /></button>}
      </div>
      <nav aria-label="Dashboard navigation">
        {links.map(({ id, label, icon: Icon, count }) => <button key={id} className={page === id ? 'active' : ''} onClick={() => { setPage(id); onNavigate?.(); }}><Icon size={18} /><span>{label}</span>{count && <b>{count}</b>}</button>)}
      </nav>
      <div className="dashboard-sidebar-bottom">
        <button><Settings size={18} /><span>Settings</span></button>
        <button onClick={onLogout}><LogOut size={18} /><span>Sign out</span></button>
      </div>
    </aside>
  );
}

function ConnectorsPage({ setup, onConnectZepto }) {
  const [merchants, setMerchants] = useState([]);
  const [status, setStatus] = useState('Checking live UCP profiles…');

  const refresh = async () => {
    setStatus('Checking live UCP profiles…');
    try {
      const result = await api('/api/merchants/ucp');
      setMerchants(result.merchants || []);
      setStatus('');
    } catch (error) {
      setStatus(`Could not check merchant UCPs: ${error.message}`);
    }
  };

  useEffect(() => { refresh(); }, []);

  return (
    <div className="subpage connectors-page">
      <div className="dashboard-heading">
        <div>
          <p className="eyebrow">Shopping services</p>
          <h1>Connectors</h1>
          <p>Tokko discovers each merchant’s live UCP capabilities. No OTP or account connection is needed for catalogue comparison.</p>
        </div>
        <button type="button" className="button secondary-button" onClick={refresh}><RefreshCw size={16} /> Refresh UCPs</button>
      </div>
      <div className="ucp-connector-grid">
        {(merchants.length ? merchants : [
          { merchant: 'kapiva', merchantName: 'Kapiva' },
          { merchant: 'oziva', merchantName: 'OZiva' },
          { merchant: 'himalayawellness', merchantName: 'Himalaya Wellness' },
        ]).map((merchant) => (
          <section className="connector-card" key={merchant.merchant}>
            <div className={`connector-brand connector-brand-${merchant.merchant}`}>{merchant.merchantName.charAt(0)}</div>
            <div className="connector-copy">
              <div>
                <h2>{merchant.merchantName}</h2>
                <StatusPill tone={merchant.error ? 'warning' : merchant.catalogSearch ? 'success' : 'neutral'}>
                  {merchant.error ? 'Unavailable' : merchant.catalogSearch ? 'Catalogue + checkout' : 'Checkout only'}
                </StatusPill>
              </div>
              <p>{merchant.catalogSearch
                ? 'Live UCP product discovery and merchant-hosted secure checkout.'
                : 'The current UCP profile does not advertise catalogue search.'}</p>
              {merchant.transport && <small>{merchant.transport.toUpperCase()} transport · discovered live</small>}
              {merchant.error && <small>{merchant.error}</small>}
            </div>
          </section>
        ))}
      </div>
      {status && <p className="form-message" role="status">{status}</p>}
      <div className="support-callout connector-support-note">
        <LockKeyhole size={18} />
        <div><strong>Quote-first payment</strong><span>Trakko shows the merchant’s complete UCP total, asks for confirmation, then opens only the Prava-hosted approval page.</span></div>
      </div>
    </div>
  );
}

function Metric({ label, value, context, icon: Icon, tone }) {
  return <div className={`metric-card ${tone || ''}`}><div><span>{label}</span><strong>{value}</strong><small>{context}</small></div><span className="metric-icon"><Icon size={20} /></span></div>;
}

function CheckoutActivityPanel({ flows = [], status = '' }) {
  const visible = flows.slice(0, 4);
  return (
    <section className="dashboard-section checkout-activity-section">
      <div className="section-heading">
        <div><h2>Payment & fallback activity</h2><p>Tokko records card receipt and Zepto order confirmation separately.</p></div>
        {!!visible.length && <StatusPill>{visible.length} recent</StatusPill>}
      </div>
      <div className="checkout-activity-list">
        {visible.map((flow) => {
          const cardFailed = Number(flow.cardFailureCount || 0) > 0;
          const cardReceived = flow.cardPaymentReceived === true;
          const codConfirmed = flow.status === 'COD_FALLBACK_CONFIRMED';
          const total = Number.isFinite(Number(flow.priceBreakdown?.totalPaise))
            ? formatPaise(flow.priceBreakdown.totalPaise)
            : null;
          return (
            <article className={`checkout-activity ${cardFailed && !cardReceived ? 'payment-failed' : ''}`} key={flow.id}>
              <span className="checkout-activity-icon">
                {cardReceived ? <CheckCircle2 size={19} /> : codConfirmed ? <Banknote size={19} /> : <CircleAlert size={19} />}
              </span>
              <div>
                <strong>
                  {cardReceived
                    ? 'Card payment received'
                    : cardFailed
                      ? 'Card payment not received'
                      : flow.status === 'REVIEW_CARD'
                        ? 'Card checkout reviewed'
                        : 'Cash on Delivery checkout'}
                </strong>
                <span>
                  {flow.card
                    ? `${String(flow.card.brand || 'Card').toUpperCase()} •••• ${flow.card.last4}`
                    : 'Zepto'}
                  {cardFailed ? ` · ${flow.cardFailureCount} of 3 card attempts failed` : ''}
                </span>
                {codConfirmed && <small>Fallback succeeded · COD order {flow.orderId}</small>}
                {flow.status === 'COD_FALLBACK_FAILED' && <small>COD fallback failed · cart retained</small>}
                {flow.failureMessage && !codConfirmed && <small>{flow.failureMessage}</small>}
              </div>
              <div className="checkout-activity-meta">
                {total && <strong>{total}</strong>}
                <span>{flow.updatedAt ? new Date(flow.updatedAt).toLocaleString() : ''}</span>
              </div>
            </article>
          );
        })}
        {!visible.length && <div className="table-empty">{status || 'No checkout activity yet.'}</div>}
      </div>
    </section>
  );
}

function dashboardAlerts(setup, orders = [], checkoutFlows = []) {
  const alerts = [];
  if (!setup.zeptoConnected) {
    alerts.push({
      id: 'zepto-disconnected',
      tone: 'warning',
      title: 'Zepto is not connected',
      detail: 'Connect or reconnect Zepto before placing and tracking orders.',
      page: 'assistant',
      action: 'Ask Tokko',
    });
  }
  if (!setup.card?.connected) {
    alerts.push({
      id: 'card-missing',
      tone: 'info',
      title: 'No saved card',
      detail: 'Add a card through Prava if you want to use card or mandate payments.',
      page: 'card',
      action: 'Open Cards',
    });
  }
  if (!setup.mandate?.active) {
    alerts.push({
      id: 'mandate-inactive',
      tone: 'info',
      title: 'No active Prava mandate',
      detail: 'A mandate requires one approval before later in-cap charges can be requested.',
      page: 'mandates',
      action: 'Open Mandates',
    });
  }
  for (const order of orders.filter((entry) =>
    !TERMINAL_ORDER_STATUSES.has(entry.status)
  )) {
    const eta = orderEta(order);
    alerts.push({
      id: `order-${order.id || order.code}`,
      tone: 'order',
      title: `Zepto order ${order.code || order.id}`,
      detail: `${order.status.replaceAll('_', ' ')}${eta === null ? '' : ` · ETA ${eta} min`}`,
      page: 'assistant',
      action: 'Ask Tokko',
    });
  }
  for (const flow of checkoutFlows.filter((entry) =>
    Number(entry.cardFailureCount || 0) > 0
    || ['COD_FALLBACK_FAILED', 'COD_FALLBACK_UNCONFIRMED'].includes(entry.status)
  )) {
    alerts.push({
      id: `checkout-${flow.id}`,
      tone: 'warning',
      title:
        flow.status === 'COD_FALLBACK_CONFIRMED'
          ? 'Card failed; COD fallback succeeded'
          : 'Payment needs attention',
      detail:
        flow.failureMessage
        || `${flow.cardFailureCount} of 3 card attempts failed.`,
      page: 'overview',
      action: 'View activity',
    });
  }
  return alerts;
}

function AlertsPage({
  setup,
  orders,
  checkoutFlows,
  busy,
  status,
  onNavigate,
  onRefresh,
}) {
  const alerts = dashboardAlerts(setup, orders, checkoutFlows);
  return (
    <div className="subpage alerts-page">
      <div className="dashboard-heading">
        <div><p className="eyebrow">Live account activity</p><h1>Alerts</h1><p>These alerts are derived from your real card, mandate, checkout, and Zepto order state.</p></div>
        <button type="button" className="button secondary-button" disabled={busy} onClick={onRefresh}><RefreshCw size={16} /> {busy ? 'Refreshing…' : 'Refresh alerts'}</button>
      </div>
      {status && <p className="form-message" role="status">{status}</p>}
      <section className="dashboard-section alerts-list">
        {alerts.map((alert) => (
          <article className={`account-alert ${alert.tone}`} key={alert.id}>
            <span className="account-alert-icon">
              {alert.tone === 'order' ? <ShoppingBag size={19} /> : alert.tone === 'warning' ? <CircleAlert size={19} /> : <Bell size={19} />}
            </span>
            <div><strong>{alert.title}</strong><span>{alert.detail}</span></div>
            <button type="button" className="button secondary-button compact-button" onClick={() => onNavigate(alert.page)}>{alert.action}<ArrowRight size={14} /></button>
          </article>
        ))}
        {!alerts.length && (
          <div className="alerts-empty"><CheckCircle2 size={28} /><strong>You’re all caught up</strong><span>No card, mandate, checkout, or active-order alerts need attention.</span></div>
        )}
      </section>
    </div>
  );
}

function OrdersTable({ limit, orders = [], accountName = 'Zepto account', onSelect }) {
  const visibleOrders = limit ? orders.slice(0, limit) : orders;
  const initials = accountName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || 'Z';
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Ordered by</th><th>Order</th><th>Payment</th><th>Status</th><th>ETA</th><th className="align-right">Amount</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{visibleOrders.map((order, index) => {
          const eta = orderEta(order);
          return (
          <tr key={order.id || order.code || `zepto-order-${index}`}>
            <td><div className="table-person"><span className="avatar small-avatar">{initials}</span><div><strong>{accountName}</strong><span>{orderTime(order)}</span></div></div></td>
            <td><strong>Zepto{order.code ? ` · ${order.code}` : ''}</strong><span className="cell-subtext">{orderItemsSummary(order)}</span></td>
            <td><StatusPill>{order.paymentMethod || order.paymentMode || 'Zepto'}</StatusPill></td>
            <td><StatusPill tone={orderStatusTone(order.status)}>{!TERMINAL_ORDER_STATUSES.has(order.status) && <Clock3 size={13} />}{order.status.replaceAll('_', ' ')}</StatusPill></td>
            <td className="eta-cell">{eta === null ? '—' : `${eta} min`}</td>
            <td className="align-right amount-cell">{orderAmount(order)}</td>
            <td>{onSelect && <button type="button" className="icon-button subtle" aria-label={`Track Zepto order ${order.code || order.id}`} data-tooltip="Track order" onClick={() => onSelect(order)}><MoreHorizontal size={17} /></button>}</td>
          </tr>
          );
        })}</tbody>
      </table>
      {!visibleOrders.length && <div className="table-empty">No orders yet.</div>}
    </div>
  );
}

function OrderDetailPanel({ order, busy, error, onClose, onRefresh }) {
  if (!order) return null;
  const shipment = order.shipments?.[0] || {};
  const eta = orderEta(order);
  return (
    <div className="address-form-overlay" onMouseDown={onClose}>
      <section className="order-detail-dialog" role="dialog" aria-modal="true" aria-label={`Zepto order ${order.code || order.id}`} onMouseDown={(event) => event.stopPropagation()}>
        <div className="address-form-header">
          <div><p className="eyebrow">Live from Zepto MCP</p><h2>{order.code || 'Order details'}</h2><span>{orderTime(order)}</span></div>
          <button type="button" className="icon-button subtle" aria-label="Close order details" onClick={onClose}><X size={19} /></button>
        </div>
        <div className="order-tracking-summary">
          <StatusPill tone={orderStatusTone(order.status)}>{order.status.replaceAll('_', ' ')}</StatusPill>
          <strong>{orderAmount(order)}</strong>
          {eta !== null && <span>ETA: {eta} min</span>}
        </div>
        {busy && <p className="form-message">Refreshing tracking from Zepto…</p>}
        {error && <p className="form-message error-message">{error}</p>}
        {!!order.products.length && (
          <div className="order-detail-products">
            {order.products.map((product, index) => (
              <div key={`${product.name}-${index}`}><span><strong>{product.name}</strong>{product.packSize && <small>{product.packSize}</small>}</span><b>×{product.count}</b></div>
            ))}
          </div>
        )}
        {order.userAddressFormatted && <div className="order-detail-address"><MapPin size={17} /><span>{order.userAddressFormatted}</span></div>}
        {(shipment.riderName || shipment.riderContactNumber) && (
          <div className="order-detail-address"><UserRound size={17} /><span>{shipment.riderName || 'Zepto rider'}{shipment.riderContactNumber ? ` · ${shipment.riderContactNumber}` : ''}</span></div>
        )}
        <div className="address-form-actions">
          <button type="button" className="button secondary-button" onClick={onClose}>Close</button>
          <button type="button" className="button primary-button" disabled={busy} onClick={onRefresh}><RefreshCw size={16} /> Refresh tracking</button>
        </div>
      </section>
    </div>
  );
}

function OrdersPage({ setup, orders, busy, status, lastRefreshAt, onRefresh }) {
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState('');
  const loadDetail = async (order = selectedOrder) => {
    if (!order?.id) return;
    setSelectedOrder(order);
    setDetailBusy(true);
    setDetailError('');
    try {
      const result = await api(`/api/orders/${encodeURIComponent(order.id)}`);
      setSelectedOrder(normalizeOrderRecord(result));
    } catch (error) {
      setDetailError(`Could not refresh Zepto tracking: ${error.message}`);
    } finally {
      setDetailBusy(false);
    }
  };
  useEffect(() => {
    if (!selectedOrder?.id || TERMINAL_ORDER_STATUSES.has(selectedOrder.status)) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      loadDetail(selectedOrder);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [selectedOrder?.id, selectedOrder?.status]);
  return (
    <div className="subpage orders-page">
      <div className="dashboard-heading">
        <div><p className="eyebrow">Connected Zepto account</p><h1>Orders</h1><p>Order history and tracking come directly from Zepto MCP.</p><span className="auto-refresh-note"><RefreshCw size={13} /> Auto-refresh every 1 min{lastRefreshAt ? ` · last checked ${lastRefreshAt.toLocaleTimeString()}` : ''}</span></div>
        <button type="button" className="button secondary-button" disabled={busy} onClick={() => onRefresh()}><RefreshCw size={17} /> {busy ? 'Refreshing…' : 'Refresh now'}</button>
      </div>
      {status && <p className="form-message" role="status">{status}</p>}
      <section className="dashboard-section">
        <OrdersTable
          orders={orders}
          accountName={setup.profile.name || 'Zepto account'}
          onSelect={loadDetail}
        />
      </section>
      <OrderDetailPanel
        order={selectedOrder}
        busy={detailBusy}
        error={detailError}
        onClose={() => setSelectedOrder(null)}
        onRefresh={() => loadDetail()}
      />
    </div>
  );
}

function formatMandateAmount(value, currency = 'INR') {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function activePravaMandates(values) {
  return (Array.isArray(values) ? values : []).filter(
    (mandate) => {
      const status = String(mandate?.status || '').toLowerCase();
      const state = String(mandate?.state || '').toLowerCase();
      return status === 'active' || state === 'available';
    }
  );
}

function singlePravaMandateForAmount(values, amount) {
  const required = Number(amount);
  if (!Number.isFinite(required) || required <= 0) return null;
  return activePravaMandates(values)
    .filter((mandate) => {
      const remaining = Number(
        mandate.remaining ?? mandate.approvedAmount
      );
      const currency = String(mandate.currency || 'INR').toUpperCase();
      const zeptoScoped =
        !mandate.merchantName || /zepto/i.test(mandate.merchantName);
      return (
        currency === 'INR'
        && zeptoScoped
        && Number.isFinite(remaining)
        && remaining >= required
      );
    })
    .sort(
      (left, right) =>
        Number(left.remaining ?? left.approvedAmount)
        - Number(right.remaining ?? right.approvedAmount)
    )[0] || null;
}

function summarizePravaMandates(values) {
  const active = activePravaMandates(values);
  if (!active.length) return null;
  const currency = String(active[0].currency || 'INR').toUpperCase();
  const compatible = active.filter(
    (mandate) => String(mandate.currency || 'INR').toUpperCase() === currency
  );
  const approvedAmount = compatible.reduce((total, mandate) => {
    const amount = Number(mandate.approvedAmount);
    return total + (Number.isFinite(amount) && amount > 0 ? amount : 0);
  }, 0);
  const remaining = compatible.reduce((total, mandate) => {
    const amount = Number(
      mandate.remaining ?? mandate.approvedAmount
    );
    return total + (Number.isFinite(amount) && amount > 0 ? amount : 0);
  }, 0);
  const frequencies = [...new Set(
    compatible.map((mandate) => mandate.frequency).filter(Boolean)
  )];
  const merchantNames = [...new Set(
    compatible.map((mandate) => mandate.merchantName).filter(Boolean)
  )];
  const renewalTimes = compatible
    .map((mandate) => mandate.renewsAt)
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);
  return {
    ...compatible[0],
    ids: compatible.map((mandate) => mandate.id).filter(Boolean),
    count: compatible.length,
    approvedAmount,
    remaining,
    currency,
    frequency: frequencies.length === 1 ? frequencies[0] : 'mixed',
    merchantName:
      merchantNames.length === 1 ? merchantNames[0] : 'Combined merchants',
    renewsAt: renewalTimes.length
      ? new Date(Math.min(...renewalTimes)).toISOString()
      : null,
  };
}

function MandatesPage({ setup, setSetup, onAddCard, callbackResult }) {
  const presets = [50, 100, 500, 1000];
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [mandates, setMandates] = useState([]);
  const [mandateSummary, setMandateSummary] = useState(null);
  const [historyMandates, setHistoryMandates] = useState([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [mandateTab, setMandateTab] = useState('current');
  const [selectedCardId, setSelectedCardId] = useState('');
  const [amountOption, setAmountOption] = useState('500');
  const [customAmount, setCustomAmount] = useState('');
  const [frequency, setFrequency] = useState('monthly');
  const [pendingSession, setPendingSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const applyMandates = (values, suppliedSummary = null) => {
    const next = Array.isArray(values) ? values : [];
    setMandates(next);
    const visibleActive = summarizePravaMandates(next);
    const summary = suppliedSummary && typeof suppliedSummary === 'object'
      ? suppliedSummary
      : null;
    setMandateSummary(summary);
    const active = Number(summary?.activeCount || 0) > 0
      ? {
          ...(visibleActive || {}),
          count: Number(summary.activeCount),
          approvedAmount: Number(summary.approvedAmount || 0),
          remaining: Number(summary.remaining || 0),
          currency: summary.currency || visibleActive?.currency || 'INR',
          frequency: summary.frequency || visibleActive?.frequency || 'mixed',
          merchantName: summary.merchantName || visibleActive?.merchantName || 'Combined merchants',
          renewsAt: summary.renewsAt || visibleActive?.renewsAt || null,
        }
      : visibleActive;
    setSetup((current) => ({
      ...current,
      mandate: {
        ...current.mandate,
        active: Boolean(active),
        id: active?.id || null,
        ids: active?.ids || [],
        count: active?.count || 0,
        status: active?.status || 'inactive',
        total: Number(active?.approvedAmount || 0),
        remaining: Number(active?.remaining || 0),
        currency: active?.currency || 'INR',
        period: active?.frequency
          ? `${active.frequency.charAt(0).toUpperCase()}${active.frequency.slice(1)}`
          : current.mandate.period,
        renewsAt: active?.renewsAt || null,
      },
    }));
    return active;
  };

  const refresh = async ({ quiet = false } = {}) => {
    if (!quiet) setBusy(true);
    try {
      const [methodResult, mandateResult] = await Promise.allSettled([
        api('/api/payments/payment-methods'),
        api('/api/payments/mandates'),
      ]);
      if (methodResult.status === 'rejected') throw methodResult.reason;
      const methods = methodResult.value.paymentMethods || [];
      setPaymentMethods(methods);
      setSelectedCardId((current) =>
        current
        || String(
          methods.find((method) => method.isDefault)?.id
          || methods[0]?.id
          || ''
        )
      );
      if (mandateResult.status === 'rejected') {
        setStatus(
          `Saved cards loaded, but Prava mandate status is unavailable: ${mandateResult.reason.message}`
        );
        return;
      }
      const active = applyMandates(
        mandateResult.value.mandates || [],
        mandateResult.value.summary
      );
      setStatus(
        mandateResult.value.warning
          ? mandateResult.value.warning
          : active
          ? `${active.count} active Prava mandate${active.count === 1 ? '' : 's'} with ${formatMandateAmount(active.remaining, active.currency)} combined remaining.`
          : 'No active Prava mandate was returned.'
      );
    } catch (error) {
      setStatus(`Could not load Prava mandates: ${error.message}`);
    } finally {
      if (!quiet) setBusy(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (!callbackResult) return;
    if (callbackResult.error) {
      setStatus(`Prava mandate approval returned, but token generation is pending: ${callbackResult.error}`);
      return;
    }
    if (callbackResult.tokenIssued) {
      setStatus(
        `Prava approved the mandate and issued a ${callbackResult.currency} ${callbackResult.chargeAmount} sandbox credential.`
      );
      refresh({ quiet: true });
    }
  }, [callbackResult?.callbackId, callbackResult?.status, callbackResult?.error]);

  const openHistory = async () => {
    setMandateTab('history');
    if (historyLoaded) return;
    setBusy(true);
    setStatus('Loading the last 30 days of mandate history…');
    try {
      const result = await api('/api/payments/mandates?view=history&days=30');
      setHistoryMandates(result.mandates || []);
      setHistoryLoaded(true);
      setStatus(
        result.mandates?.length
          ? `${result.mandates.length} mandate${result.mandates.length === 1 ? '' : 's'} found in the last 30 days.`
          : 'No mandate activity was returned for the last 30 days.'
      );
    } catch (error) {
      setStatus(`Could not load mandate history: ${error.message}`);
    } finally {
      setBusy(false);
    }
  };

  const createMandate = async () => {
    const amount =
      amountOption === 'custom' ? Number(customAmount) : Number(amountOption);
    if (!selectedCardId) {
      setStatus('Select a saved Prava card first.');
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setStatus('Enter a positive mandate amount.');
      return;
    }
    setBusy(true);
    setStatus('Creating the Prava mandate approval…');
    try {
      const session = await api('/api/payments/mandates/session', {
        method: 'POST',
        body: {
          paymentMethodId: selectedCardId,
          amount,
          frequency,
          returnContext: { channel: 'web', page: 'mandates' },
        },
      });
      setPendingSession(session);
      setStatus(
        'Mandate session created. Approve it once in Prava. On return, Tokko will verify the active mandate and request a ₹1 sandbox credential automatically.'
      );
    } catch (error) {
      setStatus(`Could not create the Prava mandate: ${error.message}`);
    } finally {
      setBusy(false);
    }
  };

  const usableMandates = activePravaMandates(mandates).slice(0, 5);
  const visibleActiveMandate = summarizePravaMandates(mandates);
  const activeMandate = Number(mandateSummary?.activeCount || 0) > 0
    ? {
        ...(visibleActiveMandate || {}),
        count: Number(mandateSummary.activeCount),
        approvedAmount: Number(mandateSummary.approvedAmount || 0),
        remaining: Number(mandateSummary.remaining || 0),
        currency: mandateSummary.currency || visibleActiveMandate?.currency || 'INR',
        frequency: mandateSummary.frequency || visibleActiveMandate?.frequency || 'mixed',
        merchantName: mandateSummary.merchantName || visibleActiveMandate?.merchantName || 'Combined merchants',
        renewsAt: mandateSummary.renewsAt || visibleActiveMandate?.renewsAt || null,
      }
    : visibleActiveMandate;

  return (
    <div className="subpage mandate-management-page">
      <div className="dashboard-heading">
        <div>
          <p className="eyebrow">Automatic card authorization</p>
          <h1>Prava mandate</h1>
          <p>Approve the saved card once. Tokko can then request permitted Prava mandate charges without another OTP, passkey, or CVV entry.</p>
        </div>
        <button type="button" className="button secondary-button" disabled={busy} onClick={() => refresh()}>
          <RefreshCw size={16} /> {busy ? 'Refreshing…' : 'Refresh status'}
        </button>
      </div>

      <div className="mandate-view-tabs" role="tablist" aria-label="Mandate views">
        <button
          type="button"
          role="tab"
          aria-selected={mandateTab === 'current'}
          className={mandateTab === 'current' ? 'active' : ''}
          onClick={() => setMandateTab('current')}
        >
          Current mandates
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mandateTab === 'history'}
          className={mandateTab === 'history' ? 'active' : ''}
          onClick={openHistory}
        >
          30-day history
        </button>
      </div>

      {callbackResult?.sandboxPaymentCredential?.token && (
        <section className="shopper-payment-credential sandbox-token" aria-label="Prava sandbox mandate callback token">
          <span>Prava Sandbox Mandate Charge Token</span>
          <code>{callbackResult.sandboxPaymentCredential.token}</code>
          <small>
            transaction {callbackResult.sandboxPaymentCredential.transactionId || 'pending'}
            {' · '}mandate {callbackResult.sandboxPaymentCredential.mandateId || 'approved mandate'}
          </small>
          <small>This single-use virtual PAN came from Prava’s Charge API after the approval callback. Tokko stored only its fingerprint.</small>
        </section>
      )}

      {mandateTab === 'current' && activeMandate && (
        <section className="dashboard-section active-mandate-card">
          <div className="section-heading">
            <div><h2>{activeMandate.count} active {activeMandate.merchantName || 'Zepto'} mandate{activeMandate.count === 1 ? '' : 's'}</h2><p>{activeMandate.frequency.replaceAll('_', ' ')} authorization</p></div>
            <StatusPill tone="success"><CheckCircle2 size={14} /> Combined</StatusPill>
          </div>
          <div className="mandate-live-amounts">
            <div><span>Combined available</span><strong>{formatMandateAmount(activeMandate.remaining, activeMandate.currency)}</strong></div>
            <div><span>Total authorized</span><strong>{formatMandateAmount(activeMandate.approvedAmount, activeMandate.currency)}</strong></div>
          </div>
          <div className="active-mandate-breakdown">
            {usableMandates.map((mandate, index) => (
              <div key={mandate.id || `active-mandate-${index}`}>
                <span>Mandate {index + 1}{mandate.last4 ? ` · •••• ${mandate.last4}` : ''}</span>
                <strong>{formatMandateAmount(mandate.remaining ?? mandate.approvedAmount, mandate.currency)}</strong>
                <small>of {formatMandateAmount(mandate.approvedAmount, mandate.currency)}</small>
              </div>
            ))}
          </div>
          <div className="mandate-list-footer">
            <span>Showing {usableMandates.length} of {mandateSummary?.activeCount || usableMandates.length} active mandates</span>
            {(mandateSummary?.totalCount || mandates.length) > mandates.length && (
              <button type="button" className="text-button" onClick={openHistory}>
                Show all <ArrowRight size={14} />
              </button>
            )}
          </div>
          <p className="checkout-note">Tokko totals every active Prava mandate in the same currency. Each mandate remains independently enforced by Prava; Tokko initiates checkout deductions and Prava does not schedule them by itself.</p>
        </section>
      )}

      {mandateTab === 'history' && (
        <section className="dashboard-section mandate-history-card" role="tabpanel">
          <div className="section-heading">
            <div>
              <h2>Mandate history</h2>
              <p>All Prava mandate activity returned for the last 30 days.</p>
            </div>
            <StatusPill>{historyMandates.length} records</StatusPill>
          </div>
          <div className="mandate-history-list">
            {historyMandates.map((mandate, index) => {
              const activityAt = mandate.updatedAt || mandate.createdAt || mandate.lastCharge?.at;
              return (
                <div key={mandate.id || `mandate-history-${index}`}>
                  <span className="mandate-history-status">{String(mandate.status || mandate.state || 'pending').replaceAll('_', ' ')}</span>
                  <div>
                    <strong>{mandate.merchantName || 'Merchant mandate'}</strong>
                    <small>{String(mandate.frequency || 'one_time').replaceAll('_', ' ')}{activityAt ? ` · ${new Date(activityAt).toLocaleDateString()}` : ''}</small>
                  </div>
                  <span>
                    <strong>{formatMandateAmount(mandate.remaining ?? mandate.approvedAmount, mandate.currency)}</strong>
                    <small>of {formatMandateAmount(mandate.approvedAmount, mandate.currency)}</small>
                  </span>
                </div>
              );
            })}
            {historyLoaded && !historyMandates.length && (
              <div className="mandate-history-empty">No mandate activity in the last 30 days.</div>
            )}
          </div>
          {status && <p className={`form-message ${/could not|invalid|required|error/i.test(status) ? 'error-message' : ''}`} role="status">{status}</p>}
          <button type="button" className="button secondary-button" onClick={() => setMandateTab('current')}>Back to current mandates</button>
        </section>
      )}

      {mandateTab === 'current' && <section className="dashboard-section mandate-create-card">
        <div className="section-heading"><div><h2>Create a mandate</h2><p>Amounts use INR because the connected Zepto checkout charges in INR.</p></div></div>

        <div className="mandate-card-picker">
          <strong>Saved card</strong>
          {paymentMethods.map((method) => (
            <button
              type="button"
              key={method.id}
              className={`checkout-saved-card ${String(method.id) === selectedCardId ? 'selected' : ''}`}
              onClick={() => setSelectedCardId(String(method.id))}
            >
              <span className="checkout-address-radio">{String(method.id) === selectedCardId && <Check size={12} />}</span>
              <CreditCard size={18} />
              <span className="checkout-card-copy"><strong>{String(method.brand || 'Card').toUpperCase()} •••• {method.last4}</strong><small>Tokenized by Prava</small></span>
            </button>
          ))}
          {!paymentMethods.length && (
            <div className="checkout-missing-card">
              <p className="checkout-note">Save a card before creating a mandate.</p>
              <button type="button" className="button secondary-button" onClick={onAddCard}><Plus size={15} /> Add card with Prava</button>
            </div>
          )}
        </div>

        <div className="mandate-amount-picker">
          <strong>Maximum amount</strong>
          <div className="mandate-preset-grid">
            {presets.map((amount) => (
              <button type="button" key={amount} className={amountOption === String(amount) ? 'selected' : ''} onClick={() => setAmountOption(String(amount))}>₹{amount}</button>
            ))}
            <button type="button" className={amountOption === 'custom' ? 'selected' : ''} onClick={() => setAmountOption('custom')}>Custom</button>
          </div>
          {amountOption === 'custom' && (
            <label className="field-group mandate-custom-amount"><span>Custom amount</span><div className="currency-input"><span>₹</span><input type="number" min="1" step="0.01" value={customAmount} onChange={(event) => setCustomAmount(event.target.value)} /></div></label>
          )}
          <label className="field-group mandate-frequency"><span>Authorization cycle</span><select value={frequency} onChange={(event) => setFrequency(event.target.value)}><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label>
        </div>

        <div className="mandate-provider-note"><ShieldCheck size={18} /><span>Creating the mandate does not charge the card. Prava asks for one passkey approval, preselects the saved card, and permits later in-cap charges without another OTP or CVV.</span></div>
        <button type="button" className="button primary-button full-button" disabled={busy || !paymentMethods.length} onClick={createMandate}><Fingerprint size={16} /> Create and approve mandate</button>
        {pendingSession?.approvalUrl && (
          <div className="mandate-approval-callout">
            <div><strong>Approval required once</strong><span>Complete the Prava passkey approval. Tokko will return here and call the sandbox mandate Charge API automatically.</span></div>
            <a className="button primary-button" href={pendingSession.approvalUrl} target="_self"><ExternalLink size={16} /> Open Prava approval</a>
          </div>
        )}
        {status && <p className={`form-message ${/could not|invalid|required|error/i.test(status) ? 'error-message' : ''}`} role="status">{status}</p>}
      </section>}
    </div>
  );
}

function DashboardOverview({ setup, setSetup, setPage, orders, ordersBusy, ordersStatus, checkoutFlows, checkoutStatus, onRefreshOrders, onConnectZepto }) {
  const todayLabel = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
  const remaining = Math.max(Number(setup.mandate.remaining || 0), 0);
  const approvedAmount = Math.max(Number(setup.mandate.total || 0), 0);
  const spent = Math.max(approvedAmount - remaining, 0);
  const spentPercent = approvedAmount > 0 ? Math.min((spent / approvedAmount) * 100, 100) : 0;
  const mandateCurrency = setup.mandate.currency || 'INR';
  const alerts = dashboardAlerts(setup, orders, checkoutFlows);
  return (
    <>
      <div className="dashboard-heading"><div><p className="eyebrow">{todayLabel}</p><h1>Good morning, {setup.profile.name.split(' ')[0]}</h1><p>Tokko has your family's shopping and spending in one place.</p></div><button type="button" className="button secondary-button" onClick={() => setPage('alerts')}><Bell size={17} /> Alerts{alerts.length > 0 && <span className="notification-count">{alerts.length}</span>}</button></div>
      {!setup.zeptoConnected && <div className="dashboard-alert"><div className="zepto-mark small">Z</div><div><strong>Connect Zepto to enable family orders</strong><span>Your card and approvals are ready. Merchant ordering is still paused.</span></div><button className="button zepto-button" onClick={onConnectZepto}>Connect Zepto <ExternalLink size={16} /></button></div>}
      <div className="metric-grid">
        <Metric label="Mandate used" value={formatMandateAmount(spent, mandateCurrency)} context={setup.mandate.active ? 'Reported mandate window' : 'No active mandate'} icon={CircleDollarSign} />
        <Metric label="Mandate remaining" value={formatMandateAmount(remaining, mandateCurrency)} context={`of ${formatMandateAmount(approvedAmount, mandateCurrency)} ${setup.mandate.period.toLowerCase()}`} icon={ShieldCheck} tone="green" />
        <Metric label="Mandate status" value={setup.mandate.active ? 'Active' : 'Off'} context={setup.mandate.active ? 'Approved with Prava' : 'Approval required'} icon={BadgeCheck} tone="amber" />
      </div>
      <CheckoutActivityPanel flows={checkoutFlows} status={checkoutStatus} />
      <div className="dashboard-grid">
        <section className="dashboard-section recent-section">
          <div className="section-heading"><div><h2>Recent orders</h2><p>All family activity, including COD.</p></div><button className="text-button" onClick={() => setPage('assistant')}>Ask Tokko <ArrowRight size={15} /></button></div>
          {ordersStatus && !orders.length && <p className="form-message">{ordersStatus}</p>}
          <OrdersTable limit={4} orders={orders} accountName={setup.profile.name || 'Zepto account'} onSelect={() => setPage('assistant')} />
        </section>
        <aside className="dashboard-side-column">
          <section className="dashboard-section card-summary">
            <div className="section-heading"><div><h2>Family card</h2><p>{setup.card?.connected ? 'Tokenized by Prava' : 'No card saved'}</p></div><StatusPill tone={setup.card?.connected ? 'success' : 'neutral'}>{setup.card?.connected ? 'Ready' : 'Missing'}</StatusPill></div>
            <div className="card-summary-body">
              <CreditCard size={24} />
              <div><strong>{setup.card?.connected ? `${String(setup.card.brand || 'Card').toUpperCase()} •••• ${setup.card.last4}` : 'Add a payment card'}</strong><span>{setup.card?.connected ? `Expires ${setup.card.expMonth}/${setup.card.expYear}` : 'Raw card details remain inside Prava.'}</span></div>
            </div>
            <button type="button" className="button secondary-button full-button" onClick={() => setPage('card')}>{setup.card?.connected ? 'Manage cards' : 'Open Cards'}</button>
          </section>
          <section className="dashboard-section mandate-summary">
            <div className="section-heading"><div><h2>Grocery mandate</h2><p>{setup.mandate.active ? 'Active' : 'Not active'}</p></div><StatusPill tone={setup.mandate.active ? 'success' : 'neutral'}>{setup.mandate.active ? 'Active' : 'Off'}</StatusPill></div>
            <div className="mandate-amount"><strong>{formatMandateAmount(remaining, mandateCurrency)}</strong><span>remaining of {formatMandateAmount(approvedAmount, mandateCurrency)}</span></div>
            <div className="budget-bar"><span style={{ width: `${spentPercent}%` }} /></div>
            <dl className="mini-details"><div><dt>Renews</dt><dd>{setup.mandate.renewsAt ? new Date(setup.mandate.renewsAt).toLocaleDateString() : '—'}</dd></div><div><dt>Charge cap</dt><dd>{formatMandateAmount(approvedAmount, mandateCurrency)}</dd></div><div><dt>Members</dt><dd>{setup.members.filter((m) => m.selected).length}</dd></div></dl>
            <button className="button secondary-button full-button" onClick={() => setPage('mandates')}>Manage mandate</button>
          </section>
        </aside>
      </div>
    </>
  );
}

function Dashboard({
  setup,
  setSetup,
  page,
  setPage,
  onLogout,
  onConnectZepto,
  pravaMandateCallback,
  pravaCardCallback,
}) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [orders, setOrders] = useState([]);
  const [ordersBusy, setOrdersBusy] = useState(false);
  const [ordersStatus, setOrdersStatus] = useState('');
  const [lastOrdersRefreshAt, setLastOrdersRefreshAt] = useState(null);
  const [checkoutFlows, setCheckoutFlows] = useState([]);
  const [checkoutStatus, setCheckoutStatus] = useState('');

  const activePage = ['orders', 'shop'].includes(page) ? 'assistant' : page;

  const refreshFamilyState = async () => {
    const state = await api('/api/me');
    setSetup((current) => setupFromUserState(state, current));
  };

  useEffect(() => {
    if (activePage !== page) setPage(activePage);
  }, [activePage, page, setPage]);

  useEffect(() => {
    if (activePage !== 'overview') return undefined;
    let active = true;
    api('/api/payments/mandates')
      .then((result) => {
        if (!active) return;
        const visibleSummary = summarizePravaMandates(result.mandates || []);
        const apiSummary = result.summary;
        const summary = Number(apiSummary?.activeCount || 0) > 0
          ? {
              ...(visibleSummary || {}),
              count: Number(apiSummary.activeCount),
              approvedAmount: Number(apiSummary.approvedAmount || 0),
              remaining: Number(apiSummary.remaining || 0),
              currency: apiSummary.currency || visibleSummary?.currency || 'INR',
              frequency: apiSummary.frequency || visibleSummary?.frequency || 'mixed',
              renewsAt: apiSummary.renewsAt || visibleSummary?.renewsAt || null,
            }
          : visibleSummary;
        setSetup((current) => ({
          ...current,
          mandate: {
            ...current.mandate,
            active: Boolean(summary),
            id: summary?.id || null,
            ids: summary?.ids || [],
            count: summary?.count || 0,
            status: summary?.status || 'inactive',
            total: Number(summary?.approvedAmount || 0),
            remaining: Number(summary?.remaining || 0),
            currency: summary?.currency || 'INR',
            period: summary?.frequency
              ? `${summary.frequency.charAt(0).toUpperCase()}${summary.frequency.slice(1)}`
              : current.mandate.period,
            renewsAt: summary?.renewsAt || null,
          },
        }));
      })
      .catch(() => {
        // The overview remains usable when Prava is not configured.
      });
    return () => {
      active = false;
    };
  }, [activePage]);

  const refreshOrders = async ({ quiet = false } = {}) => {
    if (!setup.zeptoConnected) {
      setOrders([]);
      setOrdersStatus('Connect Zepto to load order history.');
      return;
    }
    if (!quiet) setOrdersBusy(true);
    try {
      const result = await api('/api/orders?limit=25&pageNumber=1');
      const historyOrders = parseOrderResponse(result);
      const nextOrders = await Promise.all(
        historyOrders.map(async (order) => {
          if (!order.id || TERMINAL_ORDER_STATUSES.has(order.status)) {
            return order;
          }
          try {
            const detail = normalizeOrderRecord(
              await api(`/api/orders/${encodeURIComponent(order.id)}`)
            );
            return {
              ...order,
              ...detail,
              id: detail.id || order.id,
              code: detail.code || order.code,
              products: detail.products.length
                ? detail.products
                : order.products,
              itemCount: detail.itemCount || order.itemCount,
              amountPaise:
                detail.amountPaise === null
                  ? order.amountPaise
                  : detail.amountPaise,
              placedTime: detail.placedTime || order.placedTime,
            };
          } catch {
            return order;
          }
        })
      );
      setOrders(nextOrders);
      setLastOrdersRefreshAt(new Date());
      setOrdersStatus(
        nextOrders.length
          ? `${nextOrders.length} Zepto order${nextOrders.length === 1 ? '' : 's'} loaded.`
          : 'Zepto returned no order history for this account.'
      );
    } catch (error) {
      setOrdersStatus(`Could not load Zepto orders: ${error.message}`);
    } finally {
      if (!quiet) setOrdersBusy(false);
    }
  };

  useEffect(() => {
    if (!['overview', 'alerts'].includes(activePage)) return undefined;
    refreshOrders();
    return undefined;
  }, [activePage, setup.zeptoConnected]);

  const refreshCheckoutActivity = async () => {
    try {
      const result = await api('/api/checkout/activity?limit=8');
      setCheckoutFlows(result.checkoutFlows || []);
      setCheckoutStatus('');
    } catch (error) {
      setCheckoutStatus(`Could not load checkout activity: ${error.message}`);
    }
  };

  useEffect(() => {
    if (!['overview', 'alerts'].includes(activePage)) return undefined;
    let active = true;
    api('/api/checkout/activity?limit=8')
      .then((result) => {
        if (!active) return;
        setCheckoutFlows(result.checkoutFlows || []);
        setCheckoutStatus('');
      })
      .catch((error) => {
        if (active) setCheckoutStatus(`Could not load checkout activity: ${error.message}`);
      });
    return () => {
      active = false;
    };
  }, [activePage]);

  const alerts = dashboardAlerts(setup, orders, checkoutFlows);

  return (
    <main className={`dashboard-page ${activePage === 'assistant' ? 'assistant-mode' : ''}`}>
      <DashboardSidebar page={activePage} setPage={setPage} onLogout={onLogout} alertCount={alerts.length} />
      <section className={`dashboard-main ${activePage === 'assistant' ? 'assistant-main' : ''}`}>
        <header className="dashboard-mobile-header"><Brand /><button className="icon-button" aria-label="Open menu" onClick={() => setMobileMenuOpen(true)}><ListFilter size={18} /></button></header>
        {mobileMenuOpen && <div className="mobile-menu-layer" role="presentation" onClick={() => setMobileMenuOpen(false)}><div onClick={(event) => event.stopPropagation()}><DashboardSidebar page={activePage} setPage={setPage} onLogout={onLogout} alertCount={alerts.length} mobile onNavigate={() => setMobileMenuOpen(false)} onClose={() => setMobileMenuOpen(false)} /></div></div>}
        {activePage === 'overview' ? <DashboardOverview setup={setup} setSetup={setSetup} setPage={setPage} orders={orders} ordersBusy={ordersBusy} ordersStatus={ordersStatus} checkoutFlows={checkoutFlows} checkoutStatus={checkoutStatus} onRefreshOrders={refreshOrders} onConnectZepto={onConnectZepto} /> : activePage === 'connectors' ? (
          <ConnectorsPage setup={setup} onConnectZepto={onConnectZepto} />
        ) : activePage === 'card' ? (
          <div className="subpage card-management-page">
            <CardStep setup={setup} updateSetup={setSetup} onBack={() => setPage('assistant')} onNext={() => setPage('assistant')} continueLabel="Return to Ask Tokko" />
          </div>
        ) : activePage === 'family' ? (
          <div className="subpage family-management-page">
            <FamilyStep setup={setup} updateSetup={setSetup} onBack={() => setPage('overview')} onNext={() => setPage('overview')} />
          </div>
        ) : activePage === 'assistant' ? (
          <ShopperPage
            setup={setup}
            onZeptoReconnected={refreshFamilyState}
            pravaMandateCallback={pravaMandateCallback}
            pravaCardCallback={pravaCardCallback}
          />
        ) : activePage === 'mandates' ? (
          <MandatesPage
            setup={setup}
            setSetup={setSetup}
            onAddCard={() => setPage('card')}
            callbackResult={pravaMandateCallback}
          />
        ) : activePage === 'alerts' ? (
          <AlertsPage
            setup={setup}
            orders={orders}
            checkoutFlows={checkoutFlows}
            busy={ordersBusy}
            status={ordersStatus || checkoutStatus}
            onNavigate={setPage}
            onRefresh={() => Promise.all([
              refreshOrders(),
              refreshCheckoutActivity(),
            ])}
          />
        ) : (
          <div className="subpage">
            <div className="dashboard-heading"><div><p className="eyebrow">{setup.familyName}</p><h1>{activePage.charAt(0).toUpperCase() + activePage.slice(1)}</h1><p>Manage family {activePage} and payment controls.</p></div><button className="button primary-button"><Plus size={17} /> Add new</button></div>
            <section className="empty-working-state"><div><PackageCheck size={28} /></div><h2>{activePage.charAt(0).toUpperCase() + activePage.slice(1)} are ready</h2><p>This area is connected to the onboarding settings in the prototype.</p><button className="button secondary-button" onClick={() => setPage('overview')}><ArrowLeft size={16} /> Back to overview</button></section>
          </div>
        )}
      </section>
    </main>
  );
}

function App() {
  const [setup, setSetup] = usePersistentSetup();
  const [view, setView] = usePersistentState('tokko-view', 'entry');
  const [onboardingStep, setOnboardingStep] = usePersistentState('tokko-onboarding-step', 0);
  const [dashboardPage, setDashboardPage] = usePersistentState('tokko-dashboard-page', 'overview');
  const [entryScreen, setEntryScreen] = usePersistentState('tokko-entry-screen', 0);
  const [authResolved, setAuthResolved] = useState(false);
  const [zeptoConnectOpen, setZeptoConnectOpen] = useState(false);
  const [pravaMandateCallback, setPravaMandateCallback] = useState(null);
  const [pravaCardCallback, setPravaCardCallback] = useState(null);

  useEffect(() => {
    let active = true;
    const returnUrl = new URL(window.location.href);
    const callbackFromUrl = returnUrl.searchParams.get('pravaCallback');
    if (callbackFromUrl) {
      sessionStorage.setItem('tokko-prava-mandate-callback', callbackFromUrl);
    }
    const mandateCallbackId =
      callbackFromUrl
      || sessionStorage.getItem('tokko-prava-mandate-callback');
    const returningFromPravaCardUrl =
      returnUrl.searchParams.get('pravaCard') === 'return';
    const orderFromUrl = returnUrl.searchParams.get('ucpOrder');
    if (returningFromPravaCardUrl && /^[0-9a-f-]{36}$/i.test(String(orderFromUrl || ''))) {
      sessionStorage.setItem('tokko-prava-card-order', orderFromUrl);
    }
    const pendingCardOrder =
      orderFromUrl
      || sessionStorage.getItem('tokko-prava-card-order');
    const returningFromPravaCard =
      returningFromPravaCardUrl
      || /^[0-9a-f-]{36}$/i.test(String(pendingCardOrder || ''));
    const returningFromPravaMandate =
      returnUrl.searchParams.get('pravaMandate') === 'return'
      || Boolean(mandateCallbackId);
    const returningFromPrava = returningFromPravaCard || returningFromPravaMandate;
    if (returningFromPrava) {
      const requestedPage = returnUrl.searchParams.get('pravaReturnPage');
      setView('dashboard');
      setDashboardPage(
        ['assistant', 'card', 'mandates'].includes(requestedPage)
          ? requestedPage
          : pendingCardOrder
            ? 'assistant'
            : returningFromPravaMandate
              ? (returnUrl.searchParams.get('ucpOrder') ? 'assistant' : 'mandates')
              : 'card'
      );
      returnUrl.searchParams.delete('pravaCard');
      returnUrl.searchParams.delete('pravaMandate');
      returnUrl.searchParams.delete('pravaReturnPage');
      returnUrl.searchParams.delete('ucpOrder');
      returnUrl.searchParams.delete('pravaCallback');
      window.history.replaceState(
        {},
        '',
        `${returnUrl.pathname}${returnUrl.search}${returnUrl.hash}`
      );
    }
    api('/api/me')
      .then(async (state) => {
        if (!active) return;
        setSetup((current) => setupFromUserState(state, current));
        if (
          state.profileComplete &&
          (returningFromPrava || ['login', 'entry'].includes(view))
        ) {
          setView('dashboard');
        }
        if (mandateCallbackId) {
          let callbackError = null;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              const result = await api('/api/payments/mandates/callback/complete', {
                method: 'POST',
                body: { callbackId: mandateCallbackId },
              });
              if (!active) return;
              setPravaMandateCallback(result);
              sessionStorage.removeItem('tokko-prava-mandate-callback');
              callbackError = null;
              break;
            } catch (error) {
              callbackError = error;
              if (error.status !== 409 || attempt === 2) break;
              await new Promise((resolve) => window.setTimeout(resolve, 1200));
            }
          }
          if (active && callbackError) {
            setPravaMandateCallback({
              callbackId: mandateCallbackId,
              status: 'pending',
              error: callbackError.message,
            });
            if (callbackError.status === 404) {
              sessionStorage.removeItem('tokko-prava-mandate-callback');
            }
          }
        }
        if (
          returningFromPravaCard
          && /^[0-9a-f-]{36}$/i.test(String(pendingCardOrder || ''))
        ) {
          let cardResult = null;
          let cardError = null;
          for (let attempt = 0; attempt < 5; attempt += 1) {
            try {
              cardResult = await api(
                `/api/merchants/ucp/orders/${encodeURIComponent(pendingCardOrder)}/payment/continue`,
                { method: 'POST', body: {} }
              );
              cardError = null;
              if (cardResult.tokenIssued) break;
              if (attempt < 4) {
                await new Promise((resolve) => window.setTimeout(resolve, 1200));
              }
            } catch (error) {
              cardError = error;
              break;
            }
          }
          if (!active) return;
          setPravaCardCallback(cardError
            ? { orderId: pendingCardOrder, error: cardError.message }
            : { orderId: pendingCardOrder, ...cardResult });
          if (cardResult?.tokenIssued || cardError?.status === 404) {
            sessionStorage.removeItem('tokko-prava-card-order');
          }
        }
      })
      .catch(() => {
        if (!active) return;
        if (!['entry', 'login'].includes(view)) setView('login');
      })
      .finally(() => {
        if (active) setAuthResolved(true);
      });
    if (
      !returningFromPrava &&
      localStorage.getItem('tokko-flow-version') !== FLOW_VERSION
    ) {
      localStorage.setItem('tokko-flow-version', FLOW_VERSION);
      setEntryScreen(0);
      setView('entry');
    }
    return () => {
      active = false;
    };
  }, []);

  const goToZepto = () => setZeptoConnectOpen(true);
  const authenticated = (state) => {
    setSetup((current) => setupFromUserState(state, current));
    if (state.profileComplete) {
      setView('dashboard');
    } else {
      setOnboardingStep(0);
      setView('onboarding');
    }
  };
  const logout = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      localStorage.removeItem('tokko-setup');
      sessionStorage.removeItem(SHOPPER_SESSION_MESSAGES_KEY);
      sessionStorage.removeItem(SHOPPER_SESSION_ADDRESS_KEY);
      sessionStorage.removeItem('tokko-prava-mandate-callback');
      setSetup(initialSetup);
      setView('login');
    }
  };
  const connectedToZepto = async (phone) => {
    try {
      const state = await api('/api/me');
      setSetup((current) => setupFromUserState(state, {
        ...current,
        zeptoConnected: true,
        zeptoPhone: phone,
      }));
    } finally {
      setZeptoConnectOpen(false);
    }
  };

  if (!authResolved) {
    return <main className="app-loading"><Brand /><span>Preparing your shopper…</span></main>;
  }

  let content;
  if (view === 'entry') {
    content = <Entry initialScreen={Number(entryScreen)} onScreenChange={setEntryScreen} onEnter={() => setView('login')} />;
  } else if (view === 'login') {
    content = <Login onAuthenticated={authenticated} onBack={() => { setEntryScreen(1); setView('entry'); }} />;
  } else if (view === 'dashboard') {
    content = <Dashboard setup={setup} setSetup={setSetup} page={dashboardPage} setPage={setDashboardPage} onLogout={logout} onConnectZepto={goToZepto} pravaMandateCallback={pravaMandateCallback} pravaCardCallback={pravaCardCallback} />;
  } else {
    content = <Onboarding setup={setup} setSetup={setSetup} stepIndex={Number(onboardingStep) || 0} setStepIndex={setOnboardingStep} onExit={logout} onZeptoConnect={goToZepto} onFinish={() => setView('dashboard')} />;
  }

  return (
    <>
      {content}
      {zeptoConnectOpen && (
        <ZeptoConnect
          setup={setup}
          updateSetup={setSetup}
          onCancel={() => setZeptoConnectOpen(false)}
          onConnected={connectedToZepto}
        />
      )}
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
