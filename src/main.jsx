import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity, ArrowLeft, ArrowRight, Bell, Check, CheckCircle2, ChevronRight,
  CircleDollarSign, Clock3, CreditCard, Fingerprint, HeartPulse, Home,
  LoaderCircle, LogOut, MapPin, MessageCircle, Moon, MoreHorizontal, Pencil,
  Plus, Receipt, RefreshCw, Send, Settings, ShieldCheck, ShoppingBag, Smartphone,
  Sparkles, Sun, Trash2, Users, X,
} from 'lucide-react';
import { api, normalizeLocalPhone, phoneParts, toE164 } from './api';
import './trakko/trakko-mobile.css';
import './functional.css';

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
const COUNTRY_CODES = [['+91', 'India +91'], ['+1', 'US / Canada +1'], ['+44', 'UK +44'], ['+61', 'Australia +61'], ['+65', 'Singapore +65'], ['+971', 'UAE +971']];
const RELATIONSHIPS = ['Mother', 'Father', 'Spouse', 'Child', 'Son', 'Daughter', 'Sibling', 'Grandparent', 'Other'];
const CATEGORIES = [['medicines', 'Medicines'], ['wellness', 'Wellness'], ['personal_care', 'Personal care'], ['devices', 'Health devices'], ['nutrition', 'Nutrition']];
let clerkBrowserPromise = null;

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
    clerkBrowserPromise = api('/api/config').then(async (config) => {
      if (!config.signupEmailVerificationConfigured || !config.clerkPublishableKey) throw new Error('Email verification is not configured on this deployment.');
      const { Clerk } = await import('@clerk/clerk-js');
      const clerk = new Clerk(config.clerkPublishableKey);
      await clerk.load({ appearance: { captcha: { theme: 'light', size: 'flexible', language: 'en-US' } } });
      return clerk;
    }).catch((error) => { clerkBrowserPromise = null; throw error; });
  }
  return clerkBrowserPromise;
}
async function startClerkEmailVerification(email, password) {
  if (window.__tokkoClerkEmail) return window.__tokkoClerkEmail.start({ email, password });
  const clerk = await browserClerk();
  const normalizedEmail = email.trim().toLowerCase();
  const currentSignUp = clerk.client.signUp;
  if (currentSignUp?.id && currentSignUp.emailAddress?.trim().toLowerCase() === normalizedEmail && (currentSignUp.status === 'complete' || clerkEmailIsVerified(currentSignUp))) return { signUpId: currentSignUp.id, alreadyVerified: true };
  try {
    const signUp = await clerk.client.signUp.create({ emailAddress: normalizedEmail, password });
    await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
    return { signUpId: signUp.id };
  } catch (error) { throw new Error(clerkErrorMessage(error)); }
}
async function verifyClerkEmail(signUpId, code) {
  if (window.__tokkoClerkEmail) {
    try { return await window.__tokkoClerkEmail.verify({ signUpId, code }); }
    catch (error) { if (clerkVerificationAlreadyComplete(error)) return { signUpId }; throw new Error(clerkErrorMessage(error)); }
  }
  const clerk = await browserClerk();
  const signUp = clerk.client.signUp;
  if (!signUp?.id || signUp.id !== signUpId) throw new Error('This signup attempt expired. Request a new code.');
  if (signUp.status === 'complete' || clerkEmailIsVerified(signUp)) return { signUpId: signUp.id };
  try {
    const verified = await signUp.attemptEmailAddressVerification({ code });
    if (verified.status !== 'complete' && !clerkEmailIsVerified(verified)) throw new Error('Clerk did not verify this email code.');
    return { signUpId: verified.id };
  } catch (error) { if (clerkVerificationAlreadyComplete(error)) return { signUpId }; throw new Error(clerkErrorMessage(error)); }
}
async function startGoogleOAuth() {
  const clerk = await browserClerk();
  const origin = window.location.origin;
  try {
    await clerk.client.signIn.authenticateWithRedirect({ strategy: 'oauth_google', redirectUrl: `${origin}/sso-callback`, redirectUrlComplete: `${origin}/?clerk_oauth=complete` });
  } catch (error) { throw new Error(clerkErrorMessage(error)); }
}
async function completeGoogleOAuthCallback() {
  const clerk = await browserClerk();
  const completeUrl = `${window.location.origin}/?clerk_oauth=complete`;
  await clerk.handleRedirectCallback({ signInFallbackRedirectUrl: completeUrl, signUpFallbackRedirectUrl: completeUrl, signInForceRedirectUrl: completeUrl, signUpForceRedirectUrl: completeUrl });
}
async function exchangeClerkSession() {
  const clerk = await browserClerk();
  const token = await clerk.session?.getToken();
  if (!token) throw new Error('Google sign-in did not create an active session. Please try again.');
  await api('/api/auth/clerk/session', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  const state = await api('/api/me');
  state.clerkDisplayName = clerk.user?.fullName || clerk.user?.firstName || '';
  return state;
}

function Brand({ compact = false }) {
  return <div className={`tokko-brand ${compact ? 'is-compact' : ''}`}><span className="tokko-mark">t</span><span><strong>Tokko</strong>{!compact && <small>Your family care agent</small>}</span></div>;
}
function ThemeButton({ theme, onToggle }) {
  return <button className="tokko-icon-button" type="button" onClick={onToggle} aria-label={`Use ${theme === 'light' ? 'dark' : 'light'} mode`}>{theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}</button>;
}
function LogoMarquee() {
  return <div className="tokko-logo-marquee" aria-label="Health and wellness merchant network"><div className="tokko-logo-track">{[...MERCHANTS, ...MERCHANTS].map(([name, src], index) => { const duplicate = index >= MERCHANTS.length; return <figure className="tokko-logo-tile" aria-hidden={duplicate || undefined} key={`${name}-${index}`}><img src={src} alt={duplicate ? '' : `${name} logo`} /></figure>; })}</div></div>;
}
function BusyIcon({ busy, icon: Icon = ArrowRight }) {
  return busy ? <LoaderCircle className="tokko-spinner" size={18} /> : <Icon size={18} />;
}
function Status({ value }) {
  if (!value?.message) return null;
  return <p className={`tf-status ${value.type === 'error' ? 'is-error' : value.type === 'success' ? 'is-success' : ''}`} role={value.type === 'error' ? 'alert' : 'status'}>{value.message}</p>;
}

function MessagingConnect() {
  const [bot, setBot] = useState(null);
  useEffect(() => { api('/api/config').then((config) => setBot(config.telegramBotUsername || null)).catch(() => {}); }, []);
  const telegramHref = bot ? `https://t.me/${bot}` : null;
  return <div className="tf-messaging-connect">
    <div className="tf-messaging-head"><span className="tf-messaging-icon"><MessageCircle size={17} /></span><div><strong>Connect your messaging</strong><small>Tokko lives where your family already chats. Link a channel, then sign in to save it.</small></div></div>
    <div className="tf-channel-list">
      {telegramHref
        ? <a className="tf-channel is-telegram" href={telegramHref} target="_blank" rel="noreferrer"><span className="tf-channel-icon"><Send size={18} /></span><div><strong>Telegram</strong><small>Open the Tokko bot to link your chat</small></div><ArrowRight size={16} /></a>
        : <div className="tf-channel is-telegram" aria-disabled="true"><span className="tf-channel-icon"><Send size={18} /></span><div><strong>Telegram</strong><small>Sign in first, then link your chat</small></div><ArrowRight size={16} /></div>}
      <div className="tf-channel is-imessage" aria-disabled="true"><span className="tf-channel-icon"><Smartphone size={18} /></span><div><strong>iMessage</strong><small>On the roadmap</small></div><span className="tf-soon-badge">Soon</span></div>
    </div>
  </div>;
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
  const statusIsProgress = /sent to|signing|verifying|sending|opening/i.test(status);
  const changeMode = (nextMode) => { setMode(nextMode); setSignupChallenge(null); setEmailOtp(''); setStatus(''); };
  const signInWithGoogle = async () => {
    setBusy(true); setStatus('Opening secure Google sign-in…');
    try { await startGoogleOAuth(); } catch (error) { setStatus(error.message); setBusy(false); }
  };
  const submit = async (event) => {
    event.preventDefault(); setBusy(true);
    setStatus(verifyingSignup ? 'Verifying your email…' : mode === 'signup' ? 'Sending a verification code…' : 'Signing in…');
    try {
      if (verifyingSignup) {
        const verified = await verifyClerkEmail(signupChallenge.clerkSignUpId, emailOtp);
        await api('/api/auth/signup/verify', { method: 'POST', body: { challengeId: signupChallenge.challengeId, email, clerkSignUpId: verified.signUpId } });
      } else if (mode === 'signup') {
        const normalizedEmail = email.trim().toLowerCase();
        const pending = pendingChallengeRef.current;
        const challenge = pending?.email === normalizedEmail && pending?.password === password ? pending.result : await api('/api/auth/signup', { method: 'POST', body: { email, password } });
        pendingChallengeRef.current = { email: normalizedEmail, password, result: challenge };
        const prepared = await startClerkEmailVerification(email, password);
        if (prepared.alreadyVerified) {
          await api('/api/auth/signup/verify', { method: 'POST', body: { challengeId: challenge.challengeId, email, clerkSignUpId: prepared.signUpId } });
          pendingChallengeRef.current = null;
        } else {
          setSignupChallenge({ ...challenge, clerkSignUpId: prepared.signUpId }); pendingChallengeRef.current = null; setEmailOtp(''); setStatus(`A six-digit code was sent to ${challenge.email || email}.`); return;
        }
      } else await api('/api/auth/login', { method: 'POST', body: { email, password } });
      onAuthenticated(await api('/api/me')); setStatus('');
    } catch (error) { setStatus(error.message); }
    finally { setBusy(false); }
  };
  return <form className="tokko-auth-form" onSubmit={submit}>
    <button className="tokko-google-button" type="button" onClick={signInWithGoogle} disabled={busy}><span className="tokko-google-mark" aria-hidden="true"><img src="/assets/google-g.svg" alt="" /></span>Continue with Google<BusyIcon busy={busy} /></button>
    <div className="tokko-auth-divider"><span>or use email</span></div>
    <div className="tokko-auth-modes" aria-label="Account access method"><button className={mode === 'login' ? 'is-active' : ''} type="button" aria-pressed={mode === 'login'} onClick={() => changeMode('login')}>Sign in</button><button className={mode === 'signup' ? 'is-active' : ''} type="button" aria-pressed={mode === 'signup'} onClick={() => changeMode('signup')}>Create account</button></div>
    <div className="tokko-auth-fields"><label><span>Email</span><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required disabled={verifyingSignup} /></label>{!verifyingSignup && <label><span>Password</span><input type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === 'signup' ? 'At least 10 characters' : 'Your password'} minLength={10} required /></label>}{verifyingSignup && <label><span>Six-digit code</span><input inputMode="numeric" autoComplete="one-time-code" value={emailOtp} onChange={(event) => setEmailOtp(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="123456" pattern="[0-9]{6}" required autoFocus /></label>}</div>
    <button className="tokko-button tokko-button-primary tokko-auth-submit" type="submit" disabled={busy}><BusyIcon busy={busy} icon={ShieldCheck} />{verifyingSignup ? 'Verify and continue' : mode === 'signup' ? 'Create secure account' : 'Sign in to Tokko'}{!busy && <ArrowRight size={17} />}</button>
    <div id="clerk-captcha" />
    {status && <p className={statusIsProgress ? 'tokko-form-status' : 'tokko-form-status is-error'} role={statusIsProgress ? 'status' : 'alert'} aria-live={statusIsProgress ? 'polite' : 'assertive'}>{status}</p>}
    <div className="tokko-safe-note"><ShieldCheck size={16} /><span>Google identity stays with Clerk. Tokko uses an HttpOnly session and never stores your password in the browser.</span></div>
  </form>;
}

function Modal({ open, onClose, titleId, children, className = '' }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    const focusable = () => [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]')];
    focusable()[0]?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab') return;
      const nodes = focusable();
      if (!nodes.length) return;
      const first = nodes[0]; const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); previous?.focus?.(); };
  }, [open, onClose]);
  if (!open) return null;
  return <div className="tf-modal-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section ref={dialogRef} className={`tf-modal ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>{children}</section></div>;
}

