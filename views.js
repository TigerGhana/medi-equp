// =====================================================================
// CEU Regional Platform — views.js
// All screen renderers + CRUD interactions. Depends on core.js (APP.*).
// =====================================================================
(function(){
"use strict";
const APP = window.APP;
const { STATE, esc, dash, setText, qs, fmtDate, fmtDateTime, isOverdue, needsAttention,
  conditionPillClass, calPillClass, priorityPillClass, statusPillClass,
  facilityById, facilityName, equipmentById, userById, userName, categoryName,
  CONDITION_OPTIONS, CAL_STATUS_OPTIONS, PRIORITY_OPTIONS, MAINT_STATUS_OPTIONS, ROLE_OPTIONS, ROLE_LABELS, DOC_TYPES,
  isRegionalAdmin, isRegionalDirector, isRegionalScoped, isFacilityAdmin, isFacilityDirector, isEngineer, canEditEquipment, canDeleteEquipment, canEditMaintenance, canManageUsers,
  canApproveTransfers, canRequestTransfers, openModal, closeModal, showError, showInfo, describeError, sb } = APP;

let currentView = { name: 'dashboard', param: null };

const CONDITION_COLORS = {
  'FUNCTIONAL': '#1E9E64',
  'FUNCTIONAL BUT NOT IN USE': '#2C6FB0',
  'NEEDS REPAIR': '#C9861A',
  'NON-FUNCTIONAL': '#D14343',
  'UNDER MAINTENANCE': '#8B5CF6',
  'OBSOLETE': '#8B9997',
  'UNKNOWN': '#5B6B69'
};
function conditionColors(labels){ return labels.map(l => CONDITION_COLORS[l] || '#8B9997'); }

// ---------------------------------------------------------------------
// small generic helpers
// ---------------------------------------------------------------------
function countBy(arr, keyFn){
  const map = {};
  arr.forEach(d => { const k = keyFn(d) || 'Unspecified'; map[k] = (map[k]||0) + 1; });
  return map;
}
function sortEntriesDesc(map){ return Object.keys(map).map(k => [k, map[k]]).sort((a,b) => b[1]-a[1]); }
function setPageTitle(t){ setText('pageTitle', t); }
function mainEl(){ return qs('mainContent'); }
function destroyChart(id){ if(STATE.charts[id]){ STATE.charts[id].destroy(); delete STATE.charts[id]; } }
function makeChart(id, config){
  destroyChart(id);
  const ctx = document.getElementById(id);
  if(!ctx || typeof Chart === 'undefined') return;
  STATE.charts[id] = new Chart(ctx, config);
}
const CHART_COLORS = ['#1E3A6E','#1E9E64','#C9861A','#D14343','#2C6FB0','#8B5CF6','#DB2777','#8996A8','#0B1E3D','#5EA1FF'];
function csvDownload(filename, rows){
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Report');
  XLSX.writeFile(wb, filename);
}

// =====================================================================
// ROUTER DISPATCH
// =====================================================================
function render(name, param){
  currentView = { name, param };
  try{
    if(name === 'dashboard') renderDashboard();
    else if(name === 'help') renderHelp();
    else if(name === 'facilities') param ? renderFacilityDashboard(param) : renderFacilitiesList();
    else if(name === 'equipment') param ? renderEquipmentDetail(param) : renderEquipmentList();
    else if(name === 'maintenance') renderMaintenance();
    else if(name === 'transfers') renderTransfers();
    else if(name === 'reports') renderReports();
    else if(name === 'users') renderUsers();
    else if(name === 'settings') renderSettings();
    else renderDashboard();
  }catch(err){
    console.error('render failed', err);
    mainEl().innerHTML = `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>Something went wrong rendering this page: ${esc(describeError(err))}</p></div>`;
  }
}
function rerenderCurrent(){ render(currentView.name, currentView.param); }
window.APP_VIEWS = { render, rerenderCurrent };

// =====================================================================
// DASHBOARD (regional overview OR single-facility view)
// =====================================================================
function computeFacilityMetrics(facilityId){
  const eq = STATE.equipment.filter(e => e.facilityId === facilityId);
  const total = eq.length;
  const functional = eq.filter(e => e.condition === 'FUNCTIONAL').length;
  const nonFunctional = eq.filter(e => e.condition === 'NON-FUNCTIONAL').length;
  const overdue = eq.filter(isOverdue).length;
  const lastUpdate = eq.reduce((max, e) => { const t = e.updatedAt ? new Date(e.updatedAt).getTime() : 0; return t > max ? t : max; }, 0);
  return { total, functional, nonFunctional, overdue, pct: total ? Math.round((functional/total)*100) : 0, lastUpdate };
}

// =====================================================================
// REGION BANNER (dashboard header image, regional_admin can upload/change)
// =====================================================================
function myEffectiveRegionId(){
  if(isRegionalScoped()) return STATE.profile.regionId;
  const f = facilityById(STATE.profile.facilityId);
  return f ? f.regionId : null;
}
function regionSettingsFor(regionId){
  return STATE.regionSettings.find(r => r.regionId === regionId) || null;
}
function renderBannerHero(regionId, canEdit){
  if(!regionId) return '';
  const settings = regionSettingsFor(regionId);
  const bannerUrl = settings && settings.bannerUrl;
  const region = STATE.regions.find(r => r.id === regionId);
  return `
    <div class="hero-banner" id="heroBanner" style="${bannerUrl ? `background-image:linear-gradient(180deg, rgba(11,30,61,0.15) 0%, rgba(11,30,61,0.75) 100%), url('${esc(bannerUrl)}');` : ''}">
      <div class="hero-banner-text">
        <div class="hero-banner-eyebrow">Clinical Engineering Unit</div>
        <h1>${esc(region ? region.name : 'Regional Dashboard')}</h1>
      </div>
      ${canEdit ? `
        <button class="btn-banner-upload" id="btnBannerUpload"><i class="fa-solid fa-image"></i> ${bannerUrl?'Change Banner':'Upload Banner'}</button>
        <input type="file" id="bannerFileInput" accept="image/*" style="display:none;">
      ` : ''}
    </div>
  `;
}
function wireBannerHero(regionId, canEdit){
  if(!canEdit) return;
  const btn = qs('btnBannerUpload');
  if(!btn) return;
  btn.addEventListener('click', () => qs('bannerFileInput').click());
  qs('bannerFileInput').addEventListener('change', e => bannerUploadFlow(regionId, e));
}
async function bannerUploadFlow(regionId, e){
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if(!file) return;
  if(!file.type.startsWith('image/')){ showError('Please choose an image file.'); return; }
  if(file.size > 8 * 1024 * 1024){ showError('Image is too large (max 8MB).'); return; }
  const btn = qs('btnBannerUpload');
  if(btn){ btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Uploading…'; }
  try{
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g,'');
    const path = `${regionId}/banner_${Date.now()}.${ext || 'jpg'}`;
    const up = await sb.storage.from('branding').upload(path, file, { upsert: true });
    if(up.error) throw up.error;
    const pub = sb.storage.from('branding').getPublicUrl(path);
    const res = await sb.from('region_settings')
      .upsert({ region_id: regionId, banner_url: pub.data.publicUrl, updated_by: STATE.session.user.id, updated_at: new Date().toISOString() }, { onConflict: 'region_id' })
      .select().single();
    if(res.error) throw res.error;
    const idx = STATE.regionSettings.findIndex(r => r.regionId === regionId);
    const mapped = APP.mapRegionSettings(res.data);
    if(idx !== -1) STATE.regionSettings[idx] = mapped; else STATE.regionSettings.push(mapped);
    showInfo('Banner updated.');
    rerenderCurrent();
  }catch(err){
    showError('Banner upload failed: ' + describeError(err));
    if(btn){ btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-image"></i> Upload Banner'; }
  }
}

function renderDashboard(){
  if(isRegionalScoped()) renderRegionalDashboard();
  else renderSingleFacilityDashboard(STATE.profile.facilityId);
}

function renderRegionalDashboard(){
  setPageTitle('Regional Dashboard');
  const region = STATE.regions.find(r => r.id === STATE.profile.regionId);
  const eq = STATE.equipment;
  const total = eq.length;
  const functional = eq.filter(e => e.condition === 'FUNCTIONAL').length;
  const nonFunctional = eq.filter(e => e.condition === 'NON-FUNCTIONAL').length;
  const calOverdue = eq.filter(isOverdue).length;
  const maintPending = STATE.maintenance.filter(m => ['reported','assigned','repairing'].includes(m.status)).length;

  const kpis = [
    { label:'Facilities', value: STATE.facilities.length, icon:'fa-hospital', cls:'' },
    { label:'Total Equipment', value: total, icon:'fa-boxes-stacked', cls:'' },
    { label:'Functional', value: functional, icon:'fa-circle-check', cls:'ok' },
    { label:'Non-Functional', value: nonFunctional, icon:'fa-circle-xmark', cls: nonFunctional>0 ? 'bad':'' },
    { label:'Calibration Due', value: calOverdue, icon:'fa-clock', cls: calOverdue>0 ? 'warn':'' },
    { label:'Maintenance Pending', value: maintPending, icon:'fa-screwdriver-wrench', cls: maintPending>0 ? 'warn':'' }
  ];

  const facRows = STATE.facilities.map(f => {
    const m = computeFacilityMetrics(f.id);
    const status = m.total === 0 ? 'neutral' : (m.nonFunctional > 0 || m.overdue > 0 ? (m.pct < 70 ? 'bad' : 'warn') : 'ok');
    const statusLabel = m.total === 0 ? 'No data' : (status === 'ok' ? 'Good' : (status === 'warn' ? 'Attention' : 'Critical'));
    return { f, m, status, statusLabel };
  }).sort((a,b) => a.m.pct - b.m.pct);

  mainEl().innerHTML = `
    ${renderBannerHero(STATE.profile.regionId, isRegionalAdmin())}
    <div class="kpi-grid">${kpis.map(k => `
      <div class="kpi-card"><div class="lbl"><i class="fa-solid ${k.icon}"></i> ${esc(k.label)}</div><div class="val ${k.cls}">${k.value}</div></div>
    `).join('')}</div>

    <div class="panel-grid2">
      <div class="panel">
        <h3>Facility Performance — ${esc(region ? region.name : 'Your Region')}</h3>
        <div class="table-shell"><div class="table-scroll" style="max-height:420px;">
          <table><thead><tr>
            <th class="no-sort">Facility</th><th class="no-sort">District</th><th class="no-sort">Equipment</th>
            <th class="no-sort">Functional %</th><th class="no-sort">Faulty</th><th class="no-sort">Cal. Issues</th><th class="no-sort">Status</th>
          </tr></thead><tbody id="facPerfBody">
            ${facRows.length === 0 ? `<tr><td colspan="7"><div class="no-results">No facilities in this region yet.</div></td></tr>` :
              facRows.map(r => `
              <tr data-fid="${r.f.id}">
                <td data-label="Facility" class="name-cell">${esc(r.f.name)}</td>
                <td data-label="District">${esc(dash(r.f.district))}</td>
                <td data-label="Equipment" class="mono">${r.m.total}</td>
                <td data-label="Functional %" class="mono">${r.m.pct}%</td>
                <td data-label="Faulty" class="mono">${r.m.nonFunctional}</td>
                <td data-label="Cal. Issues" class="mono">${r.m.overdue}</td>
                <td data-label="Status"><span class="pill ${r.status}">${esc(r.statusLabel)}</span></td>
              </tr>`).join('')}
          </tbody></table>
        </div></div>
      </div>
      <div class="panel">
        <h3>Region-wide Equipment Condition</h3>
        <div class="chart-wrap tall"><canvas id="chartRegionCondition"></canvas></div>
      </div>
    </div>

    <div class="panel-grid3">
      <div class="panel"><h3>Calibration Status</h3><div class="chart-wrap"><canvas id="chartRegionCal"></canvas></div></div>
      <div class="panel"><h3>Top Manufacturers</h3><div class="barlist" id="regionManBar"></div></div>
      <div class="panel"><h3>Equipment by Facility</h3><div class="barlist" id="regionFacBar"></div></div>
    </div>
  `;

  document.querySelectorAll('#facPerfBody tr[data-fid]').forEach(tr => {
    tr.addEventListener('click', () => { location.hash = '#/facilities/' + tr.getAttribute('data-fid'); });
  });

  const condMap = countBy(eq, e => e.condition);
  makeChart('chartRegionCondition', {
    type:'doughnut',
    data:{ labels:Object.keys(condMap), datasets:[{ data:Object.values(condMap), backgroundColor:conditionColors(Object.keys(condMap)) }] },
    options:{ plugins:{ legend:{ position:'bottom', labels:{ boxWidth:10, font:{ size:11 } } } }, maintainAspectRatio:false }
  });
  const calMap = countBy(eq, e => e.calibrationStatus);
  makeChart('chartRegionCal', {
    type:'bar',
    data:{ labels:Object.keys(calMap), datasets:[{ data:Object.values(calMap), backgroundColor:'#1E3A6E', borderRadius:4 }] },
    options:{ plugins:{ legend:{ display:false } }, maintainAspectRatio:false, scales:{ x:{ ticks:{ font:{size:10} } } } }
  });
  renderBarList('regionManBar', countBy(eq, e => e.manufacturer), 8);
  renderBarList('regionFacBar', countBy(eq, e => facilityName(e.facilityId)), 8);
  wireBannerHero(STATE.profile.regionId, isRegionalAdmin());
}

function renderSingleFacilityDashboard(facilityId){
  const f = facilityById(facilityId);
  setPageTitle(f ? f.name : 'Facility Dashboard');
  if(!facilityId || !f){
    mainEl().innerHTML = `<div class="empty-state"><i class="fa-solid fa-hospital"></i><p>Your account has no facility assigned yet. Ask a Regional or Facility Administrator to assign one from the Users module.</p></div>`;
    return;
  }
  renderFacilityDashboardInto(mainEl(), f, { showBackLink:false });
}

function renderFacilityDashboard(facilityId){
  const f = facilityById(facilityId);
  if(!f){ mainEl().innerHTML = `<div class="empty-state"><i class="fa-solid fa-hospital"></i><p>Facility not found or you don't have access to it.</p></div>`; return; }
  setPageTitle(f.name);
  renderFacilityDashboardInto(mainEl(), f, { showBackLink: isRegionalScoped(), canManageFacility: isRegionalAdmin() });
}

function renderFacilityDashboardInto(container, f, opts){
  const eq = STATE.equipment.filter(e => e.facilityId === f.id);
  const m = computeFacilityMetrics(f.id);
  const attention = eq.filter(needsAttention);
  const openTickets = STATE.maintenance.filter(t => equipmentById(t.equipmentId) && equipmentById(t.equipmentId).facilityId === f.id && ['reported','assigned','repairing'].includes(t.status));

  const kpis = [
    { label:'Total Equipment', value:m.total, icon:'fa-boxes-stacked' },
    { label:'Functional', value:`${m.functional} / ${m.total}`, icon:'fa-circle-check', cls:'ok' },
    { label:'Non-Functional', value:m.nonFunctional, icon:'fa-circle-xmark', cls:m.nonFunctional>0?'bad':'' },
    { label:'Calibration Overdue', value:m.overdue, icon:'fa-clock', cls:m.overdue>0?'warn':'' },
    { label:'Open Maintenance', value:openTickets.length, icon:'fa-screwdriver-wrench', cls:openTickets.length>0?'warn':'' }
  ];

  container.innerHTML = `
    ${!opts.showBackLink ? renderBannerHero(myEffectiveRegionId(), false) : ''}
    ${opts.showBackLink ? `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:14px; flex-wrap:wrap;">
        <a href="#/facilities" style="font-size:12.5px; color:var(--teal); font-weight:600; cursor:pointer;"><i class="fa-solid fa-arrow-left"></i> Back to all facilities</a>
        ${opts.canManageFacility ? `
        <div style="display:flex; gap:8px;">
          <button class="btn-secondary btn-sm" id="btnEditFacility"><i class="fa-solid fa-pen"></i> Edit Facility</button>
          <button class="btn-danger btn-sm" id="btnDeleteFacility"><i class="fa-solid fa-trash"></i> Delete Facility</button>
        </div>
        ` : ''}
      </div>
    ` : ''}
    <div class="section-head">
      <h2>${esc(f.name)}</h2>
      <span class="hint">${esc(f.facilityType)} · ${esc(dash(f.district))}</span>
    </div>
    <div class="kpi-grid" style="grid-template-columns:repeat(5,1fr);">${kpis.map(k => `
      <div class="kpi-card"><div class="lbl"><i class="fa-solid ${k.icon}"></i> ${esc(k.label)}</div><div class="val ${k.cls||''}">${k.value}</div></div>
    `).join('')}</div>

    <div class="panel-grid3">
      <div class="panel"><h3>Equipment Condition</h3><div class="chart-wrap"><canvas id="chartFacCondition"></canvas></div></div>
      <div class="panel"><h3>Department Distribution</h3><div class="barlist" id="facDeptBar"></div></div>
      <div class="panel"><h3>Manufacturer Analysis</h3><div class="barlist" id="facManBar"></div></div>
    </div>

    <div class="section-head"><h2>Needs Attention</h2><span class="hint">${attention.length} flagged item(s)</span></div>
    <div class="table-shell" style="margin-bottom:24px;">
      ${attention.length === 0 ? `<div class="no-results">No flagged equipment — this facility is in good standing.</div>` : `
      <div class="table-scroll" style="max-height:300px;"><table><thead><tr>
        <th class="no-sort">Equipment</th><th class="no-sort">Department</th><th class="no-sort">Condition</th><th class="no-sort">Issue</th>
      </tr></thead><tbody id="facAttnBody">
        ${attention.map(e => `
        <tr data-id="${e.id}">
          <td data-label="Equipment" class="name-cell">${esc(e.name)}<div class="mono" style="font-size:11px;color:var(--muted-2);">${esc(dash(e.assetCode))}</div></td>
          <td data-label="Department">${esc(dash(e.department))}</td>
          <td data-label="Condition"><span class="pill ${conditionPillClass(e.condition)}">${esc(e.condition)}</span></td>
          <td data-label="Issue" class="mono" style="font-size:11.5px;">${esc(attentionReason(e))}</td>
        </tr>`).join('')}
      </tbody></table></div>`}
    </div>
  `;
  const condMap = countBy(eq, e => e.condition);
  makeChart('chartFacCondition', {
    type:'doughnut',
    data:{ labels:Object.keys(condMap), datasets:[{ data:Object.values(condMap), backgroundColor:conditionColors(Object.keys(condMap)) }] },
    options:{ plugins:{ legend:{ position:'bottom', labels:{ boxWidth:10, font:{ size:11 } } } }, maintainAspectRatio:false }
  });
  renderBarList('facDeptBar', countBy(eq, e => e.department), 8);
  renderBarList('facManBar', countBy(eq, e => e.manufacturer), 8);
  const attnBody = qs('facAttnBody');
  if(attnBody) attnBody.querySelectorAll('tr[data-id]').forEach(tr => tr.addEventListener('click', () => { location.hash = '#/equipment/' + tr.getAttribute('data-id'); }));
  if(opts.canManageFacility){
    const editBtn = qs('btnEditFacility');
    const delBtn = qs('btnDeleteFacility');
    if(editBtn) editBtn.addEventListener('click', () => openFacilityForm(f));
    if(delBtn) delBtn.addEventListener('click', () => confirmDeleteFacility(f));
  }
}

function attentionReason(rec){
  const reasons = [];
  if(rec.condition === 'NON-FUNCTIONAL') reasons.push('Non-functional');
  if(rec.condition === 'NEEDS REPAIR') reasons.push('Needs repair');
  if(rec.condition === 'OBSOLETE') reasons.push('Obsolete');
  if(isOverdue(rec)) reasons.push('Calibration overdue');
  else if(rec.calibrationStatus === 'OUT OF CALIBRATION') reasons.push('Out of calibration');
  else if(rec.calibrationStatus === 'NOT CALIBRATED') reasons.push('Not calibrated');
  return reasons.join(' · ');
}

function renderBarList(elId, map, limit){
  const el = qs(elId); if(!el) return;
  let entries = sortEntriesDesc(map);
  if(limit) entries = entries.slice(0, limit);
  const max = entries.length ? Math.max(...entries.map(e => e[1])) : 1;
  el.innerHTML = entries.length === 0 ? `<div class="no-results" style="padding:16px 0;">No data yet.</div>` : entries.map(([key, count]) => `
    <div class="item"><div class="name" title="${esc(key)}">${esc(key)}</div>
      <div class="track"><div class="fill" style="width:${Math.round((count/max)*100)}%"></div></div>
      <div class="count">${count}</div></div>
  `).join('');
}

// =====================================================================
// FACILITIES (regional admin: list/manage)
// =====================================================================
function renderFacilitiesList(){
  setPageTitle('Facilities');
  const region = STATE.regions.find(r => r.id === STATE.profile.regionId);
  mainEl().innerHTML = `
    <div class="section-head">
      <h2>Facilities in ${esc(region ? region.name : 'your region')}</h2>
      <span class="hint">${STATE.facilities.length} facilities</span>
    </div>
    <div class="controls">
      ${isRegionalAdmin() ? `<button class="btn-add" id="btnAddFacility"><i class="fa-solid fa-plus"></i> Add Facility</button>` : ''}
    </div>
    <div id="facilityGrid" style="display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:14px;"></div>
  `;
  const grid = qs('facilityGrid');
  if(STATE.facilities.length === 0){
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><i class="fa-solid fa-hospital"></i><p>No facilities yet. Add the first one to get started.</p></div>`;
  } else {
    grid.innerHTML = STATE.facilities.map(f => {
      const m = computeFacilityMetrics(f.id);
      return `<div class="facility-card" data-fid="${f.id}">
        <div class="fname">${esc(f.name)}</div>
        <div class="fmeta">${esc(f.facilityType)} · ${esc(dash(f.district))}</div>
        <div class="frow"><span>Total Equipment</span><strong class="mono">${m.total}</strong></div>
        <div class="frow"><span>Functional</span><strong class="mono" style="color:var(--ok)">${m.functional}</strong></div>
        <div class="frow"><span>Non-Functional</span><strong class="mono" style="color:${m.nonFunctional>0?'var(--bad)':'inherit'}">${m.nonFunctional}</strong></div>
        <div class="frow"><span>Calibration Overdue</span><strong class="mono" style="color:${m.overdue>0?'var(--warn)':'inherit'}">${m.overdue}</strong></div>
      </div>`;
    }).join('');
    grid.querySelectorAll('.facility-card').forEach(c => c.addEventListener('click', () => { location.hash = '#/facilities/' + c.getAttribute('data-fid'); }));
  }
  const addBtn = qs('btnAddFacility');
  if(addBtn) addBtn.addEventListener('click', () => openFacilityForm());
}

function openFacilityForm(existing){
  const isEdit = !!existing;
  const f = existing || { name:'', facilityType:'Hospital', district:'', address:'', contact:'' };
  const typeOptions = ['Teaching Hospital','Regional Hospital','Municipal Hospital','District Hospital','Polyclinic','Health Centre','CHPS','Medical Centre','Private Hospital','CHAG','Quasi-Government','Clinic','Others'];
  // A facility saved before this list existed (or a custom "Others" entry) may hold
  // a type that isn't one of these options -- fall back to "Others" with the real
  // value shown in the text field below, rather than silently losing/blanking it.
  const knownType = typeOptions.includes(f.facilityType) && f.facilityType !== 'Others';
  const initialSelect = knownType ? f.facilityType : 'Others';
  const initialOtherText = knownType ? '' : (f.facilityType || '');
  const body = `
    <div class="form-grid">
      <div class="form-field span2"><label>Facility Name *</label><input type="text" id="ff_name" value="${esc(f.name)}"></div>
      <div class="form-field"><label>Facility Type</label>
        <select id="ff_type">${typeOptions.map(t => `<option ${t===initialSelect?'selected':''}>${t}</option>`).join('')}</select>
      </div>
      <div class="form-field" id="ff_type_other_wrap" style="${initialSelect==='Others'?'':'display:none;'}">
        <label>Specify Type *</label><input type="text" id="ff_type_other" value="${esc(initialOtherText)}" placeholder="e.g. Diagnostic Centre">
      </div>
      <div class="form-field"><label>District</label><input type="text" id="ff_district" value="${esc(f.district||'')}"></div>
      <div class="form-field span2"><label>Address</label><input type="text" id="ff_address" value="${esc(f.address||'')}"></div>
      <div class="form-field span2"><label>Contact</label><input type="text" id="ff_contact" value="${esc(f.contact||'')}"></div>
    </div>
    <div class="field-error" id="ff_error"></div>
    <div class="modal-actions"><div class="left"></div><div class="right">
      <button class="btn-secondary" id="ff_cancel">Cancel</button>
      <button class="btn-primary" id="ff_save" style="width:auto;">${isEdit ? 'Save Changes' : 'Add Facility'}</button>
    </div></div>
  `;
  openModal({ title: isEdit ? `Edit Facility: ${f.name}` : 'Add Facility', code: isEdit ? 'Update facility details' : 'New facility record', bodyHtml: body });
  qs('ff_cancel').addEventListener('click', closeModal);
  qs('ff_type').addEventListener('change', e => {
    qs('ff_type_other_wrap').style.display = e.target.value === 'Others' ? '' : 'none';
  });
  qs('ff_save').addEventListener('click', async () => {
    const errEl = qs('ff_error'); errEl.classList.remove('show');
    const name = qs('ff_name').value.trim();
    if(!name){ errEl.textContent = 'Facility name is required.'; errEl.classList.add('show'); return; }
    const selectedType = qs('ff_type').value;
    const otherText = qs('ff_type_other').value.trim();
    if(selectedType === 'Others' && !otherText){ errEl.textContent = 'Please specify the facility type.'; errEl.classList.add('show'); return; }
    const finalType = selectedType === 'Others' ? otherText : selectedType;
    const btn = qs('ff_save'); btn.disabled = true; btn.textContent = 'Saving…';
    try{
      const row = APP.toDbFacility({
        regionId: STATE.profile.regionId, name,
        facilityType: finalType, district: qs('ff_district').value.trim(),
        address: qs('ff_address').value.trim(), contact: qs('ff_contact').value.trim()
      });
      let res;
      if(isEdit) res = await sb.from('facilities').update(row).eq('id', f.id).select().single();
      else res = await sb.from('facilities').insert(row).select().single();
      if(res.error) throw res.error;
      const mapped = APP.mapFacility(res.data);
      const idx = STATE.facilities.findIndex(x => x.id === mapped.id);
      if(idx !== -1) STATE.facilities[idx] = mapped; else STATE.facilities.push(mapped);
      closeModal(); showInfo(isEdit ? 'Facility updated.' : 'Facility added.'); rerenderCurrent();
    }catch(err){
      errEl.textContent = 'Save failed: ' + describeError(err); errEl.classList.add('show');
    }finally{ btn.disabled = false; btn.textContent = isEdit ? 'Save Changes' : 'Add Facility'; }
  });
}

function confirmDeleteFacility(f){
  const equipmentCount = STATE.equipment.filter(e => e.facilityId === f.id).length;
  if(equipmentCount > 0){
    openModal({
      title: 'Cannot Delete Facility', code: f.name,
      bodyHtml: `
        <div class="modal-alert">⚠ <div>
          <strong>${f.name}</strong> still has <strong>${equipmentCount} equipment record${equipmentCount===1?'':'s'}</strong> registered to it.
          Deleting a facility permanently deletes every piece of equipment assigned to it — along with all of that
          equipment's maintenance history, calibration records, and documents. There is no way to undo this.
        </div></div>
        <p style="font-size:13px; color:var(--muted); margin:0;">
          To delete this facility, first <a href="#/equipment" style="color:var(--teal); font-weight:600;">transfer or remove all its equipment</a>, then come back and try again.
        </p>
        <div class="modal-actions"><div class="left"></div><div class="right"><button class="btn-primary" id="fd_ok" style="width:auto;">Got it</button></div></div>
      `
    });
    qs('fd_ok').addEventListener('click', closeModal);
    return;
  }
  const confirmed = window.confirm(
    `Delete "${f.name}"? This facility has no equipment on record, but this will also permanently remove any staff assignments and transfer history tied to it. This cannot be undone.\n\nType nothing needed — click OK to confirm, or Cancel to stop.`
  );
  if(!confirmed) return;
  (async () => {
    try{
      const res = await sb.from('facilities').delete().eq('id', f.id);
      if(res.error) throw res.error;
      STATE.facilities = STATE.facilities.filter(x => x.id !== f.id);
      showInfo('Facility deleted.');
      location.hash = '#/facilities';
    }catch(err){
      showError('Delete failed: ' + describeError(err));
    }
  })();
}

// =====================================================================
// EQUIPMENT INVENTORY (list, search, filter, sort)
// =====================================================================
let eqFilters = { q:'', facility:'', department:'', condition:'', manufacturer:'', cal:'' };
let eqSort = { key:'name', dir:1 };

function renderEquipmentList(){
  setPageTitle('Equipment Inventory');
  const showFacilityCol = isRegionalScoped();
  mainEl().innerHTML = `
    <div class="section-head">
      <h2>Full Equipment Register</h2>
      <span class="hint">Click any row for full details</span>
    </div>
    <div class="controls">
      <div class="search-box"><i class="fa-solid fa-magnifying-glass"></i>
        <input type="text" id="eqSearch" placeholder="Search by name, serial, equipment code or manufacturer…" value="${esc(eqFilters.q)}">
      </div>
      ${showFacilityCol ? `<select id="eqFilterFacility"><option value="">All facilities</option>${STATE.facilities.map(f => `<option value="${f.id}" ${eqFilters.facility===f.id?'selected':''}>${esc(f.name)}</option>`).join('')}</select>` : ''}
      <select id="eqFilterCondition"><option value="">All conditions</option>${CONDITION_OPTIONS.map(c => `<option ${eqFilters.condition===c?'selected':''}>${c}</option>`).join('')}</select>
      <select id="eqFilterCal"><option value="">All calibration statuses</option>${CAL_STATUS_OPTIONS.map(c => `<option ${eqFilters.cal===c?'selected':''}>${c}</option>`).join('')}</select>
      <select id="eqSortSel">
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first</option>
        <option value="critical">Most critical first</option>
        <option value="name">Name (A–Z)</option>
      </select>
      <button class="btn-reset" id="eqReset">Reset filters</button>
      ${canEditEquipment() ? `<button class="btn-add" id="btnAddEquipment"><i class="fa-solid fa-plus"></i> Add Equipment</button>` : ''}
      <button class="btn-secondary" id="btnExportEq"><i class="fa-solid fa-file-arrow-down"></i> Export</button>
      ${canEditEquipment() ? `
      <button class="btn-secondary" id="btnImportEq"><i class="fa-solid fa-file-arrow-up"></i> Import from Excel</button>
      <button class="btn-secondary" id="btnImportTemplate"><i class="fa-solid fa-download"></i> Template</button>
      <input type="file" id="importFileInput" accept=".xlsx,.xls,.csv" style="display:none;">
      ` : ''}
    </div>
    <div class="result-count" id="eqResultCount"></div>
    <div class="table-shell"><div class="table-scroll">
      <table><thead><tr>
        <th class="no-sort">Equipment Code</th><th class="no-sort">Equipment</th>
        ${showFacilityCol ? '<th class="no-sort">Facility</th>' : ''}
        <th class="no-sort">Department</th><th class="no-sort">Condition</th><th class="no-sort">Manufacturer</th>
        <th class="no-sort">Serial No.</th><th class="no-sort">Calibration</th><th class="no-sort">Next Cal.</th>
      </tr></thead><tbody id="eqTableBody"></tbody></table>
    </div></div>
  `;
  qs('eqSearch').addEventListener('input', e => { eqFilters.q = e.target.value; renderEquipmentTableBody(); });
  if(showFacilityCol) qs('eqFilterFacility').addEventListener('change', e => { eqFilters.facility = e.target.value; renderEquipmentTableBody(); });
  qs('eqFilterCondition').addEventListener('change', e => { eqFilters.condition = e.target.value; renderEquipmentTableBody(); });
  qs('eqFilterCal').addEventListener('change', e => { eqFilters.cal = e.target.value; renderEquipmentTableBody(); });
  qs('eqSortSel').addEventListener('change', e => {
    const v = e.target.value;
    if(v==='newest'){ eqSort={key:'createdAt',dir:-1}; } else if(v==='oldest'){ eqSort={key:'createdAt',dir:1}; }
    else if(v==='critical'){ eqSort={key:'critical',dir:-1}; } else { eqSort={key:'name',dir:1}; }
    renderEquipmentTableBody();
  });
  qs('eqReset').addEventListener('click', () => {
    eqFilters = { q:'', facility:'', department:'', condition:'', manufacturer:'', cal:'' };
    renderEquipmentList();
  });
  if(canEditEquipment()) qs('btnAddEquipment').addEventListener('click', () => openEquipmentForm(null));
  qs('btnExportEq').addEventListener('click', () => exportEquipmentCsv(getFilteredEquipment()));
  if(canEditEquipment()){
    qs('btnImportTemplate').addEventListener('click', downloadImportTemplate);
    qs('btnImportEq').addEventListener('click', () => qs('importFileInput').click());
    qs('importFileInput').addEventListener('change', handleImportFileSelected);
  }
  renderEquipmentTableBody();
}

function criticalScore(e){
  if(e.condition === 'NON-FUNCTIONAL') return 0;
  if(isOverdue(e)) return 1;
  if(e.condition === 'NEEDS REPAIR' || e.calibrationStatus === 'OUT OF CALIBRATION' || e.calibrationStatus === 'NOT CALIBRATED') return 2;
  if(e.condition === 'OBSOLETE') return 3;
  return 4;
}
function getFilteredEquipment(){
  const q = eqFilters.q.trim().toLowerCase();
  return STATE.equipment.filter(e => {
    if(eqFilters.facility && e.facilityId !== eqFilters.facility) return false;
    if(eqFilters.condition && e.condition !== eqFilters.condition) return false;
    if(eqFilters.cal && e.calibrationStatus !== eqFilters.cal) return false;
    if(q){
      const hay = `${e.name} ${e.serial||''} ${e.assetCode||''} ${e.manufacturer||''}`.toLowerCase();
      if(hay.indexOf(q) === -1) return false;
    }
    return true;
  });
}
function renderEquipmentTableBody(){
  const showFacilityCol = isRegionalScoped();
  let rows = getFilteredEquipment();
  rows = rows.slice().sort((a,b) => {
    if(eqSort.key === 'critical') return (criticalScore(a) - criticalScore(b)) * eqSort.dir;
    let av = a[eqSort.key], bv = b[eqSort.key];
    av = av || ''; bv = bv || '';
    if(av < bv) return -1*eqSort.dir; if(av > bv) return 1*eqSort.dir; return 0;
  });
  setText('eqResultCount', `Showing ${rows.length} of ${STATE.equipment.length} equipment`);
  const tbody = qs('eqTableBody');
  if(!tbody) return;
  if(rows.length === 0){ tbody.innerHTML = `<tr><td colspan="9"><div class="no-results">No equipment matches these filters.</div></td></tr>`; return; }
  tbody.innerHTML = rows.map(e => `
    <tr data-id="${e.id}">
      <td data-label="Equipment Code" class="mono">${esc(dash(e.assetCode))}</td>
      <td data-label="Equipment" class="name-cell">${esc(e.name)}</td>
      ${showFacilityCol ? `<td data-label="Facility">${esc(facilityName(e.facilityId))}</td>` : ''}
      <td data-label="Department">${esc(dash(e.department))}</td>
      <td data-label="Condition"><span class="pill ${conditionPillClass(e.condition)}">${esc(e.condition)}</span></td>
      <td data-label="Manufacturer">${esc(e.manufacturer)}</td>
      <td data-label="Serial No." class="mono">${esc(dash(e.serial))}</td>
      <td data-label="Calibration"><span class="pill ${calPillClass(e.calibrationStatus)}">${esc(e.calibrationStatus)}</span></td>
      <td data-label="Next Cal." class="mono">${isOverdue(e) ? `<span style="color:#D14343;font-weight:600;">${fmtDate(e.nextCalibration)} ⚠</span>` : fmtDate(e.nextCalibration)}</td>
    </tr>`).join('');
  tbody.querySelectorAll('tr[data-id]').forEach(tr => tr.addEventListener('click', () => { location.hash = '#/equipment/' + tr.getAttribute('data-id'); }));
}

function exportEquipmentCsv(rows){
  const data = rows.map(e => ({
    'Equipment Code': e.assetCode||'', 'Equipment Name': e.name, 'Facility': facilityName(e.facilityId),
    'Department': e.department||'', 'Category': categoryName(e.categoryId), 'Manufacturer': e.manufacturer,
    'Model': e.model||'', 'Serial Number': e.serial||'', 'Condition': e.condition,
    'Installation Date': e.installDate||'', 'Warranty Expiry': e.warrantyExpiry||'',
    'Calibration Status': e.calibrationStatus, 'Next Calibration': e.nextCalibration||'',
    'Location': e.location||'', 'Responsible Person': e.responsiblePerson||''
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  // Force Equipment Code / Serial Number to text so Excel never reinterprets a
  // numeric-looking code as a number on a later re-import.
  ['Equipment Code','Serial Number'].forEach(header => {
    const colIdx = Object.keys(data[0]||{}).indexOf(header);
    if(colIdx === -1) return;
    for(let r = 0; r < data.length; r++){
      const ref = XLSX.utils.encode_cell({ r:r+1, c:colIdx });
      if(ws[ref] && ws[ref].v !== undefined && ws[ref].v !== ''){ ws[ref].t = 's'; ws[ref].v = String(ws[ref].v); }
    }
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Equipment');
  XLSX.writeFile(wb, `Equipment_Export_${new Date().toISOString().slice(0,10)}.xlsx`);
  showInfo('Export started — check your downloads.');
}

// =====================================================================
// EQUIPMENT BULK IMPORT (Excel/CSV) — facility_admin only, scoped to
// their own facility. Parse -> validate -> preview -> confirm -> commit,
// matching existing records by Equipment Code so re-importing an updated
// spreadsheet safely updates rather than duplicates.
// =====================================================================
const IMPORT_COLUMNS = [
  { header:'Equipment Code', field:'assetCode', required:true },
  { header:'Equipment Name', field:'name', required:true },
  { header:'Department', field:'department' },
  { header:'Category', field:'categoryName' },
  { header:'Location', field:'location' },
  { header:'Condition', field:'condition' },
  { header:'Manufacturer', field:'manufacturer' },
  { header:'Model', field:'model' },
  { header:'Serial Number', field:'serial' },
  { header:'Responsible Person', field:'responsiblePerson' },
  { header:'Owner', field:'owner' },
  { header:'Installation Date', field:'installDate' },
  { header:'Warranty Expiry', field:'warrantyExpiry' },
  { header:'Calibration Status', field:'calibrationStatus' },
  { header:'Next Calibration', field:'nextCalibration' },
  { header:'Last Service', field:'lastService' },
  { header:'Serviced By', field:'servicedBy' },
  { header:'Comment', field:'comment' }
];
const IMPORT_DATE_FIELDS = ['installDate','warrantyExpiry','nextCalibration'];
const IMPORT_TEXT_FORCE_FIELDS = ['assetCode','serial']; // identifier columns Excel might otherwise auto-convert to numbers

function excelDateToISO(v){
  if(v === null || v === undefined || v === '') return '';
  if(v instanceof Date){
    const y = v.getFullYear(), m = String(v.getMonth()+1).padStart(2,'0'), d = String(v.getDate()).padStart(2,'0');
    return `${y}-${m}-${d}`;
  }
  const s = String(v).trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m2 = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(s);
  if(m2){
    const a = parseInt(m2[1],10), b = parseInt(m2[2],10), yr = m2[3];
    // Ambiguous d/m vs m/d — if the first part is >12 it must be a day.
    const [day, mon] = a > 12 ? [a, b] : [b, a];
    return `${yr}-${String(mon).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  }
  return s; // leave as-is; validation will flag it if unusable
}

function downloadImportTemplate(){
  const sampleRow = {};
  IMPORT_COLUMNS.forEach(c => { sampleRow[c.header] = ''; });
  sampleRow['Equipment Code'] = 'WR-PHRL-000999';
  sampleRow['Equipment Name'] = 'Example: Blood Pressure Monitor';
  sampleRow['Condition'] = 'FUNCTIONAL';
  sampleRow['Calibration Status'] = 'Not Specified';
  const ws = XLSX.utils.json_to_sheet([sampleRow]);
  ws['!cols'] = IMPORT_COLUMNS.map(c => ({ wch: Math.max(16, c.header.length) }));
  IMPORT_TEXT_FORCE_FIELDS.forEach(field => {
    const colIdx = IMPORT_COLUMNS.findIndex(c => c.field === field);
    if(colIdx === -1) return;
    const ref = XLSX.utils.encode_cell({ r:1, c:colIdx });
    if(ws[ref]){ ws[ref].t = 's'; ws[ref].v = String(ws[ref].v); }
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Equipment Import');
  XLSX.writeFile(wb, 'Equipment_Import_Template.xlsx');
  showInfo('Template downloaded — fill it in and use "Import from Excel" to upload it.');
}

function handleImportFileSelected(e){
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // allow re-selecting the same file later
  if(!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try{
      const wb = XLSX.read(ev.target.result, { type:'array', cellDates:true });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval:'' });
      if(rows.length === 0){ showError('That file has no data rows.'); return; }
      if(rows.length > 2000){ showError(`That file has ${rows.length} rows — imports are capped at 2000 at a time. Split it into smaller batches.`); return; }
      processImportRows(rows);
    }catch(err){
      console.error('import parse failed', err);
      showError('Could not read that file: ' + describeError(err));
    }
  };
  reader.onerror = () => showError('Could not read the selected file.');
  reader.readAsArrayBuffer(file);
}

let pendingEquipmentImport = null;

function processImportRows(rawRows){
  const headerToField = {};
  IMPORT_COLUMNS.forEach(c => { headerToField[c.header] = c.field; });
  const myFacilityId = STATE.profile.facilityId;
  const categoryByName = {};
  STATE.categories.forEach(c => { categoryByName[c.name.trim().toLowerCase()] = c.id; });
  const existingByCode = {};
  STATE.equipment.filter(e => e.facilityId === myFacilityId).forEach(e => {
    if(e.assetCode) existingByCode[e.assetCode.trim().toLowerCase()] = e;
  });

  const toUpdate = [], toInsert = [], invalid = [];
  const seenCodes = {};

  rawRows.forEach((raw, idx) => {
    const rowNum = idx + 2; // header row + 1-indexed
    const rec = {};
    Object.keys(raw).forEach(h => {
      const field = headerToField[h];
      if(!field) return;
      const v = raw[h];
      if(IMPORT_DATE_FIELDS.includes(field)) rec[field] = excelDateToISO(v);
      else rec[field] = (v === null || v === undefined) ? '' : String(v).trim();
    });

    const errs = [];
    if(!rec.name) errs.push('Equipment Name is required');
    if(!rec.assetCode) errs.push('Equipment Code is required');
    if(rec.condition && !CONDITION_OPTIONS.includes(rec.condition)) errs.push(`Condition must be one of: ${CONDITION_OPTIONS.join(', ')}`);
    if(rec.calibrationStatus && !CAL_STATUS_OPTIONS.includes(rec.calibrationStatus)) errs.push(`Calibration Status must be one of: ${CAL_STATUS_OPTIONS.join(', ')}`);
    IMPORT_DATE_FIELDS.forEach(f => { if(rec[f] && !/^\d{4}-\d{2}-\d{2}$/.test(rec[f])) errs.push(`${f} is not a recognizable date (${rec[f]})`); });

    if(!rec.condition) rec.condition = 'FUNCTIONAL';
    if(!rec.calibrationStatus) rec.calibrationStatus = 'Not Specified';
    if(!rec.manufacturer) rec.manufacturer = 'Unknown';
    if(rec.categoryName){
      const match = categoryByName[rec.categoryName.trim().toLowerCase()];
      rec.categoryId = match || null; // unknown category name is ignored, not an error
    }

    if(errs.length){
      invalid.push({ rowNum, name: rec.name || rec.assetCode || '(blank)', errors: errs });
      return;
    }

    const key = rec.assetCode.trim().toLowerCase();
    if(seenCodes[key]){
      invalid.push({ rowNum, name: rec.name, errors: [`Asset Code "${rec.assetCode}" appears more than once in this file (first occurrence used, this row skipped)`] });
      return;
    }
    seenCodes[key] = true;

    const existing = existingByCode[key];
    if(existing) toUpdate.push({ ...rec, id: existing.id });
    else toInsert.push(rec);
  });

  pendingEquipmentImport = { toUpdate, toInsert, invalid };
  renderEquipmentImportPreview();
}

function renderEquipmentImportPreview(){
  const p = pendingEquipmentImport;
  const totalValid = p.toUpdate.length + p.toInsert.length;
  const body = `
    <div class="kv-grid" style="margin-bottom:16px;">
      <div class="kv"><div class="k">Will Update</div><div class="v" style="color:var(--teal)">${p.toUpdate.length} rows</div></div>
      <div class="kv"><div class="k">Will Add</div><div class="v" style="color:var(--ok)">${p.toInsert.length} rows</div></div>
      <div class="kv span2"><div class="k">Will Skip (errors)</div><div class="v" style="color:${p.invalid.length ? 'var(--bad)' : 'var(--muted)'}">${p.invalid.length} rows</div></div>
    </div>
    ${p.invalid.length ? `
    <div style="max-height:220px; overflow-y:auto; border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin-bottom:16px; font-size:12.5px;">
      ${p.invalid.slice(0,50).map(r => `<div style="margin-bottom:6px;"><strong>Row ${r.rowNum}</strong> (${esc(r.name)}): ${esc(r.errors.join('; '))}</div>`).join('')}
      ${p.invalid.length > 50 ? `<div>...and ${p.invalid.length - 50} more</div>` : ''}
    </div>` : ''}
    <p style="font-size:12px; color:var(--muted-2); margin:0 0 16px;">Matched to existing equipment by <strong>Equipment Code</strong> within your facility. Unmatched codes will be added as new records. Unknown Category names are imported without a category rather than rejected.</p>
    <div class="modal-actions"><div class="left"></div><div class="right">
      <button class="btn-secondary" id="eqImportCancel">Cancel</button>
      <button class="btn-primary" id="eqImportConfirm" style="width:auto;" ${totalValid===0?'disabled':''}>Import ${totalValid} row${totalValid===1?'':'s'}</button>
    </div></div>
  `;
  openModal({ title:'Import Preview', code:`${totalValid} valid row(s) of ${totalValid + p.invalid.length} read from file`, bodyHtml: body, wide:true });
  qs('eqImportCancel').addEventListener('click', () => { pendingEquipmentImport = null; closeModal(); });
  qs('eqImportConfirm').addEventListener('click', commitEquipmentImport);
}

async function commitEquipmentImport(){
  const p = pendingEquipmentImport;
  if(!p) return;
  const btn = qs('eqImportConfirm');
  btn.disabled = true; btn.textContent = 'Importing…';
  const myFacilityId = STATE.profile.facilityId;
  let okCount = 0, failCount = 0;
  const failDetails = [];

  for(const rec of p.toUpdate){
    try{
      const row = APP.toDbEquipment({ ...rec, facilityId: myFacilityId });
      const res = await sb.from('equipment').update(row).eq('id', rec.id);
      if(res.error) throw res.error;
      okCount++;
    }catch(err){ failCount++; failDetails.push(`Update ${rec.assetCode}: ${describeError(err)}`); }
  }
  for(const rec of p.toInsert){
    try{
      const row = APP.toDbEquipment({ ...rec, facilityId: myFacilityId });
      const res = await sb.from('equipment').insert(row);
      if(res.error) throw res.error;
      okCount++;
    }catch(err){ failCount++; failDetails.push(`Add ${rec.assetCode}: ${describeError(err)}`); }
  }

  pendingEquipmentImport = null;
  closeModal();
  await APP.refetchTable('equipment');

  if(failCount === 0) showInfo(`Import complete: ${okCount} row(s) applied successfully.`);
  else showError(`Import finished with issues: ${okCount} succeeded, ${failCount} failed. ${failDetails.slice(0,3).join(' | ')}`);
  rerenderCurrent();
}

// ---------------------------------------------------------------------
// Equipment Add/Edit form
// ---------------------------------------------------------------------
function field(id, label, type, value, required){
  return `<div class="form-field"><label>${esc(label)}${required?' *':''}</label><input type="${type}" id="${id}" value="${esc(value||'')}"></div>`;
}
function selectField(id, label, options, current, labelFn){
  return `<div class="form-field"><label>${esc(label)}</label><select id="${id}">${options.map(v => `<option value="${esc(v)}" ${v===current?'selected':''}>${esc(labelFn?labelFn(v):v)}</option>`).join('')}</select></div>`;
}
function textareaField(id, label, value){
  return `<div class="form-field span2"><label>${esc(label)}</label><textarea id="${id}">${esc(value||'')}</textarea></div>`;
}

function openEquipmentForm(rec){
  const isNew = !rec;
  const facilityLocked = isFacilityAdmin() || isEngineer(); // both work within their own facility only; only a (currently unreachable via UI) regional role would see a facility picker
  const r = rec || { name:'', assetCode:'', categoryId:'', department:'', location:'', manufacturer:'', model:'', serial:'',
    condition:'FUNCTIONAL', installDate:'', warrantyExpiry:'', calibrationStatus:'Not Specified', nextCalibration:'',
    responsiblePerson:'', owner:'', facilityId: facilityLocked ? STATE.profile.facilityId : '' };
  const facilityOptions = facilityLocked
    ? `<div class="form-field"><label>Facility</label><input type="text" value="${esc(facilityName(STATE.profile.facilityId))}" disabled></div>`
    : `<div class="form-field"><label>Facility *</label><select id="ef_facility">${STATE.facilities.map(f => `<option value="${f.id}" ${f.id===r.facilityId?'selected':''}>${esc(f.name)}</option>`).join('')}</select></div>`;

  const body = `
    <div class="form-grid">
      ${field('ef_name','Equipment Name','text', r.name, true)}
      ${field('ef_assetCode','Equipment Code','text', r.assetCode, true)}
      ${facilityOptions}
      ${selectField('ef_category','Category', ['', ...STATE.categories.map(c=>c.id)], r.categoryId, v => v ? categoryName(v) : '— none —')}
      ${field('ef_department','Department / Ward','text', r.department)}
      ${field('ef_location','Specific Location','text', r.location)}
      ${selectField('ef_condition','Condition', CONDITION_OPTIONS, r.condition)}
      ${selectField('ef_calibrationStatus','Calibration Status', CAL_STATUS_OPTIONS, r.calibrationStatus)}
      ${field('ef_manufacturer','Manufacturer','text', r.manufacturer)}
      ${field('ef_model','Model','text', r.model)}
      ${field('ef_serial','Serial Number','text', r.serial)}
      ${field('ef_responsiblePerson','Responsible Person','text', r.responsiblePerson)}
      ${field('ef_installDate','Installation Date','date', r.installDate)}
      ${field('ef_warrantyExpiry','Warranty Expiry','date', r.warrantyExpiry)}
      ${field('ef_nextCalibration','Next Calibration','date', r.nextCalibration)}
      ${field('ef_owner','Owner / Department Head','text', r.owner)}
    </div>
    <div class="field-error" id="ef_error"></div>
    <div class="modal-actions">
      <div class="left">${!isNew && canDeleteEquipment() ? '<button class="btn-danger" id="ef_delete">Delete</button>' : ''}</div>
      <div class="right"><button class="btn-secondary" id="ef_cancel">Cancel</button><button class="btn-primary" id="ef_save" style="width:auto;">${isNew?'Add Equipment':'Save Changes'}</button></div>
    </div>
  `;
  openModal({ title: isNew ? 'Add Equipment' : `Editing: ${r.name}`, code: isNew ? 'New record' : (r.assetCode||'—'), bodyHtml: body, wide:true });
  qs('ef_cancel').addEventListener('click', closeModal);
  if(!isNew && canDeleteEquipment()){
    qs('ef_delete').addEventListener('click', () => confirmDeleteEquipment(rec));
  }
  qs('ef_save').addEventListener('click', () => submitEquipmentForm(isNew, rec));
}

async function submitEquipmentForm(isNew, rec){
  const errEl = qs('ef_error'); errEl.classList.remove('show');
  const form = {
    name: qs('ef_name').value.trim(),
    assetCode: qs('ef_assetCode').value.trim(),
    facilityId: (isFacilityAdmin() || isEngineer()) ? STATE.profile.facilityId : qs('ef_facility').value,
    categoryId: qs('ef_category').value || null,
    department: qs('ef_department').value.trim(),
    location: qs('ef_location').value.trim(),
    condition: qs('ef_condition').value,
    calibrationStatus: qs('ef_calibrationStatus').value,
    manufacturer: qs('ef_manufacturer').value.trim() || 'Unknown',
    model: qs('ef_model').value.trim(),
    serial: qs('ef_serial').value.trim(),
    responsiblePerson: qs('ef_responsiblePerson').value.trim(),
    installDate: qs('ef_installDate').value,
    warrantyExpiry: qs('ef_warrantyExpiry').value,
    nextCalibration: qs('ef_nextCalibration').value,
    owner: qs('ef_owner').value.trim()
  };
  if(!form.name){ errEl.textContent = 'Equipment name is required.'; errEl.classList.add('show'); return; }
  if(!form.assetCode){ errEl.textContent = 'Equipment code is required.'; errEl.classList.add('show'); return; }
  if(!form.facilityId){ errEl.textContent = 'Facility is required.'; errEl.classList.add('show'); return; }

  const btn = qs('ef_save'); btn.disabled = true; btn.textContent = 'Saving…';
  try{
    const row = APP.toDbEquipment(form);
    let res;
    if(isNew) res = await sb.from('equipment').insert(row).select().single();
    else res = await sb.from('equipment').update(row).eq('id', rec.id).select().single();
    if(res.error) throw res.error;
    const mapped = APP.mapEquipment(res.data);
    const idx = STATE.equipment.findIndex(d => d.id === mapped.id);
    if(idx !== -1) STATE.equipment[idx] = mapped; else STATE.equipment.push(mapped);
    closeModal(); showInfo(isNew ? 'Equipment added.' : 'Changes saved.'); rerenderCurrent();
  }catch(err){
    errEl.textContent = 'Save failed: ' + describeError(err); errEl.classList.add('show');
  }finally{ btn.disabled = false; btn.textContent = isNew ? 'Add Equipment' : 'Save Changes'; }
}

function confirmDeleteEquipment(rec){
  if(!window.confirm(`Delete "${rec.name}"? This also removes its maintenance, calibration and document history. This cannot be undone.`)) return;
  (async () => {
    try{
      const res = await sb.from('equipment').delete().eq('id', rec.id);
      if(res.error) throw res.error;
      STATE.equipment = STATE.equipment.filter(d => d.id !== rec.id);
      closeModal(); showInfo('Equipment deleted.'); location.hash = '#/equipment';
    }catch(err){ showError('Delete failed: ' + describeError(err)); }
  })();
}

// =====================================================================
// EQUIPMENT DETAIL (tabs: Overview / Maintenance / Calibration / Documents / QR)
// =====================================================================
let eqDetailTab = 'overview';

function renderEquipmentDetail(id){
  const e = equipmentById(id);
  if(!e){
    setPageTitle('Equipment not found');
    mainEl().innerHTML = `<div class="empty-state"><i class="fa-solid fa-magnifying-glass"></i><p>That equipment doesn't exist, or you don't have access to it.<br><a href="#/equipment" style="color:var(--teal); font-weight:600;">Back to inventory</a></p></div>`;
    return;
  }
  setPageTitle(e.name);
  const maint = STATE.maintenance.filter(m => m.equipmentId === id).sort((a,b) => new Date(b.dateReported) - new Date(a.dateReported));
  const cal = STATE.calibration.filter(c => c.equipmentId === id).sort((a,b) => new Date(b.date) - new Date(a.date));
  const docs = STATE.documents.filter(d => d.equipmentId === id).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));

  mainEl().innerHTML = `
    <div style="margin-bottom:14px;"><a href="#/equipment" style="font-size:12.5px; color:var(--teal); font-weight:600; cursor:pointer;"><i class="fa-solid fa-arrow-left"></i> Back to inventory</a></div>
    <div class="section-head">
      <h2 style="text-transform:none; letter-spacing:0; font-size:20px;">${esc(e.name)}</h2>
      <span class="hint">${esc(dash(e.assetCode))} · ${esc(facilityName(e.facilityId))}</span>
    </div>
    ${(canEditEquipment() || canDeleteEquipment()) ? `<div class="controls" style="margin-bottom:6px;">
      ${canEditEquipment() ? `<button class="btn-secondary" id="btnEditEq"><i class="fa-solid fa-pen"></i> Edit</button>` : ''}
      ${canDeleteEquipment() ? `<button class="btn-danger" id="btnDelEq">Delete</button>` : ''}
      ${canRequestTransfers() ? `<button class="btn-add" id="btnTransferEq"><i class="fa-solid fa-truck-fast"></i> Request Transfer</button>` : ''}
    </div>` : ''}
    <div class="tabs">
      <button class="tab-btn active" data-tab="overview"><i class="fa-solid fa-circle-info"></i>Overview</button>
      <button class="tab-btn" data-tab="maintenance"><i class="fa-solid fa-screwdriver-wrench"></i>Maintenance (${maint.length})</button>
      <button class="tab-btn" data-tab="calibration"><i class="fa-solid fa-gauge-high"></i>Calibration (${cal.length})</button>
      <button class="tab-btn" data-tab="documents"><i class="fa-solid fa-folder-open"></i>Documents (${docs.length})</button>
      <button class="tab-btn" data-tab="qr"><i class="fa-solid fa-qrcode"></i>QR Code</button>
    </div>
    <div class="tab-panel active" id="tab-overview"></div>
    <div class="tab-panel" id="tab-maintenance"></div>
    <div class="tab-panel" id="tab-calibration"></div>
    <div class="tab-panel" id="tab-documents"></div>
    <div class="tab-panel" id="tab-qr"></div>
  `;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b===btn));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-'+btn.getAttribute('data-tab')));
      eqDetailTab = btn.getAttribute('data-tab');
      if(eqDetailTab === 'qr') renderQrTab(e);
    });
  });
  const editBtnEq = qs('btnEditEq'); if(editBtnEq) editBtnEq.addEventListener('click', () => openEquipmentForm(e));
  const delBtnEq = qs('btnDelEq'); if(delBtnEq) delBtnEq.addEventListener('click', () => confirmDeleteEquipment(e));
  const tBtn = qs('btnTransferEq'); if(tBtn) tBtn.addEventListener('click', () => openTransferForm(e));
  renderOverviewTab(e);
  renderMaintenanceTab(e, maint);
  renderCalibrationTab(e, cal);
  renderDocumentsTab(e, docs);
}

