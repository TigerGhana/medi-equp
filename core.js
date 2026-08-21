// =====================================================================
// CEU Regional Platform — core.js
// Config, helpers, auth, data layer, router, realtime, navigation.
// Vanilla JS, ES6+. No build step required.
// =====================================================================
(function(){
"use strict";

// =====================================================================
// CONFIG
// This is the Supabase "publishable" (anon) key. It is DESIGNED to be
// public — it identifies the project only. All access control is
// enforced server-side by Postgres Row Level Security policies
// (see 02_rls_policies.sql), not by hiding this key.
// Replace these two values with your own project's, then this file
// needs no other changes to run.
// =====================================================================
window.SUPABASE_URL = 'https://xxfvxrzcgowpkcfrvcyd.supabase.co';
window.SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh4ZnZ4cnpjZ293cGtjZnJ2Y3lkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY3Nzk2MDMsImV4cCI6MjEwMjM1NTYwM30.-E1faHOWwVo7wnRfsofLqz2g-A30rHK1It2Nhn1R5C4';

var CONDITION_OPTIONS = ['FUNCTIONAL','FUNCTIONAL BUT NOT IN USE','NEEDS REPAIR','NON-FUNCTIONAL','UNDER MAINTENANCE','OBSOLETE','UNKNOWN'];
var CAL_STATUS_OPTIONS = ['PASSED CALIBRATION','NOT CALIBRATED','OUT OF CALIBRATION','Not Applicable','Not Specified'];
var PRIORITY_OPTIONS = ['low','medium','high','critical'];
var MAINT_STATUS_OPTIONS = ['reported','assigned','repairing','completed','closed'];
var ROLE_OPTIONS = ['viewer','engineer','facility_admin','regional_admin'];
var ROLE_LABELS = { regional_admin:'Regional Administrator', facility_admin:'Facility Administrator', engineer:'Biomedical Engineer', viewer:'Viewer' };
var DOC_TYPES = ['Manual','Certificate','Warranty','Photo','Other'];

window.APP = window.APP || {};
var APP = window.APP;
APP.CONDITION_OPTIONS = CONDITION_OPTIONS;
APP.CAL_STATUS_OPTIONS = CAL_STATUS_OPTIONS;
APP.PRIORITY_OPTIONS = PRIORITY_OPTIONS;
APP.MAINT_STATUS_OPTIONS = MAINT_STATUS_OPTIONS;
APP.ROLE_OPTIONS = ROLE_OPTIONS;
APP.ROLE_LABELS = ROLE_LABELS;
APP.DOC_TYPES = DOC_TYPES;

if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
  document.addEventListener('DOMContentLoaded', function(){
    showError('Could not load the Supabase client library. Check your internet connection and reload the page.');
  });
  return;
}
var sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }
});
APP.sb = sb;

// ---------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------
var STATE = {
  session: null,
  profile: null,        // row from `users`, camelCase
  regions: [],
  facilities: [],
  categories: [],
  equipment: [],
  maintenance: [],
  calibration: [],
  transfers: [],
  documents: [],
  regionSettings: [],
  users: [],
  loaded: false,
  charts: {}             // Chart.js instances keyed by canvas id, so we can destroy() before re-render
};
APP.STATE = STATE;