function ConfirmDialog({ open, title, copy, confirmLabel, destructive = false, onConfirm, onClose }) {
  return <Modal open={open} onClose={onClose} titleId="confirm-title" className="tf-confirm"><span className={`tf-modal-symbol ${destructive ? 'is-danger' : ''}`}>{destructive ? <Trash2 /> : <ShieldCheck />}</span><h2 id="confirm-title">{title}</h2><p>{copy}</p><div className="tf-modal-actions"><button className="tokko-button tokko-button-ghost" type="button" onClick={onClose}>Cancel</button><button className={`tokko-button ${destructive ? 'tf-danger-button' : 'tokko-button-primary'}`} type="button" onClick={onConfirm}>{confirmLabel}</button></div></Modal>;
}

function newMember() { return { clientId: window.crypto.randomUUID(), name: '', relationship: '', otherRelationship: '', countryCode: '+91', localPhone: '', age: '' }; }
function memberFromApi(member) {
  const relation = member.relationshipToUser || '';
  const standard = RELATIONSHIPS.includes(relation);
  return { id: member.id, clientId: `member-${member.id}`, name: member.name || '', relationship: standard ? relation : 'Other', otherRelationship: standard ? '' : relation, ...phoneParts(member.phone), age: member.age ?? '' };
}
function memberPayload(member) {
  return { ...(member.id ? { id: member.id } : {}), name: member.name.trim(), relationshipToUser: member.relationship, ...(member.relationship === 'Other' ? { otherRelationship: member.otherRelationship.trim() } : {}), countryCode: member.countryCode, localPhone: normalizeLocalPhone(member.countryCode, member.localPhone), age: member.age === '' ? null : Number(member.age) };
}
function initials(name = '') { return name.split(/\s+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase() || 'F'; }

function MemberDialog({ open, initial, canRemove, onSave, onRemove, onClose }) {
  const [member, setMember] = useState(initial || newMember());
  useEffect(() => { if (open) setMember(initial || newMember()); }, [open, initial]);
  const valid = member.name.trim() && member.relationship && (member.relationship !== 'Other' || member.otherRelationship.trim()) && normalizeLocalPhone(member.countryCode, member.localPhone).length >= 7 && (member.age === '' || (Number.isInteger(Number(member.age)) && Number(member.age) >= 0 && Number(member.age) <= 120));
  return <Modal open={open} onClose={onClose} titleId="member-dialog-title">
    <button className="tf-modal-close" type="button" onClick={onClose} aria-label="Close"><X size={19} /></button>
    <span className="tokko-panel-kicker"><Users size={15} /> Family circle</span><h2 id="member-dialog-title">{initial ? `Edit ${initial.name}` : 'Add someone Tokko can help'}</h2><p>Messages from this number will be recognised as this person. Age is optional.</p>
    <div className="tf-form-grid"><label className="tf-wide"><span>Name</span><input value={member.name} onChange={(event) => setMember({ ...member, name: event.target.value })} placeholder="Asha Mehta" required /></label><label><span>Relationship</span><select value={member.relationship} onChange={(event) => setMember({ ...member, relationship: event.target.value })} required><option value="">Choose one</option>{RELATIONSHIPS.map((item) => <option key={item}>{item}</option>)}</select></label>{member.relationship === 'Other' && <label><span>How are they related?</span><input value={member.otherRelationship} onChange={(event) => setMember({ ...member, otherRelationship: event.target.value })} placeholder="Aunt" required /></label>}<label className="tf-phone-field"><span>Messaging number</span><span className="tf-phone-input"><select aria-label="Country calling code" value={member.countryCode} onChange={(event) => setMember({ ...member, countryCode: event.target.value })}>{COUNTRY_CODES.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><input inputMode="tel" autoComplete="tel" value={member.localPhone} onChange={(event) => setMember({ ...member, localPhone: event.target.value })} placeholder="98765 43210" required /></span></label><details className="tf-optional tf-wide"><summary>Optional context</summary><div><label><span>Age</span><input inputMode="numeric" value={member.age} onChange={(event) => setMember({ ...member, age: event.target.value.replace(/\D/g, '').slice(0, 3) })} placeholder="67" /></label></div></details></div>
    <div className="tf-modal-actions tf-split-actions">{canRemove ? <button className="tf-text-danger" type="button" onClick={onRemove}><Trash2 size={16} /> Remove</button> : <span />}<div><button className="tokko-button tokko-button-ghost" type="button" onClick={onClose}>Cancel</button><button className="tokko-button tokko-button-primary" type="button" disabled={!valid} onClick={() => onSave(member)}>{initial ? 'Save member' : 'Add member'} <Check size={17} /></button></div></div>
  </Modal>;
}

function FamilyEditor({ state, displayName, submitLabel, onSaved }) {
  const [ownerName, setOwnerName] = useState(state.profile?.primaryParentName || displayName || '');
  const ownerParts = phoneParts(state.profile?.primaryParentPhone || '');
  const [ownerPhone, setOwnerPhone] = useState({ countryCode: ownerParts.countryCode, localPhone: ownerParts.localPhone });
  const [members, setMembers] = useState((state.profile?.dependents || []).map(memberFromApi));
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setOwnerName(state.profile?.primaryParentName || displayName || '');
    setOwnerPhone(phoneParts(state.profile?.primaryParentPhone || ''));
    setMembers((state.profile?.dependents || []).map(memberFromApi));
  }, [state.profile, displayName]);
  const saveMember = (member) => { setMembers((current) => editing?.index === undefined ? [...current, member] : current.map((item, index) => index === editing.index ? member : item)); setEditing(null); };
  const submit = async () => {
    if (!ownerName.trim()) return setStatus({ type: 'error', message: 'Tell Tokko what to call you.' });
    if (!members.length) return setStatus({ type: 'error', message: 'Add at least one family member.' });
    const phones = members.map((member) => toE164(member.countryCode, normalizeLocalPhone(member.countryCode, member.localPhone)));
    if (new Set(phones).size !== phones.length) return setStatus({ type: 'error', message: 'Each family member needs a different phone number.' });
    const ownerLocal = normalizeLocalPhone(ownerPhone.countryCode, ownerPhone.localPhone);
    if (ownerLocal && phones.includes(toE164(ownerPhone.countryCode, ownerLocal))) return setStatus({ type: 'error', message: 'Your phone and a family member cannot share a number.' });
    setBusy(true); setStatus({ message: 'Saving your family circle…' });
    try {
      const normalizedOwnerPhone = normalizeLocalPhone(ownerPhone.countryCode, ownerPhone.localPhone);
      const next = await api('/api/onboarding/profile', { method: 'PUT', body: { primaryParentName: ownerName.trim(), ...(normalizedOwnerPhone ? { primaryParentCountryCode: ownerPhone.countryCode, primaryParentLocalPhone: normalizedOwnerPhone } : {}), dependents: members.map(memberPayload) } });
      setStatus({ type: 'success', message: 'Family circle saved.' }); onSaved(next);
    } catch (error) { setStatus({ type: 'error', message: error.message }); }
    finally { setBusy(false); }
  };
  return <>
    <div className="tf-card tf-owner-card"><span className="tf-card-icon"><Fingerprint size={20} /></span><label><span>What should Tokko call you?</span><input value={ownerName} onChange={(event) => setOwnerName(event.target.value)} placeholder="Your name" /></label><small>{state.account?.email} · secure account owner</small><details><summary>Add my phone for account alerts <em>optional</em></summary><span className="tf-phone-input"><select aria-label="Your country calling code" value={ownerPhone.countryCode} onChange={(event) => setOwnerPhone({ ...ownerPhone, countryCode: event.target.value })}>{COUNTRY_CODES.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><input inputMode="tel" value={ownerPhone.localPhone} onChange={(event) => setOwnerPhone({ ...ownerPhone, localPhone: event.target.value })} placeholder="98765 43210" /></span></details></div>
    <div className="tf-section-heading"><div><h2>Your care circle</h2><p>The people who can message Tokko for help.</p></div><button className="tf-small-button" type="button" onClick={() => setEditing({ index: undefined, member: null })}><Plus size={16} /> Add</button></div>
    <div className="tf-member-list">{members.map((member, index) => <button className="tf-member-card" type="button" key={member.clientId} onClick={() => setEditing({ index, member })}><span className="tf-avatar">{initials(member.name)}</span><span><strong>{member.name}</strong><small>{member.relationship === 'Other' ? member.otherRelationship : member.relationship} · {member.countryCode} {member.localPhone}</small></span><span className="tf-ready"><MessageCircle size={13} /> Ready</span><Pencil size={15} /></button>)}{!members.length && <div className="tf-empty-inline"><Users size={24} /><p>No family members yet. Add the first person Tokko should recognise.</p></div>}</div>
    <Status value={status} /><button className="tokko-button tokko-button-primary tf-main-action" type="button" onClick={submit} disabled={busy}><span>{submitLabel}</span><BusyIcon busy={busy} /></button>
    <MemberDialog open={Boolean(editing)} initial={editing?.member} canRemove={editing?.index !== undefined} onClose={() => setEditing(null)} onSave={saveMember} onRemove={() => { setRemoving(editing); setEditing(null); }} />
    <ConfirmDialog open={Boolean(removing)} title={`Remove ${removing?.member?.name || 'this member'}?`} copy="Their history stays in the audit trail, but their number will no longer be able to make new Tokko requests." confirmLabel="Remove member" destructive onClose={() => setRemoving(null)} onConfirm={() => { setMembers((current) => current.filter((_, index) => index !== removing.index)); setRemoving(null); }} />
  </>;
}

function blankAddress(state) {
  const selected = state.profile?.dependents?.[0];
  const parts = phoneParts(selected?.phone || '');
  return { label: 'Home', addressLine1: '', addressLine2: '', city: '', state: '', postalCode: '', countryCode: 'IN', contactName: selected?.name || state.profile?.primaryParentName || '', contactCountryCode: parts.countryCode, contactLocalPhone: parts.localPhone, memberIds: (state.profile?.dependents || []).map((member) => String(member.id)) };
}
function addressFromApi(address) {
  const parts = phoneParts(address.contactPhone || '');
  return { ...address, contactCountryCode: parts.countryCode, contactLocalPhone: parts.localPhone, memberIds: address.memberIds || [] };
}
function AddressDialog({ open, state, initial, onClose, onSaved }) {
  const [address, setAddress] = useState(blankAddress(state));
  const [status, setStatus] = useState(null); const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setAddress(initial ? addressFromApi(initial) : blankAddress(state)); setStatus(null); } }, [open, initial, state]);
  const chooseMember = (member) => setAddress((current) => {
    const key = String(member.id);
    const assigned = current.memberIds.includes(key);
    const isContact = assigned && (current.contactName || '').trim() === (member.name || '').trim();
    if (isContact) { return { ...current, memberIds: current.memberIds.filter((item) => item !== key) }; }
    const parts = phoneParts(member.phone || '');
    return { ...current, memberIds: assigned ? current.memberIds : [...current.memberIds, key], contactName: member.name || current.contactName, contactCountryCode: parts.countryCode || current.contactCountryCode, contactLocalPhone: parts.localPhone || current.contactLocalPhone };
  });
  const submit = async (event) => {
    event.preventDefault(); setBusy(true); setStatus({ message: 'Saving delivery details…' });
    try {
      const body = { ...address, contactPhone: toE164(address.contactCountryCode, normalizeLocalPhone(address.contactCountryCode, address.contactLocalPhone)) };
      const result = await api(initial ? `/api/addresses/${initial.id}` : '/api/addresses', { method: initial ? 'PUT' : 'POST', body });
      onSaved(result); onClose();
    } catch (error) { setStatus({ type: 'error', message: error.message }); }
    finally { setBusy(false); }
  };
  return <Modal open={open} onClose={onClose} titleId="address-dialog-title"><button className="tf-modal-close" type="button" onClick={onClose} aria-label="Close"><X size={19} /></button><span className="tokko-panel-kicker"><MapPin size={15} /> Delivery</span><h2 id="address-dialog-title">{initial ? 'Edit delivery address' : 'Add a delivery address'}</h2><p>Country and contact number are required for delivery, not for your account profile.</p><form onSubmit={submit}><div className="tf-form-grid"><label><span>Label</span><select value={address.label} onChange={(event) => setAddress({ ...address, label: event.target.value })}><option>Home</option><option>Work</option><option>Parents</option><option>Other</option></select></label><label><span>Country</span><select value={address.countryCode} onChange={(event) => setAddress({ ...address, countryCode: event.target.value })}><option value="IN">India</option><option value="US">United States</option><option value="GB">United Kingdom</option><option value="SG">Singapore</option><option value="AE">United Arab Emirates</option></select></label><label className="tf-wide"><span>Address line</span><input value={address.addressLine1 || ''} onChange={(event) => setAddress({ ...address, addressLine1: event.target.value })} placeholder="12 Park Street" required /></label><label className="tf-wide"><span>Apartment, building, landmark <em>optional</em></span><input value={address.addressLine2 || ''} onChange={(event) => setAddress({ ...address, addressLine2: event.target.value })} placeholder="Flat 4B, near the park" /></label><label><span>City</span><input value={address.city || ''} onChange={(event) => setAddress({ ...address, city: event.target.value })} required /></label><label><span>State / region</span><input value={address.state || ''} onChange={(event) => setAddress({ ...address, state: event.target.value })} required /></label><label><span>Postal code</span><input value={address.postalCode || ''} onChange={(event) => setAddress({ ...address, postalCode: event.target.value })} required /></label><label><span>Delivery contact</span><input value={address.contactName || ''} onChange={(event) => setAddress({ ...address, contactName: event.target.value })} required /></label><label className="tf-phone-field tf-wide"><span>Contact number</span><span className="tf-phone-input"><select aria-label="Contact country calling code" value={address.contactCountryCode} onChange={(event) => setAddress({ ...address, contactCountryCode: event.target.value })}>{COUNTRY_CODES.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><input inputMode="tel" value={address.contactLocalPhone} onChange={(event) => setAddress({ ...address, contactLocalPhone: event.target.value })} required /></span></label></div><fieldset className="tf-member-assignment"><legend>Who uses this address? <em>tap to set the delivery contact</em></legend>{(state.profile?.dependents || []).map((member) => { const assigned = address.memberIds.includes(String(member.id)); const isContact = assigned && (address.contactName || '').trim() === (member.name || '').trim(); return <label key={member.id} className={isContact ? 'is-contact' : ''}><input type="checkbox" checked={assigned} onChange={() => chooseMember(member)} /><span className="tf-avatar is-small">{initials(member.name)}</span><span>{member.name}</span>{isContact && <Check size={13} />}</label>; })}</fieldset><Status value={status} /><div className="tf-modal-actions"><button className="tokko-button tokko-button-ghost" type="button" onClick={onClose}>Cancel</button><button className="tokko-button tokko-button-primary" type="submit" disabled={busy}>Save address <BusyIcon busy={busy} icon={Check} /></button></div></form></Modal>;
}