function kv(label, valueHtml, span2, mono){
  return `<div class="kv${span2?' span2':''}"><div class="k">${esc(label)}</div><div class="v${mono?' mono':''}">${valueHtml}</div></div>`;
}
function renderOverviewTab(e){
  const overdue = isOverdue(e);
  const alertHtml = e.comment ? `<div class="modal-alert" style="margin-bottom:18px;">⚠ <div><strong>Comment:</strong> ${esc(e.comment)}</div></div>` : '';
  qs('tab-overview').innerHTML = `
    ${alertHtml}
    <div class="panel"><div class="kv-grid">
      ${kv('Condition', `<span class="pill ${conditionPillClass(e.condition)}">${esc(e.condition)}</span>`, true)}
      ${kv('Calibration Status', `<span class="pill ${calPillClass(e.calibrationStatus)}">${esc(e.calibrationStatus)}</span>`, true)}
      ${kv('Facility', esc(facilityName(e.facilityId)))}
      ${kv('Category', esc(categoryName(e.categoryId)))}
      ${kv('Department / Ward', esc(dash(e.department)))}
      ${kv('Location', esc(dash(e.location)))}
      ${kv('Manufacturer', esc(e.manufacturer))}
      ${kv('Model', esc(dash(e.model)))}
      ${kv('Serial Number', esc(dash(e.serial)), false, true)}
      ${kv('Equipment Code', esc(dash(e.assetCode)), false, true)}
      ${kv('Installation Date', fmtDate(e.installDate), false, true)}
      ${kv('Warranty Expiry', fmtDate(e.warrantyExpiry), false, true)}
      ${kv('Responsible Person', esc(dash(e.responsiblePerson)))}
      ${kv('Owner', esc(dash(e.owner)))}
      ${kv('Next Calibration', overdue ? `<span style="color:#D14343;font-weight:600">${fmtDate(e.nextCalibration)} — overdue</span>` : fmtDate(e.nextCalibration), true, true)}
    </div></div>
  `;
}