// ---------------------------------------------------------------------
// Safe helpers
// ---------------------------------------------------------------------
function esc(str){
  if(str === null || str === undefined) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function dash(v){ return (v === null || v === undefined || v === '') ? '—' : v; }
function setText(id, value){
  var el = document.getElementById(id);
  if(el) el.textContent = value;
}
function qs(id){ return document.getElementById(id); }
function delay(ms){ return new Promise(function(resolve){ setTimeout(resolve, ms); }); }
APP.esc = esc; APP.dash = dash; APP.setText = setText; APP.qs = qs; APP.delay = delay;

window.addEventListener('error', function(e){
  console.error('Uncaught error:', e.message, e.error);
  if(STATE.session) showError('Unexpected error: ' + describeError(e.error || {message: e.message}));
});
window.addEventListener('unhandledrejection', function(e){
  console.error('Unhandled promise rejection:', e.reason);
  if(STATE.session) showError('Unexpected error: ' + describeError(e.reason));
});

function describeError(err){
  if(!err) return 'Unknown error';
  if(err.name === 'DataCloneError' || /postMessage|could not be cloned/i.test(err.message||'')){
    return 'A browser extension or preview environment is interfering with network requests on this page. Try opening this file directly in a normal browser tab.';
  }
  if(err.code === '42501' || /row-level security/i.test(err.message||'')) return 'You do not have permission to make this change under your current role/facility assignment.';
  if(err.code === '23505') return 'That record already exists (duplicate value on a unique field).';
  if(err.code === 'PGRST116' || /coerce the result to a single JSON object/i.test(err.message||'')) return 'That change was not saved — your account does not have permission to update this record.';
  var base = err.message ? err.message : (function(){ try{ return JSON.stringify(err); }catch(e){ return String(err); } })();
  return base;
}
APP.describeError = describeError;

function showError(msg, retryFn){
  var b = qs('errorBanner'); if(!b) { alert(msg); return; }
  setText('errorBannerText', msg);
  var retryBtn = qs('errorBannerRetry');
  if(typeof retryFn === 'function'){ retryBtn.style.display = 'inline-block'; retryBtn.onclick = function(){ hideError(); retryFn(); }; }
  else { retryBtn.style.display = 'none'; retryBtn.onclick = null; }
  b.classList.add('show');
}
function hideError(){ var b=qs('errorBanner'); if(b) b.classList.remove('show'); }
function showInfo(msg){
  var b = qs('infoBanner'); if(!b) return;
  setText('infoBannerText', msg);
  b.classList.add('show');
  clearTimeout(showInfo._t);
  showInfo._t = setTimeout(hideInfo, 4000);
}
function hideInfo(){ var b=qs('infoBanner'); if(b) b.classList.remove('show'); }
APP.showError = showError; APP.hideError = hideError; APP.showInfo = showInfo; APP.hideInfo = hideInfo;

function setConnStatus(state){
  var dot = qs('connDot'), label = qs('connLabel');
  if(!dot) return;
  dot.className = 'conn-dot ' + state;
  label.textContent = state === 'live' ? 'Live' : (state === 'connecting' ? 'Connecting…' : 'Offline');
}
APP.setConnStatus = setConnStatus;

document.addEventListener('DOMContentLoaded', function(){
  var a = qs('errorBannerClose'); if(a) a.addEventListener('click', hideError);
  var b = qs('infoBannerClose'); if(b) b.addEventListener('click', hideInfo);
});

// ---------------------------------------------------------------------
// Row mappers (snake_case DB <-> camelCase app)
// ---------------------------------------------------------------------
function mapFacility(r){
  return { id:r.id, regionId:r.region_id, name:r.name, facilityType:r.facility_type, district:r.district, address:r.address, contact:r.contact, createdAt:r.created_at };
}
function toDbFacility(f){
  return { region_id:f.regionId, name:f.name, facility_type:f.facilityType, district:f.district||null, address:f.address||null, contact:f.contact||null };
}
function mapEquipment(r){
  return {
    id:r.id, facilityId:r.facility_id, categoryId:r.category_id, assetCode:r.asset_code, name:r.name,
    manufacturer:r.manufacturer, model:r.model, serial:r.serial_number, department:r.department, location:r.location,
    condition:r.condition, installDate:r.installation_date, warrantyExpiry:r.warranty_expiry,
    calibrationStatus:r.calibration_status, nextCalibration:r.next_calibration_date, responsiblePerson:r.responsible_person,
    owner:r.owner, entryDate:r.entry_date, lastService:r.last_service, servicedBy:r.serviced_by, comment:r.comment,
    createdAt:r.created_at, updatedAt:r.updated_at
  };
}
function toDbEquipment(f){
  return {
    facility_id:f.facilityId, category_id:f.categoryId||null, asset_code:f.assetCode, name:f.name,
    manufacturer:f.manufacturer||'Unknown', model:f.model||null, serial_number:f.serial||null, department:f.department||null,
    location:f.location||null, condition:f.condition, installation_date:f.installDate||null, warranty_expiry:f.warrantyExpiry||null,
    calibration_status:f.calibrationStatus, next_calibration_date:f.nextCalibration||null, responsible_person:f.responsiblePerson||null,
    owner:f.owner||null, entry_date:f.entryDate||null, last_service:f.lastService||null, serviced_by:f.servicedBy||null, comment:f.comment||null
  };
}
function mapMaintenance(r){
  return { id:r.id, equipmentId:r.equipment_id, reportedBy:r.reported_by, assignedEngineer:r.assigned_engineer, problem:r.problem,
    priority:r.priority, status:r.status, dateReported:r.date_reported, dateCompleted:r.date_completed, cost:r.cost, notes:r.notes, updatedAt:r.updated_at };
}
function mapCalibration(r){
  return { id:r.id, equipmentId:r.equipment_id, date:r.date, result:r.result, performedBy:r.performed_by, certificateUrl:r.certificate_url, createdAt:r.created_at };
}
function mapTransfer(r){
  return { id:r.id, equipmentId:r.equipment_id, fromFacility:r.from_facility, toFacility:r.to_facility, requestedBy:r.requested_by,
    approvedBy:r.approved_by, status:r.status, notes:r.notes, createdAt:r.created_at, updatedAt:r.updated_at };
}
function mapDocument(r){
  return { id:r.id, equipmentId:r.equipment_id, fileName:r.file_name, fileUrl:r.file_url, docType:r.doc_type, uploadedBy:r.uploaded_by, createdAt:r.created_at };
}
function mapUser(r){
  return { id:r.id, name:r.name, email:r.email, role:r.role, facilityId:r.facility_id, regionId:r.region_id, isActive:r.is_active, createdAt:r.created_at };
}
function mapRegionSettings(r){
  return { regionId:r.region_id, bannerUrl:r.banner_url, updatedAt:r.updated_at, updatedBy:r.updated_by };
}
APP.mapFacility=mapFacility; APP.toDbFacility=toDbFacility;
APP.mapEquipment=mapEquipment; APP.toDbEquipment=toDbEquipment;
APP.mapMaintenance=mapMaintenance; APP.mapCalibration=mapCalibration;
APP.mapTransfer=mapTransfer; APP.mapDocument=mapDocument; APP.mapUser=mapUser; APP.mapRegionSettings=mapRegionSettings;

// ---------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------
function facilityById(id){ return STATE.facilities.find(function(f){ return f.id === id; }) || null; }
function facilityName(id){ var f = facilityById(id); return f ? f.name : 'Unknown facility'; }
function equipmentById(id){ return STATE.equipment.find(function(e){ return e.id === id; }) || null; }
function userById(id){ return STATE.users.find(function(u){ return u.id === id; }) || null; }
function userName(id){ var u = userById(id); return u ? u.name : (id ? '—' : '—'); }
function categoryName(id){ var c = STATE.categories.find(function(c){ return c.id === id; }); return c ? c.name : '—'; }
APP.facilityById=facilityById; APP.facilityName=facilityName; APP.equipmentById=equipmentById;
APP.userById=userById; APP.userName=userName; APP.categoryName=categoryName;

function isOverdue(rec){
  if(!rec.nextCalibration) return false;
  var d = new Date(rec.nextCalibration + 'T00:00:00');
  var today = new Date(); today.setHours(0,0,0,0);
  return d < today;
}
function needsAttention(rec){
  return rec.condition === 'NON-FUNCTIONAL' || rec.condition === 'NEEDS REPAIR' || rec.condition === 'OBSOLETE' ||
         rec.calibrationStatus === 'OUT OF CALIBRATION' || rec.calibrationStatus === 'NOT CALIBRATED' || isOverdue(rec);
}
function fmtDate(s){
  if(!s) return '—';
  var d = new Date(s + 'T00:00:00');
  if(isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-GB', {day:'2-digit', month:'short', year:'numeric'});
}
function fmtDateTime(s){
  if(!s) return '—';
  var d = new Date(s);
  if(isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-GB', {day:'2-digit', month:'short', year:'numeric'}) + ' · ' + d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
}
function conditionPillClass(c){
  if(c === 'FUNCTIONAL') return 'ok';
  if(c === 'FUNCTIONAL BUT NOT IN USE') return 'info';
  if(c === 'NEEDS REPAIR') return 'warn';
  if(c === 'NON-FUNCTIONAL') return 'bad';
  if(c === 'UNDER MAINTENANCE') return 'warn';
  if(c === 'OBSOLETE') return 'neutral';
  return 'neutral';
}
function calPillClass(c){ if(c === 'PASSED CALIBRATION') return 'ok'; if(c === 'OUT OF CALIBRATION' || c === 'NOT CALIBRATED') return 'bad'; if(c === 'Not Applicable') return 'neutral'; return 'warn'; }
function priorityPillClass(p){ if(p==='critical') return 'bad'; if(p==='high') return 'warn'; if(p==='medium') return 'info'; return 'neutral'; }
function statusPillClass(s){ if(s==='completed'||s==='closed'||s==='approved') return 'ok'; if(s==='rejected') return 'bad'; if(s==='repairing'||s==='pending') return 'warn'; return 'info'; }
APP.isOverdue=isOverdue; APP.needsAttention=needsAttention; APP.fmtDate=fmtDate; APP.fmtDateTime=fmtDateTime;
APP.conditionPillClass=conditionPillClass; APP.calPillClass=calPillClass; APP.priorityPillClass=priorityPillClass; APP.statusPillClass=statusPillClass;

// ---------------------------------------------------------------------
// Role / scope helpers
// ---------------------------------------------------------------------
function isRegionalAdmin(){ return STATE.profile && STATE.profile.role === 'regional_admin'; }
function isFacilityAdmin(){ return STATE.profile && STATE.profile.role === 'facility_admin'; }
function isEngineer(){ return STATE.profile && STATE.profile.role === 'engineer'; }
function canEditEquipment(){ return isFacilityAdmin(); }
function canEditMaintenance(){ return isFacilityAdmin() || isEngineer(); }
function canManageUsers(){ return isFacilityAdmin() || isRegionalAdmin(); }
function canApproveTransfers(){ return isRegionalAdmin(); }
function canRequestTransfers(){ return isFacilityAdmin(); }
APP.isRegionalAdmin=isRegionalAdmin; APP.isFacilityAdmin=isFacilityAdmin; APP.isEngineer=isEngineer;
APP.canEditEquipment=canEditEquipment; APP.canEditMaintenance=canEditMaintenance;
APP.canManageUsers=canManageUsers; APP.canApproveTransfers=canApproveTransfers; APP.canRequestTransfers=canRequestTransfers;

// Equipment visible to the signed-in user given their role/scope (RLS already
// filters at the DB level; this mirrors that logic for client-side derived views).
function scopedEquipment(){
  return STATE.equipment;
}
function scopedFacilities(){
  return STATE.facilities;
}
APP.scopedEquipment = scopedEquipment; APP.scopedFacilities = scopedFacilities;

// =====================================================================
// AUTH
// =====================================================================
var authMode = 'signin';
document.addEventListener('DOMContentLoaded', function(){
  document.querySelectorAll('.auth-tab').forEach(function(tab){
    tab.addEventListener('click', function(){
      authMode = tab.getAttribute('data-mode');
      document.querySelectorAll('.auth-tab').forEach(function(t){ t.classList.toggle('active', t===tab); });
      qs('signinFields').style.display = authMode === 'signin' ? 'block' : 'none';
      qs('signupFields').style.display = authMode === 'signup' ? 'block' : 'none';
      qs('authTitle').textContent = authMode === 'signin' ? 'Sign in' : 'Create account';
      hideAuthError(); hideAuthInfo();
    });
  });
  qs('btnSignIn').addEventListener('click', doSignIn);
  qs('btnSignUp').addEventListener('click', doSignUp);
  qs('btnForgotPw').addEventListener('click', doForgotPassword);
  qs('siPassword').addEventListener('keydown', function(e){ if(e.key==='Enter') doSignIn(); });
  qs('suPassword').addEventListener('keydown', function(e){ if(e.key==='Enter') doSignUp(); });
  qs('btnSignOut').addEventListener('click', doSignOut);
  qs('sidebarToggle').addEventListener('click', function(){ qs('sidebar').classList.toggle('open'); });
});

function showAuthError(msg){ var e=qs('authError'); e.textContent=msg; e.classList.add('show'); }
function hideAuthError(){ qs('authError').classList.remove('show'); }
function showAuthInfo(msg){ var e=qs('authInfo'); e.textContent=msg; e.classList.add('show'); }
function hideAuthInfo(){ qs('authInfo').classList.remove('show'); }

async function doSignIn(){
  hideAuthError(); hideAuthInfo();
  var email = qs('siEmail').value.trim(), password = qs('siPassword').value;
  if(!email || !password){ showAuthError('Enter both email and password.'); return; }
  var btn = qs('btnSignIn'); btn.disabled = true; btn.textContent = 'Signing in…';
  try{
    var res = await sb.auth.signInWithPassword({ email: email, password: password });
    if(res.error) throw res.error;
    // onAuthStateChange -> boot() takes over from here
  }catch(err){
    showAuthError('Sign-in failed: ' + (err.message || 'check your email and password.'));
  }finally{
    btn.disabled = false; btn.textContent = 'Sign in';
  }
}
async function doSignUp(){
  hideAuthError(); hideAuthInfo();
  var name = qs('suName').value.trim(), email = qs('suEmail').value.trim(), password = qs('suPassword').value;
  if(!name || !email || !password){ showAuthError('Fill in your name, email and a password.'); return; }
  if(password.length < 8){ showAuthError('Password must be at least 8 characters.'); return; }
  var btn = qs('btnSignUp'); btn.disabled = true; btn.textContent = 'Creating account…';
  try{
    var res = await sb.auth.signUp({ email: email, password: password, options: { data: { name: name } } });
    if(res.error) throw res.error;
    if(res.data && res.data.session){
      // Email confirmation disabled on this project -> signed in immediately.
    } else {
      showAuthInfo('Account created. Check your email to confirm your address, then sign in. A Regional or Facility Administrator will assign your access.');
      document.querySelector('.auth-tab[data-mode="signin"]').click();
    }
  }catch(err){
    showAuthError('Sign-up failed: ' + (err.message || 'please try again.'));
  }finally{
    btn.disabled = false; btn.textContent = 'Create account';
  }
}
// NOTE: email-based password reset is intentionally disabled here, not
// just left to fail. This project's Supabase instance doesn't have
// custom SMTP configured yet, so the built-in email sender is capped at
// roughly 2 emails/hour project-wide and can't be relied on. Rather than
// let people click this, wait for an email that may never arrive, and
// assume the app is broken, we tell them the real (working) path
// instead: ask an admin, who can reset a password directly via SQL with
// no email involved (see DEPLOYMENT.md). Once custom SMTP is set up,
// swap this back to the commented-out real flow below.
function doForgotPassword(){
  hideAuthError(); hideAuthInfo();
  showAuthInfo('Password reset is not self-service yet. Please contact the Clinical Engineering Unit on 0506971001 for the Password Reset');
}
/* Real email-based flow -- restore this once custom SMTP is configured:
async function doForgotPassword(){
  hideAuthError(); hideAuthInfo();
  var email = qs('siEmail').value.trim();
  if(!email){ showAuthError('Enter your email above first, then click "Forgot your password?" again.'); return; }
  try{
    var res = await sb.auth.resetPasswordForEmail(email);
    if(res.error) throw res.error;
    showAuthInfo('If an account exists for ' + email + ', a password reset link has been sent.');
  }catch(err){
    showAuthError('Could not send reset email: ' + (err.message||''));
  }
}
*/
async function doSignOut(){
  try{ await sb.auth.signOut(); }catch(e){ console.error(e); }
  if(realtimeChannel){ try{ sb.removeChannel(realtimeChannel); }catch(e){} realtimeChannel = null; }
  setConnStatus('offline');
  STATE.profile = null; STATE.loaded = false; STATE.session = null;
  qs('appShell').classList.remove('show');
  qs('authScreen').style.display = 'flex';
}
APP.doSignOut = doSignOut;

sb.auth.onAuthStateChange(function(event, session){
  STATE.session = session;
  if(session) boot(); else {
    qs('appShell') && qs('appShell').classList.remove('show');
    var a = qs('authScreen'); if(a) a.style.display = 'flex';
  }
});

// =====================================================================
// DATA LOADING
// =====================================================================
async function loadProfile(){
  var uid = STATE.session.user.id;
  var res = await sb.from('users').select('*').eq('id', uid).maybeSingle();
  if(res.error) throw res.error;
  if(!res.data){
    // Trigger hasn't caught up yet (rare race on first sign-up) — retry once.
    await delay(600);
    res = await sb.from('users').select('*').eq('id', uid).maybeSingle();
    if(res.error) throw res.error;
  }
  STATE.profile = res.data ? mapUser(res.data) : { id:uid, name:STATE.session.user.email, email:STATE.session.user.email, role:'viewer', facilityId:null, regionId:null };
}

async function loadAllData(){
  var results = await Promise.all([
    sb.from('regions').select('*').order('name'),
    sb.from('facilities').select('*').order('name'),
    sb.from('equipment_categories').select('*').order('name'),
    sb.from('equipment').select('*').order('created_at', {ascending:false}),
    sb.from('maintenance').select('*').order('date_reported', {ascending:false}),
    sb.from('calibration').select('*').order('date', {ascending:false}),
    sb.from('transfers').select('*').order('created_at', {ascending:false}),
    sb.from('documents').select('*').order('created_at', {ascending:false}),
    sb.from('users').select('*').order('name'),
    sb.from('region_settings').select('*')
  ]);
  results.forEach(function(r){ if(r.error) throw r.error; });
  STATE.regions = results[0].data.map(function(r){ return { id:r.id, name:r.name }; });
  STATE.facilities = results[1].data.map(mapFacility);
  STATE.categories = results[2].data;
  STATE.equipment = results[3].data.map(mapEquipment);
  STATE.maintenance = results[4].data.map(mapMaintenance);
  STATE.calibration = results[5].data.map(mapCalibration);
  STATE.transfers = results[6].data.map(mapTransfer);
  STATE.documents = results[7].data.map(mapDocument);
  STATE.users = results[8].data.map(mapUser);
  STATE.regionSettings = results[9].data.map(mapRegionSettings);
  STATE.loaded = true;
}
APP.loadAllData = loadAllData;

async function refetchTable(table){
  var map = { equipment: mapEquipment, maintenance: mapMaintenance, calibration: mapCalibration, transfers: mapTransfer, documents: mapDocument, users: mapUser, facilities: mapFacility, region_settings: mapRegionSettings };
  var order = { equipment:['created_at',false], maintenance:['date_reported',false], calibration:['date',false], transfers:['created_at',false], documents:['created_at',false], users:['name',true], facilities:['name',true], region_settings:['region_id',true] };
  var o = order[table];
  var res = await sb.from(table).select('*').order(o[0], {ascending:o[1]});
  if(res.error) throw res.error;
  STATE[table === 'region_settings' ? 'regionSettings' : table] = res.data.map(map[table]);
}
APP.refetchTable = refetchTable;

// =====================================================================
// REALTIME
// =====================================================================
var realtimeChannel = null;
function startRealtime(){
  setConnStatus('connecting');
  if(realtimeChannel) { try{ sb.removeChannel(realtimeChannel); }catch(e){} }
  realtimeChannel = sb.channel('ceu-live')
    .on('postgres_changes', {event:'*', schema:'public', table:'equipment'}, function(p){ applyRealtime('equipment', mapEquipment, p); })
    .on('postgres_changes', {event:'*', schema:'public', table:'maintenance'}, function(p){ applyRealtime('maintenance', mapMaintenance, p); })
    .on('postgres_changes', {event:'*', schema:'public', table:'transfers'}, function(p){ applyRealtime('transfers', mapTransfer, p); })
    .on('postgres_changes', {event:'*', schema:'public', table:'calibration'}, function(p){ applyRealtime('calibration', mapCalibration, p); })
    .on('postgres_changes', {event:'*', schema:'public', table:'documents'}, function(p){ applyRealtime('documents', mapDocument, p); })
    .subscribe(function(status){
      if(status === 'SUBSCRIBED') setConnStatus('live');
      else if(status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') setConnStatus('offline');
      else setConnStatus('connecting');
    });
}
function applyRealtime(table, mapper, payload){
  var arr = STATE[table];
  if(payload.eventType === 'INSERT'){
    var rec = mapper(payload.new);
    if(!arr.find(function(d){ return d.id === rec.id; })) arr.push(rec);
  } else if(payload.eventType === 'UPDATE'){
    var updated = mapper(payload.new);
    var idx = arr.findIndex(function(d){ return d.id === updated.id; });
    if(idx !== -1) arr[idx] = updated; else arr.push(updated);
  } else if(payload.eventType === 'DELETE'){
    var oldId = payload.old && payload.old.id;
    STATE[table] = arr.filter(function(d){ return d.id !== oldId; });
  }
  if(typeof window.APP_VIEWS !== 'undefined' && window.APP_VIEWS.rerenderCurrent) window.APP_VIEWS.rerenderCurrent();
}

// =====================================================================
// ROUTER + NAV
// =====================================================================
var ROUTES = [
  { hash:'dashboard', label:'Dashboard', icon:'fa-gauge-high', crumb:'Overview' },
  { hash:'facilities', label:'Facilities', icon:'fa-hospital', crumb:'Regional', regionalOnly:true },
  { hash:'equipment', label:'Equipment', icon:'fa-kit-medical', crumb:'Inventory' },
  { hash:'maintenance', label:'Maintenance', icon:'fa-screwdriver-wrench', crumb:'Workflow' },
  { hash:'transfers', label:'Transfers', icon:'fa-truck-fast', crumb:'Asset Movement', hideFor:['viewer','engineer'] },
  { hash:'reports', label:'Reports', icon:'fa-file-lines', crumb:'Analytics', hideFor:['viewer','engineer'] },
  { hash:'users', label:'Users', icon:'fa-users-gear', crumb:'Administration', hideFor:['viewer','engineer'] },
  { hash:'settings', label:'Settings', icon:'fa-gear', crumb:'Account' }
];
APP.ROUTES = ROUTES;

function renderNav(){
  var role = STATE.profile.role;
  var html = '';
  ROUTES.forEach(function(r){
    if(r.regionalOnly && role !== 'regional_admin') return;
    if(r.hideFor && r.hideFor.indexOf(role) !== -1) return;
    html += '<a data-route="'+r.hash+'"><i class="fa-solid '+r.icon+'"></i>'+esc(r.label)+'</a>';
  });
  qs('navList').innerHTML = html;
  document.querySelectorAll('#navList a').forEach(function(a){
    a.addEventListener('click', function(){ location.hash = '#/' + a.getAttribute('data-route'); qs('sidebar').classList.remove('open'); });
  });
}

function currentRoute(){
  var h = location.hash.replace(/^#\/?/, '') || 'dashboard';
  var parts = h.split('/');
  return { name: parts[0], param: parts[1] };
}

function updateActiveNav(){
  var r = currentRoute();
  document.querySelectorAll('#navList a').forEach(function(a){
    a.classList.toggle('active', a.getAttribute('data-route') === r.name);
  });
  var meta = ROUTES.find(function(x){ return x.hash === r.name; });
  if(meta){ setText('crumbLabel', meta.crumb); }
}

function route(){
  if(!STATE.loaded) return;
  var r = currentRoute();
  updateActiveNav();
  if(window.APP_VIEWS && window.APP_VIEWS.render) window.APP_VIEWS.render(r.name, r.param);
}
window.addEventListener('hashchange', route);
APP.route = route; APP.currentRoute = currentRoute;

function renderUserBadge(){
  var p = STATE.profile;
  var initials = (p.name||'?').trim().split(/\s+/).map(function(s){return s[0];}).slice(0,2).join('').toUpperCase();
  qs('userAvatar').textContent = initials || '?';
  qs('userName').textContent = p.name;
  qs('userRole').textContent = ROLE_LABELS[p.role] || p.role;
  var scopeLabel, scopeValue;
  if(p.role === 'regional_admin'){
    scopeLabel = 'Region';
    var reg = STATE.regions.find(function(r){ return r.id === p.regionId; });
    scopeValue = reg ? reg.name : 'No region assigned';
  } else {
    scopeLabel = 'Facility';
    scopeValue = p.facilityId ? facilityName(p.facilityId) : 'No facility assigned';
  }
  qs('scopeLabel').textContent = scopeLabel;
  qs('scopeValue').textContent = scopeValue;
}

// =====================================================================
// BOOT
// =====================================================================
var booting = false;
async function boot(){
  if(booting) return; booting = true;
  try{
    await loadProfile();
    qs('authScreen').style.display = 'none';
    qs('appShell').classList.add('show');
    await loadAllData();
    renderNav();
    renderUserBadge();
    hideError();
    startRealtime();
    route();
  }catch(err){
    console.error('boot failed', err);
    showError('Could not load your account/data: ' + describeError(err), function(){ booting=false; boot(); });
  }finally{
    booting = false;
  }
}
APP.boot = boot;

document.addEventListener('DOMContentLoaded', async function(){
  try{
    var res = await sb.auth.getSession();
    STATE.session = res.data && res.data.session ? res.data.session : null;
    if(STATE.session) boot();
  }catch(err){
    console.error('initial session check failed', err);
  }
});

// ---------------------------------------------------------------------
// Generic modal helpers (shared across views.js)
// ---------------------------------------------------------------------
var modalBackdrop, modalEl, modalTitle, modalCode, modalBody, modalHeadActions, lastFocused;
document.addEventListener('DOMContentLoaded', function(){
  modalBackdrop = qs('modalBackdrop'); modalEl = qs('modalEl'); modalTitle = qs('modalTitle');
  modalCode = qs('modalCode'); modalBody = qs('modalBody'); modalHeadActions = qs('modalHeadActions');
  qs('modalClose').addEventListener('click', closeModal);
  modalBackdrop.addEventListener('click', function(e){ if(e.target === modalBackdrop) closeModal(); });
  document.addEventListener('keydown', function(e){ if(e.key === 'Escape' && modalBackdrop.classList.contains('open')) closeModal(); });
});
function openModal(opts){
  lastFocused = document.activeElement;
  modalTitle.textContent = opts.title || '—';
  modalCode.textContent = opts.code || '';
  modalBody.innerHTML = opts.bodyHtml || '';
  modalEl.classList.toggle('wide', !!opts.wide);
  var extra = opts.headActionsHtml || '';
  modalHeadActions.innerHTML = extra + '<button class="icon-btn close-btn" id="modalClose" aria-label="Close">✕</button>';
  qs('modalClose').addEventListener('click', closeModal);
  modalBackdrop.classList.add('open');
  if(opts.onOpen) opts.onOpen();
}
function closeModal(){
  modalBackdrop.classList.remove('open');
  if(lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
}
APP.openModal = openModal; APP.closeModal = closeModal;

})();