function AddressManager({ state, onState, onboarding = false, onContinue }) {
  const [editing, setEditing] = useState(null); const [deleting, setDeleting] = useState(null); const [status, setStatus] = useState(null); const [busyId, setBusyId] = useState(null);
  const addresses = state.addresses || [];
  const refreshState = async () => { const next = await api('/api/me'); onState(next); return next; };
  const select = async (id) => { setBusyId(id); setStatus(null); try { await api('/api/addresses/select', { method: 'POST', body: { addressId: id } }); await refreshState(); } catch (error) { setStatus({ type: 'error', message: error.message }); } finally { setBusyId(null); } };
  const remove = async () => { setBusyId(deleting.id); try { await api(`/api/addresses/${deleting.id}`, { method: 'DELETE' }); await refreshState(); setDeleting(null); } catch (error) { setStatus({ type: 'error', message: error.message }); } finally { setBusyId(null); } };
  return <><div className="tf-section-heading"><div><h2>{onboarding ? 'Where should care arrive?' : 'Delivery addresses'}</h2><p>Choose a default and assign addresses to the people who use them.</p></div><button className="tf-small-button" type="button" onClick={() => setEditing({ initial: null })}><Plus size={16} /> Add</button></div><div className="tf-address-list">{addresses.map((address) => <article className={`tf-address-card ${address.selected ? 'is-selected' : ''}`} key={address.id}><span className="tf-card-icon"><MapPin size={19} /></span><div><span className="tf-address-title"><strong>{address.label}</strong>{address.selected && <em><Check size={12} /> Default</em>}</span><p>{address.formattedAddress}</p><small>{address.contactName} · {address.contactPhone}{address.memberIds?.length ? ` · ${address.memberIds.length} member${address.memberIds.length === 1 ? '' : 's'}` : ''}</small></div><div className="tf-card-menu">{!address.selected && <button type="button" onClick={() => select(address.id)} disabled={busyId === address.id}>Make default</button>}<button type="button" onClick={() => setEditing({ initial: address })} aria-label={`Edit ${address.label}`}><Pencil size={16} /></button><button type="button" onClick={() => setDeleting(address)} aria-label={`Remove ${address.label}`}><Trash2 size={16} /></button></div></article>)}{!addresses.length && <div className="tf-empty-state"><span><MapPin size={27} /></span><h3>No delivery address yet</h3><p>Add the first place Tokko can send an approved order.</p><button className="tokko-button tokko-button-primary" type="button" onClick={() => setEditing({ initial: null })}>Add address <Plus size={17} /></button></div>}</div><Status value={status} />{onboarding && <button className="tokko-button tokko-button-primary tf-main-action" type="button" disabled={!state.selectedAddress} onClick={onContinue}>Continue to safe spending <ArrowRight size={18} /></button>}<AddressDialog open={Boolean(editing)} state={state} initial={editing?.initial} onClose={() => setEditing(null)} onSaved={async () => { await refreshState(); setStatus({ type: 'success', message: 'Delivery address saved.' }); }} /><ConfirmDialog open={Boolean(deleting)} title={`Remove ${deleting?.label || 'this address'}?`} copy="Existing activity stays visible. Tokko will choose another saved address as default if needed." confirmLabel="Remove address" destructive onClose={() => setDeleting(null)} onConfirm={remove} /></>;
}