function renderMaintenanceTab(e, maint){
  const canAct = canEditMaintenance();
  qs('tab-maintenance').innerHTML = `
    <div class="controls" style="margin-bottom:14px;">${canAct ? `<button class="btn-add" id="btnNewTicket"><i class="fa-solid fa-plus"></i> Report Issue</button>` : ''}</div>
    ${maint.length === 0 ? `<div class="empty-state"><i class="fa-solid fa-screwdriver-wrench"></i><p>No maintenance tickets recorded for this equipment.</p></div>` : `
    <div class="timeline">${maint.map(m => `
      <div class="timeline-item">
        <div class="timeline-dot" style="background:${m.status==='completed'||m.status==='closed'?'#1E9E64':(m.priority==='critical'?'#D14343':'#C9861A')}"></div>
        <div class="timeline-body">
          <div class="t1"><span>${esc(m.problem)}</span><span class="pill ${statusPillClass(m.status)}">${esc(m.status)}</span></div>
          <div class="t2">Priority: <span class="pill ${priorityPillClass(m.priority)}" style="margin-left:2px;">${esc(m.priority)}</span> &nbsp;·&nbsp; Engineer: ${esc(m.assignedEngineer ? userName(m.assignedEngineer) : 'Unassigned')}${m.cost ? ` · Cost: GHS ${Number(m.cost).toFixed(2)}` : ''}</div>
          <div class="t3">Reported ${fmtDateTime(m.dateReported)} by ${esc(userName(m.reportedBy))}${m.dateCompleted ? ` · Completed ${fmtDateTime(m.dateCompleted)}` : ''}</div>
          ${m.notes ? `<div class="t2" style="margin-top:4px;">${esc(m.notes)}</div>` : ''}
        </div>
      </div>`).join('')}
    </div>`}
  `;
  const btn = qs('btnNewTicket'); if(btn) btn.addEventListener('click', () => openMaintenanceForm(null, e.id));
}