function money(value, currency = 'INR') { if (value === null || value === undefined || value === '') return '—'; try { return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(value)); } catch { return `${currency} ${value}`; } }
function paymentUrl(result) { return result?.approvalUrl || result?.url || null; }
function SpendingManager({ state, onState, onboarding = false, onContinue }) {
  const saved = state.careRules;
  const [mode, setMode] = useState(saved?.approvalMode || 'ask_every_time');
  const [monthlyCap, setMonthlyCap] = useState(saved?.monthlyCap || '5000');
  const [perOrderCap, setPerOrderCap] = useState(saved?.perOrderCap || '1500');
  const [categories, setCategories] = useState(saved?.allowedCategories?.length ? saved.allowedCategories : ['medicines', 'wellness']);
  const [repeat, setRepeat] = useState(saved?.repeatKnownEssentials || false);
  const [blocked, setBlocked] = useState((saved?.blockedItems || []).join(', '));
  const [mandates, setMandates] = useState([]); const [providerStatus, setProviderStatus] = useState(''); const [status, setStatus] = useState(null); const [busy, setBusy] = useState(false);
  const cards = state.paymentMethods || [];
  const refreshPayments = async () => {
    setProviderStatus('Refreshing secure payment status…');
    try {
      const [cardResult, mandateResult, nextState] = await Promise.all([api('/api/payments/payment-methods').catch((error) => ({ error: error.message, paymentMethods: state.paymentMethods || [] })), api('/api/payments/mandates').catch((error) => (error.status === 409 ? { mandates: [] } : { error: error.message, mandates: [] })), api('/api/me')]);
      onState({ ...nextState, paymentMethods: cardResult.paymentMethods || nextState.paymentMethods }); setMandates(mandateResult.mandates || []); setProviderStatus(cardResult.error || mandateResult.error || 'Payment status is up to date.');
    } catch (error) { setProviderStatus(error.message); }
  };
  useEffect(() => { if (!onboarding || new URL(window.location.href).searchParams.has('pravaCard') || new URL(window.location.href).searchParams.has('pravaMandate')) refreshPayments(); }, []);
  useEffect(() => {
    const onFocus = () => { if (new URL(window.location.href).searchParams.has('pravaCard') || new URL(window.location.href).searchParams.has('pravaMandate')) refreshPayments(); };
    window.addEventListener('focus', onFocus); return () => window.removeEventListener('focus', onFocus);
  }, []);
  const toggleCategory = (value) => setCategories((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  const save = async () => {
    setBusy(true); setStatus({ message: 'Saving your safety rules…' });
    try {
      await api('/api/care-rules', { method: 'PUT', body: { approvalMode: mode, ...(mode === 'auto_essentials' ? { monthlyCap, perOrderCap, allowedCategories: categories, repeatKnownEssentials: repeat } : {}), blockedItems: blocked.split(',').map((item) => item.trim()).filter(Boolean), currency: 'INR' } });
      const next = await api('/api/me'); onState(next); setStatus({ type: 'success', message: mode === 'ask_every_time' ? 'Tokko will ask before every order.' : mandates.some((mandate) => mandate.status === 'active') ? 'Automatic essentials are protected by your limits and active mandate.' : cards.length ? 'Rules saved. Approve a mandate before automatic ordering can begin.' : 'Rules saved. Add a card and mandate before automatic ordering can begin.' });
      if (onContinue) onContinue(next);
    } catch (error) { setStatus({ type: 'error', message: error.message }); }
    finally { setBusy(false); }
  };
  const addCard = async () => { setBusy(true); setStatus({ message: 'Opening Prava’s secure card setup…' }); try { const result = await api('/api/payments/tokenization-session', { method: 'POST', body: {} }); const url = paymentUrl(result); if (!url) throw new Error('Prava did not return a secure setup link.'); window.location.assign(url); } catch (error) { setStatus({ type: 'error', message: error.message }); setBusy(false); } };
  const addMandate = async () => { if (!cards.length) return; setBusy(true); setStatus({ message: 'Opening one-time mandate approval…' }); try { const result = await api('/api/payments/mandates/session', { method: 'POST', body: { paymentMethodId: cards.find((card) => card.isDefault)?.id || cards[0].id, amount: perOrderCap, frequency: 'monthly' } }); const url = paymentUrl(result); if (!url) throw new Error('Prava did not return a mandate approval link.'); window.location.assign(url); } catch (error) { setStatus({ type: 'error', message: error.message }); setBusy(false); } };
  return <><div className="tf-mode-grid"><button className={`tf-mode-card ${mode === 'ask_every_time' ? 'is-selected' : ''}`} type="button" onClick={() => setMode('ask_every_time')}><span><Bell size={21} /></span><strong>Ask me every time</strong><p>Best for maximum control. No card or mandate is required.</p>{mode === 'ask_every_time' && <CheckCircle2 size={20} />}</button><button className={`tf-mode-card ${mode === 'auto_essentials' ? 'is-selected' : ''}`} type="button" onClick={() => setMode('auto_essentials')}><span><Sparkles size={21} /></span><strong>Repeat safe essentials</strong><p>Known routine items can proceed inside limits. Everything unusual still asks.</p>{mode === 'auto_essentials' && <CheckCircle2 size={20} />}</button></div>{mode === 'auto_essentials' && <div className="tf-card tf-rule-builder"><div className="tf-form-grid"><label><span>Monthly family limit</span><span className="tf-money-input"><b>₹</b><input inputMode="decimal" value={monthlyCap} onChange={(event) => setMonthlyCap(event.target.value)} /></span></label><label><span>Maximum per order</span><span className="tf-money-input"><b>₹</b><input inputMode="decimal" value={perOrderCap} onChange={(event) => setPerOrderCap(event.target.value)} /></span></label></div><fieldset className="tf-chip-field"><legend>Allowed categories</legend>{CATEGORIES.map(([value, label]) => <label className={categories.includes(value) ? 'is-selected' : ''} key={value}><input type="checkbox" checked={categories.includes(value)} onChange={() => toggleCategory(value)} />{label}</label>)}</fieldset><label className="tf-switch-row"><input type="checkbox" checked={repeat} onChange={(event) => setRepeat(event.target.checked)} /><span><strong>Recognise repeat essentials</strong><small>Only identical or clearly equivalent routine items qualify.</small></span></label></div>}<div className="tf-card tf-block-list"><label><span>Always pause for <em>optional</em></span><input value={blocked} onChange={(event) => setBlocked(event.target.value)} placeholder="sleep aids, high-dose supplements (comma separated)" /></label><small>Tokko also stops on unclear dosage, sensitive items, conflicts, or anything outside its confidence.</small></div><section className="tf-payment-section"><div className="tf-section-heading"><div><h2>Card & mandate <em>optional</em></h2><p>{mode === 'auto_essentials' ? 'Required for automatic essentials. Prava handles card details and passkeys. Tokko keeps only masked metadata.' : 'Optional now. Adding a card lets approved orders check out instantly, and a mandate is ready if you switch on automatic essentials later.'}</p></div><button className="tf-icon-text" type="button" onClick={refreshPayments}><RefreshCw size={15} /> Refresh</button></div><div className="tf-card-list">{cards.map((card) => <article className="tf-payment-card" key={card.id}><span><CreditCard size={21} /></span><div><strong>{card.brand || 'Card'} ···· {card.last4}</strong><small>Expires {String(card.expMonth).padStart(2, '0')}/{String(card.expYear).slice(-2)}{card.isDefault ? ' · Default' : ''}</small></div><CheckCircle2 size={18} /></article>)}{!cards.length && <button className="tf-add-payment" type="button" onClick={addCard} disabled={busy}><Plus size={19} /><span><strong>Add a secure card</strong><small>No raw card details enter Tokko.</small></span><ChevronRight size={18} /></button>}</div>{cards.length > 0 && <button className="tokko-button tokko-button-ghost tf-mandate-button" type="button" onClick={addMandate} disabled={busy}><ShieldCheck size={17} /> Create {money(perOrderCap)} monthly mandate</button>}{mandates.length > 0 && <div className="tf-mandate-list">{mandates.map((mandate) => <div key={mandate.id}><span className={`tf-status-dot is-${mandate.status}`} /><span><strong>{money(mandate.approvedAmount, mandate.currency)}</strong><small>{mandate.frequency} · {mandate.status}</small></span></div>)}</div>}{providerStatus && <small className="tf-provider-status">{providerStatus}</small>}</section><Status value={status} /><button className="tokko-button tokko-button-primary tf-main-action" type="button" onClick={save} disabled={busy}><span>{onboarding ? 'Finish setup' : 'Save care rules'}</span><BusyIcon busy={busy} icon={Check} /></button></>;
}

function SetupHeader({ stage, theme, onTheme, onExit }) {
  const labels = ['Family', 'Delivery', 'Safety'];
  return <header className="tf-setup-header"><button className="tokko-brand-button" type="button" onClick={onExit} aria-label="Return to Tokko welcome"><Brand compact /></button><ol aria-label={`Setup step ${stage} of 3`}>{labels.map((label, index) => <li className={index + 1 <= stage ? 'is-active' : ''} key={label}><span>{index + 1 < stage ? <Check size={11} /> : index + 1}</span><b>{label}</b></li>)}</ol><ThemeButton theme={theme} onToggle={onTheme} /></header>;
}
function SetupShell({ stage, eyebrow, title, copy, children, theme, onTheme, onExit }) {
  return <section className="tf-setup-screen"><SetupHeader stage={stage} theme={theme} onTheme={onTheme} onExit={onExit} /><main className="tf-setup-main"><header><span className="tokko-panel-kicker"><Sparkles size={15} /> {eyebrow}</span><h1>{title}</h1><p>{copy}</p></header>{children}</main></section>;
}

function DecisionCard({ decision, onResolve, busy }) {
  const safety = decision.requestType === 'safety_stop';
  return <article className={`tf-decision-card ${safety ? 'is-safety' : ''}`}><header><span className="tf-avatar">{initials(decision.memberName)}</span><div><small>{decision.memberName || 'Family request'} · {decision.merchantName || 'Wellness marketplace'}</small><h3>{decision.title}</h3></div><strong>{money(decision.amount, decision.currency)}</strong></header>{decision.originalRequest && <blockquote>“{decision.originalRequest}”</blockquote>}<div className="tf-reason"><Sparkles size={16} /><p><strong>{safety ? 'Tokko paused this' : 'Why Tokko is asking'}</strong>{decision.reasonText}</p></div>{decision.status === 'pending' ? <footer><button className="tokko-button tokko-button-ghost" type="button" onClick={() => onResolve(decision, 'decline')} disabled={busy}>Decline</button>{!safety && <button className="tokko-button tokko-button-primary" type="button" onClick={() => onResolve(decision, 'approve')} disabled={busy}>Approve <BusyIcon busy={busy} icon={Check} /></button>}</footer> : <footer className="tf-resolved"><CheckCircle2 size={16} /> {decision.resolution || decision.status} · {new Date(decision.resolvedAt || decision.updatedAt).toLocaleString()}</footer>}</article>;
}

function EmptyState({ icon: Icon, title, copy }) { return <div className="tf-empty-state"><span><Icon size={27} /></span><h3>{title}</h3><p>{copy}</p></div>; }
function HomeView({ state, decisions, setView }) {
  const firstName = state.profile?.primaryParentName?.split(' ')[0] || 'there'; const pending = decisions.filter((item) => item.status === 'pending');
  const automatic = state.careRules?.approvalMode === 'auto_essentials';
  const automationLabel = automatic ? (state.autoOrderReady ? 'Ready' : 'Rules') : 'Ask';
  return <><header className="tf-page-intro"><span>Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, {firstName}</span><h1>Your family is <em>in good hands.</em></h1><p>Tokko stays quiet when care is flowing and surfaces only what needs judgment.</p></header>{pending.length > 0 ? <button className="tf-needs-banner" type="button" onClick={() => setView('needs')}><span className="tf-pulse"><Bell size={20} /></span><span><strong>{pending.length} decision{pending.length === 1 ? '' : 's'} need you</strong><small>Review before the request expires</small></span><ArrowRight size={19} /></button> : <div className="tf-calm-banner"><span><Check size={19} /></span><p><strong>Nothing needs your attention</strong><small>Tokko will let you know when a human decision matters.</small></p></div>}<div className="tf-metric-grid"><button type="button" onClick={() => setView('family')}><Users size={20} /><strong>{state.profile?.dependents?.length || 0}</strong><span>People cared for</span></button><button type="button" onClick={() => setView('addresses')}><MapPin size={20} /><strong>{state.addresses?.length || 0}</strong><span>Delivery places</span></button><button type="button" onClick={() => setView('spending')}><ShieldCheck size={20} /><strong>{automationLabel}</strong><span>Care rule</span></button></div><section className="tf-glimpse"><div className="tf-section-heading"><div><h2>How Tokko is set up</h2><p>A transparent snapshot of the quiet work.</p></div></div><div className="tf-setup-snapshot"><div><span><MessageCircle size={18} /></span><p><strong>Messaging is the front door</strong><small>{state.profile?.dependents?.length || 0} recognised family number{state.profile?.dependents?.length === 1 ? '' : 's'}</small></p><CheckCircle2 size={17} /></div><div><span><MapPin size={18} /></span><p><strong>{state.selectedAddress?.label || 'No'} default address</strong><small>{state.selectedAddress?.formattedAddress || 'Add one before an order can start'}</small></p>{state.selectedAddress ? <CheckCircle2 size={17} /> : <Clock3 size={17} />}</div><div><span><Fingerprint size={18} /></span><p><strong>{automatic ? (state.autoOrderReady ? 'Bounded automatic care' : 'Automatic rules configured') : 'Human approval first'}</strong><small>{automatic ? (state.autoOrderReady ? `${money(state.careRules.perOrderCap)} per order` : 'Card and active mandate are verified at order time') : 'Every purchase comes back to you'}</small></p>{automatic && !state.autoOrderReady ? <Clock3 size={17} /> : <CheckCircle2 size={17} />}</div></div></section></>;
}

function OrdersView({ state }) {
  const [flows, setFlows] = useState([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(null); const [openId, setOpenId] = useState(null);
  useEffect(() => { (async () => { try { const result = await api('/api/checkout/activity?limit=50'); setFlows((result.checkoutFlows || []).filter(Boolean)); } catch (err) { setError(err.message); } finally { setLoading(false); } })(); }, []);
  const completed = flows.filter((order) => order.pravaCharge?.status === 'APPROVED' || order.cardPaymentReceived || order.status === 'completed');
  const totalCharged = flows.reduce((sum, order) => sum + Number(order.pravaCharge?.amount || 0), 0);
  return <><header className="tf-view-title"><span className="tf-view-icon is-plum"><ShoppingBag /></span><div><h1>Orders & invoices</h1><p>Every order Tokko has placed for your family, with amounts and receipts.</p></div></header><div className="tf-analytics-grid"><div><ShoppingBag size={19} /><strong>{flows.length}</strong><span>Orders placed</span></div><div><CheckCircle2 size={19} /><strong>{completed.length}</strong><span>Completed</span></div><div><CircleDollarSign size={19} /><strong>{money(totalCharged)}</strong><span>Total charged</span></div></div>{loading ? <EmptyState icon={ShoppingBag} title="Loading orders" copy="Fetching your family’s order history." /> : error ? <Status value={{ type: 'error', message: error }} /> : flows.length ? <div className="tf-order-list">{flows.map((order) => { const amount = order.pravaCharge?.amount; const when = order.pravaCharge?.reportedAt; const open = openId === order.id; const items = Array.isArray(order.cartItems) ? order.cartItems : []; return <article className={`tf-order-card ${open ? 'is-open' : ''}`} key={order.id}><button type="button" className="tf-order-head" onClick={() => setOpenId(open ? null : order.id)}><span className="tf-card-icon"><Receipt size={18} /></span><div><strong>{order.merchantName || order.platform || 'Order'}{order.orderId ? ` · ${order.orderId}` : ''}</strong><small>{when ? new Date(when).toLocaleDateString() : (order.status || 'in progress')}{items.length ? ` · ${items.length} item${items.length === 1 ? '' : 's'}` : ''}</small></div><span className="tf-order-amount">{amount ? money(amount, order.pravaCharge?.currency || 'INR') : '—'}</span><ChevronRight size={16} className="tf-order-caret" /></button>{open && <div className="tf-order-detail">{items.length > 0 && <ul className="tf-order-items">{items.map((item, index) => <li key={index}><span>{item.name}</span><em>{item.quantity ? `× ${item.quantity}` : ''}</em></li>)}</ul>}<dl className="tf-order-meta"><div><dt>Status</dt><dd>{order.pravaCharge?.status || order.status || '—'}</dd></div>{order.card && <div><dt>Paid with</dt><dd>{order.card.brand} ···· {order.card.last4}</dd></div>}{order.paymentRoute && <div><dt>Route</dt><dd>{String(order.paymentRoute).replace(/_/g, ' ')}</dd></div>}{order.pravaCharge?.reference && <div><dt>Receipt</dt><dd className="tf-order-ref">{order.pravaCharge.reference}</dd></div>}</dl></div>}</article>; })}</div> : <EmptyState icon={ShoppingBag} title="No orders yet" copy="When Tokko places an approved order, it appears here with its invoice." />}</>;
}
function Dashboard({ state, onState, theme, onTheme, onLogout }) {
  const returned = new URL(window.location.href).searchParams.has('pravaCard') || new URL(window.location.href).searchParams.has('pravaMandate');
  const [view, setView] = useState(returned ? 'spending' : 'home'); const [decisions, setDecisions] = useState([]); const [activity, setActivity] = useState([]); const [loading, setLoading] = useState(true); const [status, setStatus] = useState(null); const [busyDecision, setBusyDecision] = useState(null);
  const refresh = async () => { setLoading(true); try { const [decisionResult, activityResult, nextState] = await Promise.all([api('/api/decisions?status=all').catch((error) => ({ decisions: [], error: error.message })), api('/api/activity').catch((error) => ({ activity: [], error: error.message })), api('/api/me')]); setDecisions(decisionResult.decisions || []); setActivity(activityResult.activity || []); onState(nextState); if (decisionResult.error || activityResult.error) setStatus({ type: 'error', message: decisionResult.error || activityResult.error }); } catch (error) { setStatus({ type: 'error', message: error.message }); } finally { setLoading(false); } };
  useEffect(() => { refresh(); }, []);
  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: 'auto' }); }, [view]);
  const resolve = async (decision, resolution) => { setBusyDecision(decision.id); try { await api(`/api/decisions/${decision.id}/resolve`, { method: 'POST', body: { resolution } }); await refresh(); setStatus({ type: 'success', message: resolution === 'approve' ? 'Approved. Tokko can continue.' : 'Declined. Tokko will not place this order.' }); } catch (error) { setStatus({ type: 'error', message: error.message }); } finally { setBusyDecision(null); } };
  const pending = decisions.filter((item) => item.status === 'pending');
  const title = { home: 'Home', needs: 'Needs you', family: 'Family', activity: 'Activity', more: 'More', addresses: 'Addresses', spending: 'Wallet', orders: 'Orders', settings: 'Settings' }[view];
  const backView = ['addresses', 'settings', 'orders'].includes(view) ? 'more' : null;
  return <section className="tf-dashboard"><header className="tf-dashboard-header"><div>{backView ? <button className="tf-back-button" type="button" onClick={() => setView(backView)}><ArrowLeft size={18} /> <span>More</span></button> : <Brand compact />}</div><strong>{title}</strong><div><ThemeButton theme={theme} onToggle={onTheme} />{view !== 'home' && <button className="tokko-icon-button" type="button" onClick={refresh} aria-label="Refresh"><RefreshCw className={loading ? 'tokko-spinner' : ''} size={18} /></button>}</div></header><main className="tf-dashboard-main">{status && <Status value={status} />}{view === 'home' && <HomeView state={state} decisions={decisions} setView={setView} />}{view === 'needs' && <><header className="tf-view-title"><span className="tf-view-icon is-rose"><Bell /></span><div><h1>Needs you</h1><p>Only requests where human judgment matters.</p></div></header>{pending.length ? <div className="tf-decision-list">{pending.map((decision) => <DecisionCard key={decision.id} decision={decision} onResolve={resolve} busy={busyDecision === decision.id} />)}</div> : <EmptyState icon={CheckCircle2} title="All clear" copy="No family request needs a decision right now." />}{decisions.some((item) => item.status !== 'pending') && <details className="tf-history"><summary>Past decisions</summary><div>{decisions.filter((item) => item.status !== 'pending').map((decision) => <DecisionCard key={decision.id} decision={decision} onResolve={resolve} />)}</div></details>}</>}{view === 'family' && <><header className="tf-view-title"><span className="tf-view-icon"><Users /></span><div><h1>Family circle</h1><p>Edit who Tokko recognises. Removing a member archives access safely.</p></div></header><FamilyEditor state={state} submitLabel="Save family changes" onSaved={onState} /></>}{view === 'activity' && <><header className="tf-view-title"><span className="tf-view-icon is-plum"><Activity /></span><div><h1>Activity</h1><p>A transparent record of setup and decisions.</p></div></header>{activity.length ? <ol className="tf-timeline">{activity.map((event) => <li key={event.id}><span /><div><strong>{event.title}</strong><p>{event.detail}</p><small>{new Date(event.createdAt).toLocaleString()}</small></div></li>)}</ol> : <EmptyState icon={Activity} title="A quiet beginning" copy="Family updates, safety rules and decisions will appear here." />}</>}{view === 'more' && <><header className="tf-view-title"><span className="tf-view-icon"><MoreHorizontal /></span><div><h1>More</h1><p>The controls behind your family care agent.</p></div></header><div className="tf-more-list"><button type="button" onClick={() => setView('addresses')}><span><MapPin /></span><div><strong>Delivery addresses</strong><small>{state.addresses?.length || 0} saved · {state.selectedAddress?.label || 'none selected'}</small></div><ChevronRight /></button><button type="button" onClick={() => setView('orders')}><span><ShoppingBag /></span><div><strong>Orders & invoices</strong><small>Placed orders, amounts and receipts</small></div><ChevronRight /></button><button type="button" onClick={() => setView('activity')}><span><Activity /></span><div><strong>Activity</strong><small>Setup, decisions and updates</small></div><ChevronRight /></button><button type="button" onClick={() => setView('settings')}><span><Settings /></span><div><strong>Notifications & account</strong><small>Decide what Tokko tells you and when</small></div><ChevronRight /></button></div><button className="tf-logout" type="button" onClick={onLogout}><LogOut size={17} /> Sign out of Tokko</button></>}{view === 'addresses' && <AddressManager state={state} onState={onState} />}{view === 'spending' && <SpendingManager state={state} onState={onState} />}{view === 'orders' && <OrdersView state={state} />}{view === 'settings' && <SettingsView state={state} onState={onState} />}</main><nav className="tf-bottom-nav" aria-label="Dashboard"><button className={view === 'home' ? 'is-active' : ''} type="button" onClick={() => setView('home')}><Home /><span>Home</span></button><button className={view === 'needs' ? 'is-active' : ''} type="button" onClick={() => setView('needs')}><span className="tf-nav-icon"><Bell />{pending.length > 0 && <i>{pending.length}</i>}</span><span>Needs you</span></button><button className={view === 'family' ? 'is-active' : ''} type="button" onClick={() => setView('family')}><Users /><span>Family</span></button><button className={view === 'spending' ? 'is-active' : ''} type="button" onClick={() => setView('spending')}><CreditCard /><span>Wallet</span></button><button className={['more', 'addresses', 'settings', 'activity', 'orders'].includes(view) ? 'is-active' : ''} type="button" onClick={() => setView('more')}><MoreHorizontal /><span>More</span></button></nav></section>;
}