function renderCalibrationTab(e, cal){
  const canAct = canEditMaintenance();
  qs('tab-calibration').innerHTML = `
    <div class="controls" style="margin-bottom:14px;">${canAct ? `<button class="btn-add" id="btnNewCal"><i class="fa-solid fa-plus"></i> Add Calibration Record</button>` : ''}</div>
    ${cal.length === 0 ? `<div class="empty-state"><i class="fa-solid fa-gauge"></i><p>No calibration history recorded for this equipment.</p></div>` : `
    <div class="table-shell"><table><thead><tr><th class="no-sort">Date</th><th class="no-sort">Result</th><th class="no-sort">Performed By</th><th class="no-sort">Certificate</th></tr></thead><tbody>
      ${cal.map(c => `<tr><td data-label="Date" class="mono">${fmtDate(c.date)}</td><td data-label="Result">${esc(c.result)}</td><td data-label="Performed By">${esc(dash(c.performedBy))}</td>
        <td data-label="Certificate">${c.certificateUrl ? `<a href="${esc(c.certificateUrl)}" target="_blank" rel="noopener" style="color:var(--teal); font-weight:600;">View <i class="fa-solid fa-arrow-up-right-from-square" style="font-size:10px;"></i></a>` : '—'}</td></tr>`).join('')}
    </tbody></table></div>`}
  `;
  const btn = qs('btnNewCal'); if(btn) btn.addEventListener('click', () => openCalibrationForm(e.id));
}