function SettingsView({ state, onState }) {
  const [values, setValues] = useState(state.preferences || { decisionAlerts: true, deliveryUpdates: true, weeklyDigest: false }); const [status, setStatus] = useState(null); const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); try { const result = await api('/api/preferences', { method: 'PUT', body: values }); onState({ ...state, preferences: result.preferences }); setStatus({ type: 'success', message: 'Notification preferences saved.' }); } catch (error) { setStatus({ type: 'error', message: error.message }); } finally { setBusy(false); } };
  const toggle = (key) => setValues((current) => ({ ...current, [key]: !current[key] }));
  return <><header className="tf-view-title"><span className="tf-view-icon"><Settings /></span><div><h1>Notifications & account</h1><p>Keep high-signal alerts without turning care into noise.</p></div></header><div className="tf-settings-list"><label><span><strong>Decision alerts</strong><small>Unusual, uncertain, or outside the rules.</small></span><input type="checkbox" checked={values.decisionAlerts} onChange={() => toggle('decisionAlerts')} /></label><label><span><strong>Delivery updates</strong><small>Key changes such as dispatched, delayed, or delivered.</small></span><input type="checkbox" checked={values.deliveryUpdates} onChange={() => toggle('deliveryUpdates')} /></label><label><span><strong>Weekly care digest</strong><small>A quiet summary of family requests and spending.</small></span><input type="checkbox" checked={values.weeklyDigest} onChange={() => toggle('weeklyDigest')} /></label></div><Status value={status} /><button className="tokko-button tokko-button-primary tf-main-action" type="button" onClick={save} disabled={busy}>Save preferences <BusyIcon busy={busy} icon={Check} /></button><section className="tf-account-card"><small>Signed in as</small><strong>{state.account?.email}</strong><span><ShieldCheck size={14} /> Protected by Clerk and an HttpOnly Tokko session</span></section></>;
}

function Landing({ page, setPage, theme, onTheme }) {
  const flowRef = useRef(null);
  const initialPageRef = useRef(page);
  const currentPageRef = useRef(page);
  const scrollFrameRef = useRef(null);

  useEffect(() => { currentPageRef.current = page; }, [page]);
  useLayoutEffect(() => {
    const flow = flowRef.current;
    if (flow && initialPageRef.current === 'explainer') flow.scrollTo({ top: flow.clientHeight, behavior: 'auto' });
    return () => {
      if (scrollFrameRef.current) window.cancelAnimationFrame(scrollFrameRef.current);
    };
  }, []);

  const goTo = (nextPage) => {
    const flow = flowRef.current;
    if (!flow) return;
    currentPageRef.current = nextPage;
    setPage(nextPage);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    flow.scrollTo({ top: nextPage === 'explainer' ? flow.clientHeight : 0, behavior: reducedMotion ? 'auto' : 'smooth' });
  };
  const syncPageToScroll = () => {
    if (scrollFrameRef.current) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const flow = flowRef.current;
      if (!flow) return;
      const nextPage = flow.scrollTop >= flow.clientHeight * 0.5 ? 'explainer' : 'landing';
      if (nextPage !== currentPageRef.current) {
        currentPageRef.current = nextPage;
        setPage(nextPage);
      }
    });
  };

  return <main ref={flowRef} className="tokko-landing-flow" data-page={page} onScroll={syncPageToScroll} aria-label="Tokko introduction">
    <section className={`tokko-image-screen tokko-entry-screen ${page === 'landing' ? 'is-active' : ''}`} aria-labelledby="tokko-landing-title" aria-hidden={page !== 'landing'} inert={page !== 'landing'}>
      <img src="/assets/trakko/storefront-tokko.png" alt="" aria-hidden="true" />
      <div className="tokko-shade" />
      <div className="tokko-entry-top"><Brand /></div>
      <div className="tokko-entry-copy"><span className="tokko-eyebrow"><Sparkles size={15} /> Everyday care, beautifully handled</span><h1 id="tokko-landing-title">Care feels<br /><em>lighter</em> here.</h1><p>Tokko turns family messages into safe, thoughtful health and wellness orders—while you keep the final say.</p><div className="tokko-entry-actions"><button className="tokko-button tokko-button-primary" type="button" onClick={() => goTo('explainer')}>Enter Tokko <ArrowRight size={18} /></button><span><MessageCircle size={16} /> Familiar as a family group chat</span></div></div>
      <button className="tokko-scroll-cue" type="button" aria-label="Discover how Tokko works" onClick={() => goTo('explainer')}><span>Discover how</span><i><ArrowRight size={15} /></i></button>
    </section>
    <section className={`tokko-image-screen tokko-hero-screen ${page === 'explainer' ? 'is-active' : ''}`} aria-labelledby="tokko-explainer-title" aria-hidden={page !== 'explainer'} inert={page !== 'explainer'}>
      <img src="/assets/trakko/storefront-tokko.png" alt="" aria-hidden="true" />
      <div className="tokko-shade tokko-shade-soft" />
      <div className="tokko-hero-nav"><Brand compact /><button type="button" onClick={() => goTo('landing')}><ArrowLeft size={17} /> Exit</button></div>
      <div className="tokko-hero-copy"><span className="tokko-eyebrow"><MessageCircle size={15} /> Messaging is the front door</span><h1 id="tokko-explainer-title">Your family asks.<br /><em>Tokko takes care.</em></h1><p>It understands the message, finds the right essential, checks your rules and only pauses when a decision truly needs you.</p><div className="tokko-agent-path" aria-label="How Tokko works"><span>Message</span><ArrowRight size={14} /><span>Reason</span><ArrowRight size={14} /><span>Check</span><ArrowRight size={14} /><span>Deliver</span></div><LogoMarquee /><div className="tokko-actions"><button className="tokko-button tokko-button-ghost" type="button" onClick={() => goTo('landing')}><ArrowLeft size={18} /> Back</button><button className="tokko-button tokko-button-primary" type="button" onClick={() => setPage('auth')}>Set up my family <ArrowRight size={18} /></button></div></div>
    </section>
  </main>;
}