function renderDocumentsTab(e, docs){
  const canAct = canEditMaintenance();
  const iconFor = t => t==='Manual' ? 'fa-book' : t==='Certificate' ? 'fa-certificate' : t==='Warranty' ? 'fa-shield-halved' : t==='Photo' ? 'fa-image' : 'fa-file';
  qs('tab-documents').innerHTML = `
    ${canAct ? `
    <div class="panel" style="margin-bottom:16px;">
      <h3>Upload Document</h3>
      <div class="form-grid">
        <div class="form-field"><label>Type</label><select id="doc_type">${DOC_TYPES.map(t=>`<option>${t}</option>`).join('')}</select></div>
        <div class="form-field"><label>File</label><input type="file" id="doc_file"></div>
      </div>
      <div class="field-error" id="doc_error"></div>
      <div class="modal-actions" style="border-top:none; margin-top:10px; padding-top:0;"><div class="left"></div><div class="right"><button class="btn-primary" id="doc_upload" style="width:auto;">Upload</button></div></div>
    </div>` : ''}
    ${docs.length === 0 ? `<div class="empty-state"><i class="fa-solid fa-folder-open"></i><p>No documents uploaded yet.</p></div>` : `
    <div class="panel">${docs.map(d => `
      <div class="doc-row"><i class="fa-solid ${iconFor(d.docType)}"></i>
        <div class="dn">${esc(d.fileName)} <span class="pill neutral" style="margin-left:6px;">${esc(d.docType)}</span></div>
        <div class="dt">${fmtDate(d.createdAt.slice(0,10))}</div>
        <a href="${esc(d.fileUrl)}" target="_blank" rel="noopener" class="icon-btn" title="Open"><i class="fa-solid fa-arrow-up-right-from-square"></i></a>
      </div>`).join('')}</div>`}
  `;
  const upBtn = qs('doc_upload');
  if(upBtn) upBtn.addEventListener('click', () => uploadDocumentFlow(e.id));
}

async function uploadDocumentFlow(equipmentId){
  const errEl = qs('doc_error'); errEl.classList.remove('show');
  const fileInput = qs('doc_file');
  const file = fileInput.files && fileInput.files[0];
  if(!file){ errEl.textContent = 'Choose a file first.'; errEl.classList.add('show'); return; }
  if(file.size > 20 * 1024 * 1024){ errEl.textContent = 'File is too large (max 20MB).'; errEl.classList.add('show'); return; }
  const docType = qs('doc_type').value;
  const btn = qs('doc_upload'); btn.disabled = true; btn.textContent = 'Uploading…';
  try{
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `${equipmentId}/${Date.now()}_${safeName}`;
    const up = await sb.storage.from('documents').upload(path, file);
    if(up.error) throw up.error;
    const pub = sb.storage.from('documents').getPublicUrl(path);
    const insertRes = await sb.from('documents').insert({
      equipment_id: equipmentId, file_name: file.name, file_url: pub.data.publicUrl,
      doc_type: docType, uploaded_by: STATE.session.user.id
    }).select().single();
    if(insertRes.error) throw insertRes.error;
    STATE.documents.push(APP.mapDocument(insertRes.data));
    showInfo('Document uploaded.');
    rerenderCurrent();
  }catch(err){
    errEl.textContent = 'Upload failed: ' + describeError(err); errEl.classList.add('show');
  }finally{ btn.disabled = false; btn.textContent = 'Upload'; }
}

function renderQrTab(e){
  const url = `${location.origin}${location.pathname}#/equipment/${e.id}`;
  qs('tab-qr').innerHTML = `
    <div class="panel">
      <div class="qr-box" id="qrPrintArea">
        <div id="qrCanvasHolder"></div>
        <div class="code-label">${esc(dash(e.assetCode))}</div>
        <div style="font-size:12px; color:var(--muted);">${esc(e.name)} · ${esc(facilityName(e.facilityId))}</div>
      </div>
      <div class="modal-actions" style="border-top:none; margin-top:14px; padding-top:0; justify-content:center;">
        <button class="btn-secondary" id="btnPrintQr"><i class="fa-solid fa-print"></i> Print Label</button>
      </div>
      <p style="text-align:center; font-size:11.5px; color:var(--muted-2); margin-top:10px;">Scanning this code opens this equipment's profile directly (sign-in required).</p>
    </div>
  `;
  const holder = qs('qrCanvasHolder');
  holder.innerHTML = '';
  if(typeof QRCode !== 'undefined'){
    new QRCode(holder, { text:url, width:180, height:180, correctLevel: QRCode.CorrectLevel.M });
  } else {
    holder.innerHTML = `<div class="no-results">QR library failed to load.</div>`;
  }
  qs('btnPrintQr').addEventListener('click', () => window.print());
}

// If the app is opened with #/equipment/:id straight from a QR scan while
// signed out, boot() will run after sign-in and route() will naturally
// land on this same hash — no special-case redirect needed since we
// never navigate away from the target hash during auth.

// ---------------------------------------------------------------------
// New maintenance ticket / calibration record forms (shared by list + detail)
// ---------------------------------------------------------------------
function openMaintenanceForm(ticket, presetEquipmentId){
  const isNew = !ticket;
  // Matches maintenance_update RLS exactly: facility_admin (any ticket at their
  // facility), the specifically-assigned engineer, or regional_admin (region-wide
  // oversight). Anyone else -- including Viewers, and Engineers viewing a ticket
  // that isn't theirs -- gets a read-only summary instead of a form they can't
  // actually save (which previously surfaced as a confusing PostgREST error).
  const canManage = isNew || isRegionalAdmin() || isFacilityAdmin() || (isEngineer() && ticket.assignedEngineer === STATE.session.user.id);
  if(!canManage){
    const e = equipmentById(ticket.equipmentId);
    openModal({
      title: 'Maintenance Ticket', code: `Ticket #${ticket.id.slice(0,8)}`,
      bodyHtml: `
        <div class="kv-grid">
          ${kv('Equipment', esc(e ? e.name : 'Unknown'), true)}
          ${kv('Problem', esc(ticket.problem), true)}
          ${kv('Priority', `<span class="pill ${priorityPillClass(ticket.priority)}">${esc(ticket.priority)}</span>`)}
          ${kv('Status', `<span class="pill ${statusPillClass(ticket.status)}">${esc(ticket.status)}</span>`)}
          ${kv('Assigned Engineer', esc(ticket.assignedEngineer ? userName(ticket.assignedEngineer) : 'Unassigned'))}
        </div>
        <p style="font-size:12.5px; color:var(--muted-2); margin-top:16px;">You have read-only access to this ticket.</p>
      `
    });
    return;
  }
  const r = ticket || { equipmentId: presetEquipmentId||'', problem:'', priority:'medium', status:'reported', notes:'', cost:'' };
  const myFacilityEquipment = isRegionalAdmin() ? STATE.equipment : STATE.equipment.filter(e => e.facilityId === STATE.profile.facilityId);
  const engineers = STATE.users.filter(u => u.role === 'engineer' && (isRegionalAdmin() || u.facilityId === STATE.profile.facilityId));

  const body = `
    <div class="form-grid">
      <div class="form-field span2"><label>Equipment *</label>
        <select id="mf_equipment" ${presetEquipmentId?'disabled':''}>
          ${!presetEquipmentId ? '<option value="">Select equipment…</option>' : ''}
          ${myFacilityEquipment.map(e => `<option value="${e.id}" ${e.id===r.equipmentId?'selected':''}>${esc(e.name)} — ${esc(dash(e.assetCode))}</option>`).join('')}
        </select>
      </div>
      <div class="form-field span2"><label>Problem Description *</label><textarea id="mf_problem">${esc(r.problem)}</textarea></div>
      ${selectField('mf_priority','Priority', PRIORITY_OPTIONS, r.priority, v => v.charAt(0).toUpperCase()+v.slice(1))}
      ${isNew ? '' : selectField('mf_status','Status', MAINT_STATUS_OPTIONS, r.status, v => v.charAt(0).toUpperCase()+v.slice(1))}
      ${!isNew ? `<div class="form-field"><label>Assigned Engineer</label><select id="mf_engineer"><option value="">Unassigned</option>${engineers.map(u => `<option value="${u.id}" ${u.id===r.assignedEngineer?'selected':''}>${esc(u.name)}</option>`).join('')}</select></div>` : ''}
      ${!isNew ? field('mf_cost','Repair Cost (GHS)','number', r.cost) : ''}
      ${!isNew ? textareaField('mf_notes','Engineer Notes / Action Taken', r.notes) : ''}
    </div>
    <div class="field-error" id="mf_error"></div>
    <div class="modal-actions"><div class="left"></div><div class="right">
      <button class="btn-secondary" id="mf_cancel">Cancel</button>
      <button class="btn-primary" id="mf_save" style="width:auto;">${isNew?'Report Issue':'Save Changes'}</button>
    </div></div>
  `;
  openModal({ title: isNew ? 'Report Equipment Issue' : 'Update Maintenance Ticket', code: isNew ? 'New ticket' : `Ticket #${ticket.id.slice(0,8)}`, bodyHtml: body, wide:true });
  qs('mf_cancel').addEventListener('click', closeModal);
  qs('mf_save').addEventListener('click', () => submitMaintenanceForm(isNew, ticket));
}