function App() {
  const [page, setPage] = useState('loading'); const [session, setSession] = useState('checking'); const [state, setState] = useState(null); const [authNotice, setAuthNotice] = useState(''); const [displayName, setDisplayName] = useState(''); const [theme, setTheme] = useState(() => localStorage.getItem('tokko-theme') || 'light'); const syncedAtRef = useRef(0);
  const toggleTheme = () => setTheme((current) => current === 'light' ? 'dark' : 'light');
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('tokko-theme', theme); }, [theme]);
  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: 'auto' }); }, [page]);
  const routeAuthenticated = (next, name = '') => { setState(next); setSession('authenticated'); if (name || next.clerkDisplayName) setDisplayName(name || next.clerkDisplayName); if (!next.familyComplete) setPage('family'); else if (!next.deliveryComplete) setPage('delivery'); else if (!next.spendingComplete) setPage('spending'); else setPage('dashboard'); };
  useEffect(() => {
    let active = true;
    const boot = async () => {
      const url = new URL(window.location.href);
      if (url.pathname === '/sso-callback') { setPage('auth'); await completeGoogleOAuthCallback(); const next = await exchangeClerkSession(); window.history.replaceState({}, '', '/'); return next; }
      const callback = url.searchParams.get('clerk_oauth') === 'complete';
      const next = callback ? await exchangeClerkSession() : await api('/api/me');
      if (callback) window.history.replaceState({}, '', '/');
      return next;
    };
    boot().then((next) => { if (active) routeAuthenticated(next); }).catch((error) => { if (!active) return; const url = new URL(window.location.href); const callback = url.pathname === '/sso-callback' || url.searchParams.get('clerk_oauth') === 'complete'; if (callback) { setAuthNotice(error.message); window.history.replaceState({}, '', '/'); setPage('auth'); } else setPage('landing'); setSession('guest'); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    // A page restored from the browser back/forward cache is a full in-memory
    // snapshot that never re-runs our data fetching, so it shows stale content.
    // Reload it so the user always comes back to the current app and state.
    const onPageShow = (event) => { if (event.persisted) window.location.reload(); };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);
  useEffect(() => {
    if (session !== 'authenticated') return undefined;
    // When the tab becomes visible again, re-sync server state (throttled) so a
    // user returning after a while sees current data, and an expired session is
    // detected and sent back to sign-in instead of showing a dead logged-in view.
    const sync = async () => {
      if (document.visibilityState !== 'visible' || Date.now() - syncedAtRef.current < 15000) return;
      syncedAtRef.current = Date.now();
      try { setState(await api('/api/me')); }
      catch (error) { if (error?.status === 401) { setState(null); setSession('guest'); setPage('auth'); } }
    };
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, [session]);
  const logout = async () => { try { await api('/api/auth/logout', { method: 'POST' }); } catch {} try { const clerk = await browserClerk(); if (clerk?.session) await clerk.signOut(); } catch {} setState(null); setSession('guest'); setPage('auth'); };
  if (page === 'loading') return <div className="tf-app-loading"><Brand /><LoaderCircle className="tokko-spinner" /><span>Waking your care circle…</span></div>;
  if (['landing', 'explainer'].includes(page)) return <Landing page={page} setPage={setPage} theme={theme} onTheme={toggleTheme} />;
  if (page === 'auth') return <section className="tf-auth-screen"><header><button className="tokko-brand-button" type="button" onClick={() => setPage('landing')}><Brand compact /></button><ThemeButton theme={theme} onToggle={toggleTheme} /></header><main><div className="tf-auth-copy"><span className="tokko-panel-kicker"><ShieldCheck size={15} /> Private by design</span><h1>One account.<br /><em>Your family’s care circle.</em></h1><p>Sign in once to set the people, places and boundaries behind every Tokko request.</p><div className="tf-auth-orbit"><span><Sparkles /></span><p><strong>AI that knows when to pause.</strong><small>Simple messages for family. Explicit control for you.</small></p></div></div><div className="tf-auth-card"><MessagingConnect />{session === 'checking' ? <div className="tokko-loading-panel"><LoaderCircle className="tokko-spinner" /> Checking your session…</div> : <AccountAccess initialStatus={authNotice} onAuthenticated={routeAuthenticated} />}</div></main><button className="tf-auth-back" type="button" onClick={() => setPage('explainer')}><ArrowLeft size={17} /> Back to how it works</button></section>;
  if (page === 'family') return <SetupShell stage={1} eyebrow="Your care circle" title="Who can ask Tokko for help?" copy="No duplicate profile questions. Just give Tokko a name for you, then add the family numbers it should recognise." theme={theme} onTheme={toggleTheme} onExit={() => setPage('landing')}><FamilyEditor state={state} displayName={displayName} submitLabel="Continue to delivery" onSaved={(next) => { setState(next); setPage('delivery'); }} /></SetupShell>;
  if (page === 'delivery') return <SetupShell stage={2} eyebrow="Delivery context" title="Where should care arrive?" copy="Tokko checks the destination before searching, so stock, price and delivery promises remain honest." theme={theme} onTheme={toggleTheme} onExit={() => setPage('landing')}><AddressManager state={state} onState={setState} onboarding onContinue={() => setPage('spending')} /></SetupShell>;
  if (page === 'spending') return <SetupShell stage={3} eyebrow="Safe spending" title="Choose how much Tokko may handle." copy="Start with approval every time, or create narrow rules for repeat essentials. You can change this later." theme={theme} onTheme={toggleTheme} onExit={() => setPage('landing')}><SpendingManager state={state} onState={setState} onboarding onContinue={(next) => { setState(next); setPage('dashboard'); }} /></SetupShell>;
  return <Dashboard state={state} onState={setState} theme={theme} onTheme={toggleTheme} onLogout={logout} />;
}

const appRoot = window.__tokkoReactRoot || createRoot(document.getElementById('root'));
window.__tokkoReactRoot = appRoot;
appRoot.render(<App />);