async function submitMaintenanceForm(isNew, ticket){
  const errEl = qs('mf_error'); errEl.classList.remove('show');
  const equipmentId = qs('mf_equipment') ? qs('mf_equipment').value : ticket.equipmentId;
  const problem = qs('mf_problem').value.trim();
  if(!equipmentId){ errEl.textContent = 'Select the equipment this issue relates to.'; errEl.classList.add('show'); return; }
  if(!problem){ errEl.textContent = 'Describe the problem.'; errEl.classList.add('show'); return; }
  const btn = qs('mf_save'); btn.disabled = true; btn.textContent = 'Saving…';
  try{
    let res;
    if(isNew){
      const row = { equipment_id: equipmentId, reported_by: STATE.session.user.id, problem, priority: qs('mf_priority').value, status:'reported' };
      res = await sb.from('maintenance').insert(row).select().single();
    } else {
      const status = qs('mf_status').value;
      const row = {
        priority: qs('mf_priority').value, status,
        assigned_engineer: qs('mf_engineer').value || null,
        cost: qs('mf_cost').value ? Number(qs('mf_cost').value) : null,
        notes: qs('mf_notes').value.trim() || null,
        date_completed: (status === 'completed' || status === 'closed') ? (ticket.dateCompleted || new Date().toISOString()) : null
      };
      res = await sb.from('maintenance').update(row).eq('id', ticket.id).select().single();
    }
    if(res.error) throw res.error;
    const mapped = APP.mapMaintenance(res.data);
    const idx = STATE.maintenance.findIndex(d => d.id === mapped.id);
    if(idx !== -1) STATE.maintenance[idx] = mapped; else STATE.maintenance.push(mapped);
    closeModal(); showInfo(isNew ? 'Issue reported.' : 'Ticket updated.'); rerenderCurrent();
  }catch(err){
    errEl.textContent = 'Save failed: ' + describeError(err); errEl.classList.add('show');
  }finally{ btn.disabled = false; btn.textContent = isNew ? 'Report Issue' : 'Save Changes'; }
}

function openCalibrationForm(equipmentId){
  const body = `
    <div class="form-grid">
      ${field('cf_date','Calibration Date','date', new Date().toISOString().slice(0,10), true)}
      <div class="form-field"><label>Result *</label><select id="cf_result"><option>Pass</option><option>Fail</option><option>Adjusted</option><option>Conditional Pass</option></select></div>
      ${field('cf_performedBy','Performed By','text', '')}
      ${field('cf_certUrl','Certificate URL (optional)','text', '')}
    </div>
    <div class="field-error" id="cf_error"></div>
    <div class="modal-actions"><div class="left"></div><div class="right">
      <button class="btn-secondary" id="cf_cancel">Cancel</button>
      <button class="btn-primary" id="cf_save" style="width:auto;">Add Record</button>
    </div></div>
  `;
  openModal({ title:'Add Calibration Record', code:'New calibration entry', bodyHtml: body });
  qs('cf_cancel').addEventListener('click', closeModal);
  qs('cf_save').addEventListener('click', async () => {
    const errEl = qs('cf_error'); errEl.classList.remove('show');
    const date = qs('cf_date').value;
    if(!date){ errEl.textContent = 'Calibration date is required.'; errEl.classList.add('show'); return; }
    const btn = qs('cf_save'); btn.disabled = true; btn.textContent = 'Saving…';
    try{
      const row = { equipment_id: equipmentId, date, result: qs('cf_result').value, performed_by: qs('cf_performedBy').value.trim()||null, certificate_url: qs('cf_certUrl').value.trim()||null };
      const res = await sb.from('calibration').insert(row).select().single();
      if(res.error) throw res.error;
      STATE.calibration.push(APP.mapCalibration(res.data));
      closeModal(); showInfo('Calibration record added.'); rerenderCurrent();
    }catch(err){ errEl.textContent = 'Save failed: ' + describeError(err); errEl.classList.add('show'); }
    finally{ btn.disabled = false; btn.textContent = 'Add Record'; }
  });
}

// =====================================================================
// MAINTENANCE MANAGEMENT (kanban workflow)
// =====================================================================
function renderMaintenance(){
  setPageTitle('Maintenance Management');
  const scoped = isRegionalScoped() ? STATE.maintenance : STATE.maintenance.filter(m => { const e = equipmentById(m.equipmentId); return e && e.facilityId === STATE.profile.facilityId; });
  const myTickets = isEngineer() ? scoped.filter(m => m.assignedEngineer === STATE.session.user.id) : scoped;

  const open = myTickets.filter(m => ['reported','assigned','repairing'].includes(m.status)).length;
  const critical = myTickets.filter(m => m.priority === 'critical' && !['completed','closed'].includes(m.status)).length;
  const completedThisMonth = myTickets.filter(m => m.dateCompleted && new Date(m.dateCompleted).getMonth() === new Date().getMonth() && new Date(m.dateCompleted).getFullYear() === new Date().getFullYear()).length;

  mainEl().innerHTML = `
    <div class="kpi-grid" style="grid-template-columns:repeat(3,1fr); margin-bottom:20px;">
      <div class="kpi-card"><div class="lbl"><i class="fa-solid fa-folder-open"></i> Open Repairs</div><div class="val ${open>0?'warn':''}">${open}</div></div>
      <div class="kpi-card"><div class="lbl"><i class="fa-solid fa-triangle-exclamation"></i> Critical Repairs</div><div class="val ${critical>0?'bad':''}">${critical}</div></div>
      <div class="kpi-card"><div class="lbl"><i class="fa-solid fa-circle-check"></i> Completed This Month</div><div class="val ok">${completedThisMonth}</div></div>
    </div>
    <div class="controls">${canEditMaintenance() ? `<button class="btn-add" id="btnNewTicketGlobal"><i class="fa-solid fa-plus"></i> Report Issue</button>` : ''}</div>
    <div class="kanban" id="kanbanBoard"></div>
  `;
  const btn = qs('btnNewTicketGlobal'); if(btn) btn.addEventListener('click', () => openMaintenanceForm(null, null));

  const cols = [
    { key:'reported', label:'Reported' }, { key:'assigned', label:'Assigned' }, { key:'repairing', label:'Repairing' },
    { key:'completed', label:'Completed' }, { key:'closed', label:'Closed' }
  ];
  qs('kanbanBoard').innerHTML = cols.map(col => {
    const items = myTickets.filter(m => m.status === col.key).sort((a,b) => new Date(b.dateReported) - new Date(a.dateReported));
    return `<div class="kanban-col">
      <div class="kanban-col-head"><span>${col.label}</span><span class="pill neutral">${items.length}</span></div>
      <div class="kanban-col-body">
        ${items.length === 0 ? `<div style="text-align:center; color:var(--muted-2); font-size:12px; padding:14px 0;">No tickets</div>` :
          items.map(m => { const e = equipmentById(m.equipmentId); return `
          <div class="kanban-card" data-id="${m.id}">
            <div class="kt">${esc(e ? e.name : 'Unknown equipment')}</div>
            <div class="ke">${esc(m.problem.slice(0,70))}${m.problem.length>70?'…':''}</div>
            <div class="kf"><span class="pill ${priorityPillClass(m.priority)}">${esc(m.priority)}</span><span style="font-size:11px; color:var(--muted-2);">${esc(m.assignedEngineer ? userName(m.assignedEngineer) : 'Unassigned')}</span></div>
          </div>`; }).join('')}
      </div>
    </div>`;
  }).join('');
  document.querySelectorAll('.kanban-card').forEach(card => {
    card.addEventListener('click', () => {
      const m = STATE.maintenance.find(x => x.id === card.getAttribute('data-id'));
      if(m) openMaintenanceForm(m, null);
    });
  });
}

// =====================================================================
// TRANSFERS
// =====================================================================
function renderTransfers(){
  setPageTitle('Equipment Transfers');
  const rows = STATE.transfers.slice().sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  mainEl().innerHTML = `
    <div class="section-head">
      <h2>Transfer Requests</h2>
      <span class="hint">${rows.length} total</span>
    </div>
    <div class="controls">${canRequestTransfers() ? `<button class="btn-add" id="btnNewTransfer"><i class="fa-solid fa-plus"></i> New Transfer Request</button>` : ''}</div>
    <div class="table-shell"><div class="table-scroll">
      <table><thead><tr>
        <th class="no-sort">Equipment</th><th class="no-sort">From</th><th class="no-sort">To</th>
        <th class="no-sort">Requested By</th><th class="no-sort">Status</th><th class="no-sort">Date</th><th class="no-sort">Action</th>
      </tr></thead><tbody id="transferBody"></tbody></table>
    </div></div>
  `;
  const btn = qs('btnNewTransfer'); if(btn) btn.addEventListener('click', () => openTransferForm(null));
  const tbody = qs('transferBody');
  if(rows.length === 0){ tbody.innerHTML = `<tr><td colspan="7"><div class="no-results">No transfer requests yet.</div></td></tr>`; return; }
  tbody.innerHTML = rows.map(t => {
    const e = equipmentById(t.equipmentId);
    const canApprove = canApproveTransfers() && t.status === 'pending';
    const canReceive = isFacilityAdmin() && t.status === 'approved' && t.toFacility === STATE.profile.facilityId;
    return `<tr>
      <td data-label="Equipment" class="name-cell">${esc(e ? e.name : 'Unknown')}${e ? `<div class="mono" style="font-size:11px;color:var(--muted-2);">${esc(dash(e.assetCode))}</div>` : ''}</td>
      <td data-label="From">${esc(facilityName(t.fromFacility))}</td>
      <td data-label="To">${esc(facilityName(t.toFacility))}</td>
      <td data-label="Requested By">${esc(userName(t.requestedBy))}</td>
      <td data-label="Status"><span class="pill ${statusPillClass(t.status)}">${esc(t.status)}</span></td>
      <td data-label="Date" class="mono">${fmtDate(t.createdAt.slice(0,10))}</td>
      <td data-label="Action">${canApprove ? `<button class="btn-secondary btn-sm approve-t" data-id="${t.id}" style="color:var(--ok); border-color:var(--ok);">Approve</button> <button class="btn-secondary btn-sm reject-t" data-id="${t.id}" style="color:var(--bad); border-color:var(--bad);">Reject</button>` : (canReceive ? `<button class="btn-secondary btn-sm receive-t" data-id="${t.id}">Mark Received</button>` : '—')}</td>
    </tr>`;
  }).join('');
  document.querySelectorAll('.approve-t').forEach(b => b.addEventListener('click', () => decideTransfer(b.getAttribute('data-id'), true)));
  document.querySelectorAll('.reject-t').forEach(b => b.addEventListener('click', () => decideTransfer(b.getAttribute('data-id'), false)));
  document.querySelectorAll('.receive-t').forEach(b => b.addEventListener('click', () => markTransferReceived(b.getAttribute('data-id'))));
}

function openTransferForm(presetEquipment){
  const myEquipment = STATE.equipment.filter(e => e.facilityId === STATE.profile.facilityId);
  const otherFacilities = STATE.facilities.filter(f => f.id !== STATE.profile.facilityId);
  const body = `
    <div class="form-grid">
      <div class="form-field span2"><label>Equipment *</label>
        <select id="tf_equipment" ${presetEquipment?'disabled':''}>
          <option value="">Select equipment from your facility…</option>
          ${myEquipment.map(e => `<option value="${e.id}" ${presetEquipment && presetEquipment.id===e.id?'selected':''}>${esc(e.name)} — ${esc(dash(e.assetCode))}</option>`).join('')}
        </select>
      </div>
      <div class="form-field span2"><label>Destination Facility *</label>
        <select id="tf_to">${otherFacilities.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}</select>
      </div>
      ${textareaField('tf_notes','Reason / Notes', '')}
    </div>
    <div class="field-error" id="tf_error"></div>
    <div class="modal-actions"><div class="left"></div><div class="right">
      <button class="btn-secondary" id="tf_cancel">Cancel</button>
      <button class="btn-primary" id="tf_save" style="width:auto;">Submit Request</button>
    </div></div>
  `;
  openModal({ title:'Request Equipment Transfer', code:'Regional Admin approval required', bodyHtml: body });
  qs('tf_cancel').addEventListener('click', closeModal);
  qs('tf_save').addEventListener('click', async () => {
    const errEl = qs('tf_error'); errEl.classList.remove('show');
    const equipmentId = presetEquipment ? presetEquipment.id : qs('tf_equipment').value;
    const toFacility = qs('tf_to').value;
    if(!equipmentId){ errEl.textContent = 'Select the equipment to transfer.'; errEl.classList.add('show'); return; }
    if(!toFacility){ errEl.textContent = 'Select a destination facility.'; errEl.classList.add('show'); return; }
    const btn = qs('tf_save'); btn.disabled = true; btn.textContent = 'Submitting…';
    try{
      const row = { equipment_id: equipmentId, from_facility: STATE.profile.facilityId, to_facility: toFacility, requested_by: STATE.session.user.id, notes: qs('tf_notes').value.trim()||null, status:'pending' };
      const res = await sb.from('transfers').insert(row).select().single();
      if(res.error) throw res.error;
      STATE.transfers.push(APP.mapTransfer(res.data));
      closeModal(); showInfo('Transfer request submitted for regional approval.'); rerenderCurrent();
    }catch(err){ errEl.textContent = 'Submission failed: ' + describeError(err); errEl.classList.add('show'); }
    finally{ btn.disabled = false; btn.textContent = 'Submit Request'; }
  });
}

async function decideTransfer(transferId, approve){
  const verb = approve ? 'approve' : 'reject';
  if(!window.confirm(`Are you sure you want to ${verb} this transfer?`)) return;
  try{
    const res = await sb.rpc('approve_transfer', { p_transfer_id: transferId, p_approve: approve, p_notes: null });
    if(res.error) throw res.error;
    await APP.refetchTable('transfers');
    await APP.refetchTable('equipment');
    showInfo(`Transfer ${approve ? 'approved' : 'rejected'}.`);
    rerenderCurrent();
  }catch(err){ showError('Could not update transfer: ' + describeError(err)); }
}
async function markTransferReceived(transferId){
  try{
    const res = await sb.from('transfers').update({ status:'completed' }).eq('id', transferId).select().single();
    if(res.error) throw res.error;
    const idx = STATE.transfers.findIndex(t => t.id === transferId);
    if(idx !== -1) STATE.transfers[idx] = APP.mapTransfer(res.data);
    showInfo('Transfer marked as received.'); rerenderCurrent();
  }catch(err){ showError('Could not update transfer: ' + describeError(err)); }
}

// =====================================================================
// REPORTS
// =====================================================================
function renderReports(){
  setPageTitle('Reports');
  mainEl().innerHTML = `
    <div class="section-head"><h2>Generate Reports</h2><span class="hint">Export as spreadsheet or print to PDF</span></div>
    <div class="panel-grid3">
      <div class="panel">
        <h3>Equipment Register</h3>
        <p style="font-size:12.5px; color:var(--muted); margin:0 0 14px;">Full inventory list with condition, calibration and location for every piece of equipment in your scope.</p>
        <div style="display:flex; gap:8px;"><button class="btn-secondary" id="repEqCsv"><i class="fa-solid fa-file-arrow-down"></i> Export</button><button class="btn-secondary" id="repEqPrint"><i class="fa-solid fa-print"></i> Print</button></div>
      </div>
      <div class="panel">
        <h3>Maintenance Report</h3>
        <p style="font-size:12.5px; color:var(--muted); margin:0 0 14px;">Repair frequency, average cost and downtime per equipment.</p>
        <div style="display:flex; gap:8px;"><button class="btn-secondary" id="repMaintCsv"><i class="fa-solid fa-file-arrow-down"></i> Export</button><button class="btn-secondary" id="repMaintPrint"><i class="fa-solid fa-print"></i> Print</button></div>
      </div>
      ${isRegionalScoped() ? `
      <div class="panel">
        <h3>Regional Facility Comparison</h3>
        <p style="font-size:12.5px; color:var(--muted); margin:0 0 14px;">Availability and critical shortages across every facility in the region.</p>
        <div style="display:flex; gap:8px;"><button class="btn-secondary" id="repRegionCsv"><i class="fa-solid fa-file-arrow-down"></i> Export</button><button class="btn-secondary" id="repRegionPrint"><i class="fa-solid fa-print"></i> Print</button></div>
      </div>` : ''}
    </div>
    <div id="printArea"></div>
  `;
  qs('repEqCsv').addEventListener('click', () => exportEquipmentCsv(STATE.equipment));
  qs('repEqPrint').addEventListener('click', () => printReport('Equipment Register', buildEquipmentReportHtml()));
  qs('repMaintCsv').addEventListener('click', exportMaintenanceCsv);
  qs('repMaintPrint').addEventListener('click', () => printReport('Maintenance Report', buildMaintenanceReportHtml()));
  const rc = qs('repRegionCsv'); if(rc) rc.addEventListener('click', exportRegionCsv);
  const rp = qs('repRegionPrint'); if(rp) rp.addEventListener('click', () => printReport('Regional Facility Comparison', buildRegionReportHtml()));
}

function buildEquipmentReportHtml(){
  return `<table style="width:100%; border-collapse:collapse; font-size:12px;">
    <thead><tr style="background:#0D1B2E; color:#fff;">${['Equipment Code','Name','Facility','Department','Condition','Manufacturer','Calibration','Next Cal.'].map(h=>`<th style="padding:6px 8px; text-align:left;">${h}</th>`).join('')}</tr></thead>
    <tbody>${STATE.equipment.map(e => `<tr style="border-bottom:1px solid #ddd;">
      <td style="padding:6px 8px;">${esc(dash(e.assetCode))}</td><td style="padding:6px 8px;">${esc(e.name)}</td>
      <td style="padding:6px 8px;">${esc(facilityName(e.facilityId))}</td><td style="padding:6px 8px;">${esc(dash(e.department))}</td>
      <td style="padding:6px 8px;">${esc(e.condition)}</td><td style="padding:6px 8px;">${esc(e.manufacturer)}</td>
      <td style="padding:6px 8px;">${esc(e.calibrationStatus)}</td><td style="padding:6px 8px;">${fmtDate(e.nextCalibration)}</td>
    </tr>`).join('')}</tbody></table>`;
}
function maintenanceStats(){
  const byEquipment = {};
  STATE.maintenance.forEach(m => {
    const e = equipmentById(m.equipmentId);
    if(!e) return;
    const key = e.id;
    if(!byEquipment[key]) byEquipment[key] = { name:e.name, code:e.assetCode, facility:facilityName(e.facilityId), count:0, totalCost:0, totalDowntimeDays:0, completedCount:0 };
    byEquipment[key].count++;
    if(m.cost) byEquipment[key].totalCost += Number(m.cost);
    if(m.dateCompleted && m.dateReported){
      const days = (new Date(m.dateCompleted) - new Date(m.dateReported)) / (1000*60*60*24);
      byEquipment[key].totalDowntimeDays += Math.max(0, days);
      byEquipment[key].completedCount++;
    }
  });
  return Object.values(byEquipment).sort((a,b) => b.count - a.count);
}
function buildMaintenanceReportHtml(){
  const stats = maintenanceStats();
  return `<table style="width:100%; border-collapse:collapse; font-size:12px;">
    <thead><tr style="background:#0D1B2E; color:#fff;">${['Equipment','Facility','Repairs','Total Cost (GHS)','Avg Downtime (days)'].map(h=>`<th style="padding:6px 8px; text-align:left;">${h}</th>`).join('')}</tr></thead>
    <tbody>${stats.map(s => `<tr style="border-bottom:1px solid #ddd;">
      <td style="padding:6px 8px;">${esc(s.name)} <span style="color:#888;">${esc(dash(s.code))}</span></td><td style="padding:6px 8px;">${esc(s.facility)}</td>
      <td style="padding:6px 8px;">${s.count}</td><td style="padding:6px 8px;">${s.totalCost.toFixed(2)}</td>
      <td style="padding:6px 8px;">${s.completedCount ? (s.totalDowntimeDays/s.completedCount).toFixed(1) : '—'}</td>
    </tr>`).join('')}</tbody></table>`;
}
function exportMaintenanceCsv(){
  const stats = maintenanceStats();
  csvDownload(`Maintenance_Report_${new Date().toISOString().slice(0,10)}.xlsx`, stats.map(s => ({
    'Equipment': s.name, 'Equipment Code': s.code||'', 'Facility': s.facility, 'Repair Count': s.count,
    'Total Cost (GHS)': s.totalCost.toFixed(2), 'Avg Downtime (days)': s.completedCount ? (s.totalDowntimeDays/s.completedCount).toFixed(1) : ''
  })));
  showInfo('Export started — check your downloads.');
}
function buildRegionReportHtml(){
  const rows = STATE.facilities.map(f => { const m = computeFacilityMetrics(f.id); return { f, m }; });
  return `<table style="width:100%; border-collapse:collapse; font-size:12px;">
    <thead><tr style="background:#0D1B2E; color:#fff;">${['Facility','District','Total Equipment','Functional %','Faulty','Calibration Overdue'].map(h=>`<th style="padding:6px 8px; text-align:left;">${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr style="border-bottom:1px solid #ddd;">
      <td style="padding:6px 8px;">${esc(r.f.name)}</td><td style="padding:6px 8px;">${esc(dash(r.f.district))}</td>
      <td style="padding:6px 8px;">${r.m.total}</td><td style="padding:6px 8px;">${r.m.pct}%</td>
      <td style="padding:6px 8px;">${r.m.nonFunctional}</td><td style="padding:6px 8px;">${r.m.overdue}</td>
    </tr>`).join('')}</tbody></table>`;
}
function exportRegionCsv(){
  const rows = STATE.facilities.map(f => { const m = computeFacilityMetrics(f.id); return {
    'Facility': f.name, 'District': f.district||'', 'Total Equipment': m.total, 'Functional %': m.pct, 'Faulty': m.nonFunctional, 'Calibration Overdue': m.overdue
  }; });
  csvDownload(`Regional_Comparison_${new Date().toISOString().slice(0,10)}.xlsx`, rows);
  showInfo('Export started — check your downloads.');
}
function printReport(title, bodyHtml){
  const w = window.open('', '_blank');
  if(!w){ showError('Pop-up blocked — allow pop-ups for this site to print reports.'); return; }
  w.document.write(`<!DOCTYPE html><html><head><title>${esc(title)}</title><style>
    body{ font-family:Arial, sans-serif; padding:24px; color:#0D1B2E; } h1{ font-size:18px; margin-bottom:4px; }
    .meta{ font-size:11px; color:#888; margin-bottom:18px; }
  </style></head><body><h1>${esc(title)}</h1><div class="meta">Generated ${new Date().toLocaleString('en-GB')} · Western Region Health Directorate</div>${bodyHtml}</body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 400);
}

// =====================================================================
// USERS
// =====================================================================
function renderUsers(){
  setPageTitle('Users');
  const rows = STATE.users.slice().sort((a,b) => a.name.localeCompare(b.name));
  mainEl().innerHTML = `
    <div class="section-head"><h2>User Accounts</h2><span class="hint">${rows.length} account(s) in your scope</span></div>
    <div class="role-note" style="margin-bottom:16px;"><i class="fa-solid fa-circle-info"></i>&nbsp; New users create their own account from the sign-in screen (starting as read-only Viewer). Assign their role and facility below to grant access.</div>
    <div class="table-shell"><div class="table-scroll">
      <table><thead><tr><th class="no-sort">Name</th><th class="no-sort">Email</th><th class="no-sort">Role</th><th class="no-sort">Facility</th><th class="no-sort">Status</th><th class="no-sort">Action</th></tr></thead>
      <tbody id="usersBody"></tbody></table>
    </div></div>
  `;
  const tbody = qs('usersBody');
  if(rows.length === 0){ tbody.innerHTML = `<tr><td colspan="6"><div class="no-results">No users found.</div></td></tr>`; return; }
  tbody.innerHTML = rows.map(u => `
    <tr>
      <td data-label="Name" class="name-cell">${esc(u.name)}</td>
      <td data-label="Email" class="mono" style="font-size:12px;">${esc(u.email)}</td>
      <td data-label="Role"><span class="pill info">${esc(ROLE_LABELS[u.role]||u.role)}</span></td>
      <td data-label="Facility">${esc(u.facilityId ? facilityName(u.facilityId) : '—')}</td>
      <td data-label="Status"><span class="pill ${u.isActive ? 'ok':'neutral'}">${u.isActive?'Active':'Inactive'}</span></td>
      <td data-label="Action">${canManageUsers() ? `<button class="btn-secondary btn-sm edit-user" data-id="${u.id}">Edit</button>` : '—'}</td>
    </tr>`).join('');
  document.querySelectorAll('.edit-user').forEach(b => b.addEventListener('click', () => openUserForm(STATE.users.find(u => u.id === b.getAttribute('data-id')))));
}

function openUserForm(u){
  const assignableRoles = isRegionalAdmin() ? ROLE_OPTIONS : ['viewer','engineer','facility_director','facility_admin'];
  const facilityOptions = isRegionalAdmin() ? STATE.facilities : STATE.facilities.filter(f => f.id === STATE.profile.facilityId);
  const body = `
    <div class="form-grid">
      <div class="form-field"><label>Name</label><input type="text" value="${esc(u.name)}" disabled></div>
      <div class="form-field"><label>Email</label><input type="text" value="${esc(u.email)}" disabled></div>
      ${selectField('uf_role','Role', assignableRoles, u.role, v => ROLE_LABELS[v]||v)}
      <div class="form-field"><label>Facility</label><select id="uf_facility"><option value="">— none —</option>${facilityOptions.map(f => `<option value="${f.id}" ${f.id===u.facilityId?'selected':''}>${esc(f.name)}</option>`).join('')}</select></div>
      <div class="form-field"><label>Active</label><select id="uf_active"><option value="true" ${u.isActive?'selected':''}>Active</option><option value="false" ${!u.isActive?'selected':''}>Inactive</option></select></div>
    </div>
    <div class="field-error" id="uf_error"></div>
    <div class="modal-actions"><div class="left"></div><div class="right">
      <button class="btn-secondary" id="uf_cancel">Cancel</button>
      <button class="btn-primary" id="uf_save" style="width:auto;">Save Changes</button>
    </div></div>
  `;
  openModal({ title:`Edit User: ${u.name}`, code: u.email, bodyHtml: body });
  qs('uf_cancel').addEventListener('click', closeModal);
  qs('uf_save').addEventListener('click', async () => {
    const errEl = qs('uf_error'); errEl.classList.remove('show');
    const role = qs('uf_role').value;
    const facilityId = qs('uf_facility').value || null;
    const isRegionScopedRole = role === 'regional_admin' || role === 'regional_director';
    if(!isRegionScopedRole && !facilityId){
      errEl.textContent = 'Select a facility — every role except Regional Equipment Manager and Regional Director must belong to one.';
      errEl.classList.add('show');
      return;
    }
    const btn = qs('uf_save'); btn.disabled = true; btn.textContent = 'Saving…';
    try{
      const row = { role, facility_id: isRegionScopedRole ? null : facilityId, is_active: qs('uf_active').value === 'true' };
      row.region_id = isRegionScopedRole ? STATE.profile.regionId : null;
      const res = await sb.from('users').update(row).eq('id', u.id).select().single();
      if(res.error) throw res.error;
      const idx = STATE.users.findIndex(x => x.id === u.id);
      if(idx !== -1) STATE.users[idx] = APP.mapUser(res.data);
      closeModal(); showInfo('User updated.'); rerenderCurrent();
    }catch(err){ errEl.textContent = 'Save failed: ' + describeError(err); errEl.classList.add('show'); }
    finally{ btn.disabled = false; btn.textContent = 'Save Changes'; }
  });
}

// =====================================================================
// SETTINGS
// =====================================================================
// =====================================================================
// HELP GUIDE
// =====================================================================
var helpTab = 'start';
var ROLE_SUMMARIES = [
  { role:'regional_admin', title:'Regional Equipment Manager', icon:'fa-user-shield', pill:'ok',
    blurb:'Full oversight and control across every facility in the region.',
    can:['View every facility, all equipment, maintenance, transfers, and reports region-wide','Add, edit, and delete facilities','Approve or reject equipment transfer requests between facilities','Add, edit, and deactivate any user — including promoting Facility Administrators and Regional Directors','Upload the region banner image shown on the dashboard','Update maintenance tickets across any facility'],
    cannot:['Add or edit individual equipment records directly (that happens at the facility level)'] },
  { role:'regional_director', title:'Regional Director', icon:'fa-eye', pill:'info',
    blurb:'Sees everything a Regional Equipment Manager sees, region-wide — but strictly read-only.',
    can:['View every facility, all equipment, maintenance, transfers, users, and reports region-wide','Export and print reports'],
    cannot:['Add, edit, or delete anything — facilities, equipment, users, tickets, or transfers','Approve transfers or manage users','Change their own role (only a Regional Equipment Manager can add, edit, or remove a Director)'] },
  { role:'facility_admin', title:'Facility Administrator', icon:'fa-hospital-user', pill:'warn',
    blurb:'Runs the day-to-day equipment register for their own facility.',
    can:['Add, edit, and delete equipment at their facility','Import equipment in bulk from an Excel spreadsheet, or export the current register','Report and manage maintenance tickets, and assign them to engineers','Add calibration records and upload documents (manuals, certificates, warranties, photos)','Request equipment transfers to other facilities','Add, edit, and deactivate Viewer, Engineer, Facility Director, and Facility Administrator accounts at their own facility'],
    cannot:['See or act on other facilities\' data','Promote anyone to Regional Equipment Manager or Regional Director'] },
  { role:'facility_director', title:'Facility Director', icon:'fa-building-shield', pill:'info',
    blurb:'Sees everything at their own facility — the facility-level equivalent of a Regional Director. Strictly read-only.',
    can:['View their facility\'s equipment, maintenance tickets, transfers, and staff list','Export and print reports covering their facility'],
    cannot:['Add, edit, or delete anything — equipment, tickets, transfers, or user accounts','Manage users or approve transfers','Change their own role (only a Facility Administrator or Regional Equipment Manager can add, edit, or remove a Facility Director)'] },
  { role:'engineer', title:'Biomedical Engineer', icon:'fa-screwdriver-wrench', pill:'neutral',
    blurb:'Handles hands-on maintenance, equipment condition, and commissioning new equipment at their facility.',
    can:['View their facility\'s equipment and maintenance tickets','Add new equipment records at their facility','Update equipment condition and calibration status','Update maintenance tickets that are assigned to them, add notes and repair cost','Add calibration records and upload documents'],
    cannot:['Delete equipment records (Facility Administrators only)','Manage other users','See or update a maintenance ticket assigned to a different engineer'] },
  { role:'viewer', title:'Viewer', icon:'fa-glasses', pill:'neutral',
    blurb:'Read-only access — for anyone who needs visibility without needing to make changes.',
    can:['View their facility\'s dashboard, equipment register, and maintenance status'],
    cannot:['Add, edit, or delete anything, anywhere'] }
];

function renderHelp(){
  setPageTitle('Help Guide');
  const myRole = STATE.profile.role;
  mainEl().innerHTML = `
    <div class="section-head">
      <h2>How to Use This Platform</h2>
      <span class="hint">You're signed in as ${esc(ROLE_LABELS[myRole]||myRole)}</span>
    </div>
    <div class="tabs">
      <button class="tab-btn ${helpTab==='start'?'active':''}" data-help="start"><i class="fa-solid fa-flag-checkered"></i>Getting Started</button>
      <button class="tab-btn ${helpTab==='roles'?'active':''}" data-help="roles"><i class="fa-solid fa-users"></i>Roles &amp; Permissions</button>
      <button class="tab-btn ${helpTab==='sections'?'active':''}" data-help="sections"><i class="fa-solid fa-list"></i>App Sections</button>
      <button class="tab-btn ${helpTab==='faq'?'active':''}" data-help="faq"><i class="fa-solid fa-circle-question"></i>FAQ</button>
    </div>
    <div id="helpBody"></div>
  `;
  document.querySelectorAll('[data-help]').forEach(btn => {
    btn.addEventListener('click', () => { helpTab = btn.getAttribute('data-help'); rerenderCurrent(); });
  });
  renderHelpBody(myRole);
}

function renderHelpBody(myRole){
  const body = qs('helpBody');
  if(helpTab === 'start'){
    body.innerHTML = `
      <div class="panel" style="margin-bottom:16px;">
        <h3>What is the CEU Regional Platform?</h3>
        <p style="font-size:13.5px; color:var(--muted); line-height:1.6; margin:0;">
          This is the Western Region Health Directorate's clinical engineering equipment management system.
          It tracks medical equipment across every facility in the region — condition, calibration status,
          maintenance history, and equipment transfers — from one place, with each facility responsible for its own
          register and the region able to see the full picture.
        </p>
      </div>
      <div class="panel">
        <h3>Three things to know before you start</h3>
        <div class="timeline">
          <div class="timeline-item"><div class="timeline-dot"></div><div class="timeline-body">
            <div class="t1">New accounts start as read-only Viewers</div>
            <div class="t2">When you first create an account, you can sign in but can't change anything yet. A Regional Equipment Manager or your Facility Administrator needs to assign you a role and facility — ask them once you've signed up.</div>
          </div></div>
          <div class="timeline-item"><div class="timeline-dot"></div><div class="timeline-body">
            <div class="t1">Every equipment record has a QR code</div>
            <div class="t2">Open any piece of equipment and check its "QR Code" tab. Print it and stick it on the physical device — scanning it later opens that exact equipment profile (you'll need to sign in first if you aren't already).</div>
          </div></div>
          <div class="timeline-item"><div class="timeline-dot"></div><div class="timeline-body">
            <div class="t1">Password resets aren't self-service yet</div>
            <div class="t2">If you forget your password, contact your Regional or Facility Administrator directly — they can reset it for you right away.</div>
          </div></div>
        </div>
      </div>
    `;
  } else if(helpTab === 'roles'){
    body.innerHTML = ROLE_SUMMARIES.map(r => `
      <div class="panel" style="margin-bottom:14px; ${r.role===myRole ? 'border-color:var(--teal); box-shadow:0 0 0 2px rgba(30,58,110,0.12);' : ''}">
        <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
          <i class="fa-solid ${r.icon}" style="font-size:16px; color:var(--teal);"></i>
          <h3 style="margin:0;">${esc(r.title)}</h3>
          <span class="pill ${r.pill}">${r.role===myRole?'This is you':esc(ROLE_LABELS[r.role])}</span>
        </div>
        <p style="font-size:13px; color:var(--muted); margin:0 0 10px;">${esc(r.blurb)}</p>
        <div class="kv-grid">
          <div class="kv span2"><div class="k">Can do</div><div class="v">
            <ul style="margin:4px 0 0; padding-left:18px; font-weight:400; font-size:13px; line-height:1.7;">
              ${r.can.map(x => `<li>${esc(x)}</li>`).join('')}
            </ul>
          </div></div>
          <div class="kv span2"><div class="k">Cannot do</div><div class="v">
            <ul style="margin:4px 0 0; padding-left:18px; font-weight:400; font-size:13px; line-height:1.7; color:var(--muted);">
              ${r.cannot.map(x => `<li>${esc(x)}</li>`).join('')}
            </ul>
          </div></div>
        </div>
      </div>
    `).join('');
  } else if(helpTab === 'sections'){
    const sections = [
      { icon:'fa-gauge-high', title:'Dashboard', desc:'Your home screen. Shows key stats (total equipment, functional vs. faulty, calibration overdue), condition and calibration charts, and a "Needs Attention" list of equipment with problems. Regional Equipment Managers and Directors see the whole region; everyone else sees their own facility.' },
      { icon:'fa-hospital', title:'Facilities', desc:'Regional Equipment Managers and Directors only. Lists every facility in the region with a quick health snapshot. Click one to see its full dashboard. Administrators can add, edit, or delete facilities from here.' },
      { icon:'fa-kit-medical', title:'Equipment', desc:'The full equipment register: search, filter, and sort every equipment record. Click any item to see its full profile across five tabs — Overview, Maintenance History, Calibration History, Documents, and QR Code. Facility Administrators and Biomedical Engineers can add and edit equipment (Facility Administrators can also delete, import from Excel, or export the register).' },
      { icon:'fa-screwdriver-wrench', title:'Maintenance', desc:'A kanban board tracking every repair ticket through Reported → Assigned → Repairing → Completed → Closed. Facility Administrators and Engineers can report issues and update tickets; Engineers only see full edit access on tickets assigned to them.' },
      { icon:'fa-truck-fast', title:'Transfers', desc:'Request equipment be moved from one facility to another. Facility Administrators submit requests; Regional Equipment Managers approve or reject them, which automatically relocates the equipment; the receiving facility confirms once it physically arrives.' },
      { icon:'fa-file-lines', title:'Reports', desc:'Export or print the Equipment Register, a Maintenance Report (repair frequency and cost), and — for Regional Equipment Managers and Directors — a Regional Facility Comparison.' },
      { icon:'fa-users-gear', title:'Users', desc:'Manage who has access. Regional Equipment Managers and Facility Administrators can assign roles and facilities; Regional Directors and Facility Directors can view the list but not make changes.' },
      { icon:'fa-gear', title:'Settings', desc:'Update your display name or change your password.' },
      { icon:'fa-arrow-up-right-from-square', title:'CEU Dashboard (Fault Reporting, Installation Request, Equipment Request)', desc:'Three links at the bottom of the sidebar that open the region\'s public equipment-request site in a new tab — for reporting a fault, requesting installation/training on new equipment, or requesting equipment your facility needs. That site is separate from this app and needs no login of its own.' }
    ];
    body.innerHTML = sections.map(s => `
      <div class="panel" style="margin-bottom:12px; display:flex; gap:14px; align-items:flex-start;">
        <i class="fa-solid ${s.icon}" style="font-size:16px; color:var(--teal); margin-top:2px; width:20px; text-align:center;"></i>
        <div><h3 style="margin:0 0 4px;">${esc(s.title)}</h3><p style="font-size:13px; color:var(--muted); margin:0; line-height:1.6;">${esc(s.desc)}</p></div>
      </div>
    `).join('');
  } else if(helpTab === 'faq'){
    const faqs = [
      { q:'I just signed up and can\'t do anything — is that a bug?', a:'No — every new account starts as a read-only Viewer with no facility assigned, on purpose. Ask your Regional or Facility Administrator to assign your role and facility in the Users section, and you\'ll get access right away.' },
      { q:'I forgot my password — what do I do?', a:'Password resets aren\'t self-service yet. Contact your Regional or Facility Administrator and they can reset it for you directly, no email required.' },
      { q:'What\'s the difference between "Functional but Not in Use", "Needs Repair", and "Obsolete"?', a:'These are equipment condition options for anything that isn\'t simply working or broken: "Functional but Not in Use" is working but idle, "Needs Repair" is a known problem not yet critical, and "Obsolete" flags equipment for eventual retirement. All three show up wherever condition is tracked, and "Needs Repair" and "Obsolete" also surface on the "Needs Attention" list.' },
      { q:'How do I add a lot of equipment at once instead of one at a time?', a:'On the Equipment page, Facility Administrators can click "Template" to download a correctly-formatted spreadsheet, fill it in, then click "Import from Excel" to upload it. You\'ll see a preview of what will be added or updated before anything is saved.' },
      { q:'What does the QR code on an equipment page actually do?', a:'It\'s a direct link to that equipment\'s profile page. Print it and attach it to the physical device — anyone who scans it later (and signs in, if they aren\'t already) lands straight on that equipment\'s record.' },
      { q:'Why can\'t I see equipment from another facility?', a:'By design — each facility\'s data is only visible to its own staff, plus Regional Equipment Managers and Regional Directors who oversee the whole region. This keeps each facility\'s register private to the people responsible for it.' },
      { q:'What are the Fault Reporting / Installation Request / Equipment Request links at the bottom of the sidebar?', a:'These open the region\'s public-facing CEU Dashboard in a new tab — a separate tool for submitting a fault report, requesting installation/training on new equipment, or requesting equipment. It doesn\'t need its own login, but you do need to be signed in here first to see the links.' }
    ];
    body.innerHTML = faqs.map((f,i) => `
      <div class="panel" style="margin-bottom:10px;">
        <h3 style="margin:0 0 6px; text-transform:none; letter-spacing:0; font-size:13.5px; color:var(--ink);">${esc(f.q)}</h3>
        <p style="font-size:13px; color:var(--muted); margin:0; line-height:1.6;">${esc(f.a)}</p>
      </div>
    `).join('');
  }
}

function renderSettings(){
  setPageTitle('Settings');
  const p = STATE.profile;
  mainEl().innerHTML = `
    <div class="panel-grid2">
      <div class="panel">
        <h3>Profile</h3>
        <div class="form-grid">
          <div class="form-field span2"><label>Full Name</label><input type="text" id="st_name" value="${esc(p.name)}"></div>
          <div class="form-field"><label>Email</label><input type="text" value="${esc(p.email)}" disabled></div>
          <div class="form-field"><label>Role</label><input type="text" value="${esc(ROLE_LABELS[p.role]||p.role)}" disabled></div>
          <div class="form-field span2"><label>${(p.role==='regional_admin'||p.role==='regional_director')?'Region':'Facility'}</label><input type="text" value="${esc((p.role==='regional_admin'||p.role==='regional_director') ? (STATE.regions.find(r=>r.id===p.regionId)||{}).name||'Not assigned' : (p.facilityId?facilityName(p.facilityId):'Not assigned'))}" disabled></div>
        </div>
        <div class="field-error" id="st_error"></div>
        <div class="modal-actions" style="border-top:none; padding-top:0; justify-content:flex-end;"><button class="btn-primary" id="st_save" style="width:auto;">Save Profile</button></div>
      </div>
      <div class="panel">
        <h3>Change Password</h3>
        <div class="form-grid">
          <div class="form-field span2"><label>New Password (min. 8 characters)</label><input type="password" id="st_newpw"></div>
        </div>
        <div class="field-error" id="st_pw_error"></div>
        <div class="modal-actions" style="border-top:none; padding-top:0; justify-content:flex-end;"><button class="btn-primary" id="st_savepw" style="width:auto;">Update Password</button></div>
      </div>
    </div>
  `;
  qs('st_save').addEventListener('click', async () => {
    const errEl = qs('st_error'); errEl.classList.remove('show');
    const name = qs('st_name').value.trim();
    if(!name){ errEl.textContent = 'Name cannot be empty.'; errEl.classList.add('show'); return; }
    try{
      const res = await sb.from('users').update({ name }).eq('id', p.id).select().single();
      if(res.error) throw res.error;
      STATE.profile = APP.mapUser(res.data);
      showInfo('Profile updated.');
      const el = document.getElementById('userName'); if(el) el.textContent = STATE.profile.name;
    }catch(err){ errEl.textContent = 'Save failed: ' + describeError(err); errEl.classList.add('show'); }
  });
  qs('st_savepw').addEventListener('click', async () => {
    const errEl = qs('st_pw_error'); errEl.classList.remove('show');
    const pw = qs('st_newpw').value;
    if(!pw || pw.length < 8){ errEl.textContent = 'Password must be at least 8 characters.'; errEl.classList.add('show'); return; }
    try{
      const res = await sb.auth.updateUser({ password: pw });
      if(res.error) throw res.error;
      qs('st_newpw').value = '';
      showInfo('Password updated.');
    }catch(err){ errEl.textContent = 'Update failed: ' + describeError(err); errEl.classList.add('show'); }
  });
}

})();
