
// --- Quota enforcement client logic ---
let quotaPollTimer=null, lastQuotaState=null, quotaBlockShown=false;
function pollQuota(){
	const id=(sessionStorage.getItem('currentUserIdentifier')||'').toLowerCase();
	if(!id){ scheduleQuotaPoll(); return; }
	fetch('/api/access/check?identifier='+encodeURIComponent(id)).then(r=>r.json()).then(data=>{
		if(!data.ok) return;
		const q=data.quota||{};
		lastQuotaState=q;
		if(q.exhausted){ showQuotaBlock(q); }
	}).catch(()=>{}).finally(scheduleQuotaPoll);
}
function scheduleQuotaPoll(){ quotaPollTimer=setTimeout(pollQuota, 15000); }
function showQuotaBlock(q){
	if(quotaBlockShown) return; quotaBlockShown=true;
	const el=document.getElementById('quotaBlock'); if(!el) return;
	const msg=document.getElementById('quotaBlockMsg');
	if(msg && q){ msg.textContent='You used '+q.totalUsedMB+' MB out of '+q.totalBundleMB+' MB. Unlock another bundle to continue.'; }
	el.style.display='flex';
}
function dismissQuotaBlock(){ const el=document.getElementById('quotaBlock'); if(el){ el.style.display='none'; } }
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible' && !quotaBlockShown) pollQuota(); });
setTimeout(pollQuota, 4000);

// Enhanced device status checking and session management
let deviceInfo = null;
let deviceStatusTicker = null;

async function checkDeviceStatus() {
	try {
		const response = await fetch('/api/device/status', {
			method: 'GET',
			headers: { 'Accept': 'application/json' }
		});
		
		if (response.ok) {
			const data = await response.json();
			deviceInfo = data.deviceInfo || data;
			console.log('[DEVICE-STATUS]', deviceInfo);
			
			// Update UI with device-specific quota info
			if (data.quota && data.quota.exhausted && !data.quota.unlockEarned) {
				showQuotaBlock(data.quota, 'Device needs to earn access by watching videos');
			}
			
			return data;
		} else if (response.status === 401) {
			console.log('[DEVICE-STATUS] Device not authenticated');
			return null;
		}
	} catch (error) {
		console.error('[DEVICE-STATUS-ERROR]', error);
	}
	return null;
}

async function registerDevice() {
	const id = (sessionStorage.getItem('currentUserIdentifier')||'').toLowerCase();
	if (!id) return null;
	
	try {
		const response = await fetch('/api/device/register', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ identifier: id })
		});
		
		if (response.ok) {
			const data = await response.json();
			deviceInfo = data;
			console.log('[DEVICE-REGISTERED]', data);
			return data;
		}
	} catch (error) {
		console.error('[DEVICE-REGISTER-ERROR]', error);
	}
	return null;
}

function startDeviceStatusMonitoring() {
	if (deviceStatusTicker) return;
	
	deviceStatusTicker = setInterval(async () => {
		const status = await checkDeviceStatus();
		if (!status && !quotaBlockShown) {
			// Device session expired, try to re-register
			await registerDevice();
		}
	}, 30000); // Check every 30 seconds
}

// Initialize device status monitoring
setTimeout(async () => {
	await checkDeviceStatus();
	if (!deviceInfo) {
		await registerDevice();
	}
	startDeviceStatusMonitoring();
}, 2000);

// Hook usage reporting with enhanced device tracking
let demoUsageTicker=null; function startDemoUsage(){ if(demoUsageTicker) return; const id=(sessionStorage.getItem('currentUserIdentifier')||'').toLowerCase(); if(!id) return; const intervalMs = isTouchDevice() ? 60000 : 20000; demoUsageTicker=setInterval(()=>{ if(quotaBlockShown) return; fetch('/api/usage/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifier:id,usedMB:0.2})}).then(r=>r.json()).then(j=>{ if(j.quota && j.quota.exhausted && !j.quota.unlockEarned) showQuotaBlock(j.quota, 'Device needs to earn access'); }).catch(()=>{}); }, intervalMs); }
startDemoUsage();
window.addEventListener('storage',e=>{ if(e.key==='currentUserIdentifier'){ startDemoUsage(); } });
// When a new bundle is granted (frontend closeAccessModal after grantBundle), reset quota block flag
const _origCloseAccessModal=closeAccessModal; closeAccessModal=function(){ quotaBlockShown=false; const el=document.getElementById('quotaBlock'); if(el) el.style.display='none'; return _origCloseAccessModal.apply(this,arguments); };

// Profile initials from identifier (email or phone)
function setInitials(){
	const id=(sessionStorage.getItem('currentUserIdentifier')||'');
	let initials='--';
	try{
		const cached=JSON.parse(sessionStorage.getItem('currentUserProfile')||'null');
		if(cached && (cached.firstName||cached.surname)){
			initials=((cached.firstName||'?').charAt(0)+(cached.surname||'?').charAt(0)).toUpperCase();
		}
		else if(id){
			if(id.includes('@')) initials=id.split('@')[0].slice(0,2).toUpperCase(); else initials=id.slice(-2).toUpperCase();
		}
		// Apply avatar if present
		const chip=document.getElementById('profileChip');
		if(chip){
			if(cached && (cached.avatarUrl||cached.avatarData)){
				chip.style.backgroundImage='url("'+(cached.avatarUrl||cached.avatarData)+'")';
				chip.classList.add('has-avatar');
			}else{
				chip.style.backgroundImage='none';
				chip.classList.remove('has-avatar');
			}
		}
	}catch{}
	const el=document.getElementById('profileInitials'); if(el) el.textContent=initials;
}
setInitials();

const profileChip=document.getElementById('profileChip');
profileChip.addEventListener('click',()=>openProfileDrawer());
profileChip.addEventListener('keydown',e=>{ if(e.key==='Enter' || e.key===' '){ e.preventDefault(); openProfileDrawer(); } });
function toggleProfileMenu(){} // legacy no-op
function closeProfileMenu(){}
// Drawer logic
const drawerBackdrop=document.getElementById('drawerBackdrop');
const profileDrawer=document.getElementById('profileDrawer');
let lastFocusBeforeDrawer=null; let drawerTrapHandler=null;
function openProfileDrawer(){
	lastFocusBeforeDrawer=document.activeElement;
	updateDrawerMenu();
	drawerBackdrop.classList.add('active');
	profileDrawer.classList.add('active');
	// After it's visible, decide if we should vertically center menu
	requestAnimationFrame(()=>{
		const menu=profileDrawer.querySelector('.drawer-menu');
		if(menu){
			const total=profileDrawer.clientHeight;
			const used=profileDrawer.querySelector('header').offsetHeight + menu.scrollHeight + profileDrawer.querySelector('.drawer-footer').offsetHeight;
			if(used < total - 40){
				menu.style.justifyContent='center';
			}else{
				menu.style.justifyContent='flex-start';
			}
		}
	});
	profileChip.setAttribute('aria-expanded','true');
	profileDrawer.removeAttribute('aria-hidden');
	drawerBackdrop.removeAttribute('aria-hidden');
	document.body.style.overflow='hidden';
	// Helper: avoid programmatic focus on touch devices to prevent visual vibration/focus flicker
	function isTouchDevice(){ try{ return (('ontouchstart' in window) || (navigator.maxTouchPoints && navigator.maxTouchPoints>0)); }catch(e){ return false; } }
	setTimeout(()=>{ try{ const first=profileDrawer.querySelector('.drawer-menu button, .drawer-menu a'); if(first && !isTouchDevice()) first.focus(); }catch(e){} },40);
	trapDrawerFocus();
}
function closeProfileDrawer(returnFocus=true){
	profileDrawer.classList.remove('active');
	drawerBackdrop.classList.remove('active');
	profileChip.setAttribute('aria-expanded','false');
	profileDrawer.setAttribute('aria-hidden','true');
	drawerBackdrop.setAttribute('aria-hidden','true');
	document.body.style.overflow='';
	releaseDrawerTrap();
	if(returnFocus && lastFocusBeforeDrawer && !isTouchDevice()) lastFocusBeforeDrawer.focus();
}
drawerBackdrop.addEventListener('click',e=>{ if(e.target===drawerBackdrop) closeProfileDrawer(); });
document.addEventListener('keydown',e=>{ if(e.key==='Escape' && profileDrawer.classList.contains('active')){ e.preventDefault(); closeProfileDrawer(); } });
function trapDrawerFocus(){
	const selectors='button, [href], [tabindex]:not([tabindex="-1"])';
	const focusable=[...profileDrawer.querySelectorAll(selectors)].filter(el=>!el.disabled);
	drawerTrapHandler=function(e){ if(e.key!=='Tab') return; const first=focusable[0]; const last=focusable[focusable.length-1]; if(e.shiftKey){ if(document.activeElement===first){ e.preventDefault(); last.focus(); } } else { if(document.activeElement===last){ e.preventDefault(); first.focus(); } } };
	document.addEventListener('keydown',drawerTrapHandler);
}
function releaseDrawerTrap(){ if(drawerTrapHandler){ document.removeEventListener('keydown',drawerTrapHandler); drawerTrapHandler=null; } }
function updateDrawerMenu(){
	const id=sessionStorage.getItem('currentUserIdentifier');
	const menu=document.getElementById('drawerMenu'); if(!menu) return;
	if(!id){
		menu.innerHTML='\n\t<li><a href="login.html" onclick="closeProfileDrawer(false)">Log In</a></li>\n\t<li><button type="button" onclick="showHelp()">Help & Support</button></li>\n\t<li><button type="button" onclick="openTerms();closeProfileDrawer(false)">Terms & Conditions</button></li>\n';
	} else {
		menu.innerHTML='\n\t<li><button type="button" onclick="openAccountModal();closeProfileDrawer(false)">My Account</button></li>\n\t<li><button type="button" onclick="showUsage()">My Usage</button></li>\n\t<li><button type="button" onclick="showHelp()">Help & Support</button></li>\n\t<li><button type="button" onclick="openTerms();closeProfileDrawer(false)">Terms & Conditions</button></li>\n\t<li><a href="login.html" onclick="sessionStorage.removeItem(\'currentUserIdentifier\');closeProfileDrawer(false)">Log Out</a></li>\n';
	}
	updateProfileChipMenu();
}
function updateProfileChipMenu(){
	const id=sessionStorage.getItem('currentUserIdentifier');
	const changeBtn=document.getElementById('chipChangePassBtn');
	const authLink=document.getElementById('chipAuthLink');
	if(!authLink) return;
	if(!id){
		if(changeBtn) changeBtn.style.display='none';
		authLink.textContent='Log in';
		authLink.onclick=null; // no need to clear storage when logging in
	}else{
		if(changeBtn) changeBtn.style.display='inline-block';
		authLink.textContent='Log out';
		authLink.onclick=function(){ sessionStorage.removeItem('currentUserIdentifier'); };
	}
}
// Initial state
updateDrawerMenu();
// Placeholder functions for menu items
async function showUsage(){
	const currentId=(sessionStorage.getItem('currentUserIdentifier')||'').toLowerCase();
	const admin='sbusisosweetwell15@gmail.com';
	const overlay=document.getElementById('usageOverlay');
	const heading=document.getElementById('usageHeading');
	const adminDashboard = document.getElementById('adminDashboard');
	const regularUsage = document.getElementById('regularUsage');
	
	// Close profile drawer if open (match My Account behavior)
	if(typeof profileDrawer!=='undefined' && profileDrawer.classList.contains('active')){ try{ closeProfileDrawer(false); }catch{} }
	
	overlay.classList.add('active'); overlay.removeAttribute('aria-hidden');
	
	if(!currentId){
		heading.textContent='Usage';
		adminDashboard.style.display = 'none';
		regularUsage.style.display = 'flex';
		document.getElementById('usageHistoryEmpty').style.display='block'; 
		document.getElementById('usageHistoryEmpty').textContent='Please login first to view your usage.'; 
		return;
	}
	
	if(currentId===admin){
		// Show admin dashboard
		heading.textContent='Admin Dashboard';
		adminDashboard.style.display = 'flex';
		regularUsage.style.display = 'none';
		stopAdminAutoRefresh(); // Stop any existing refresh
		loadAdminDashboard();
	} else {
		// Show regular usage for normal users
		heading.textContent='My Usage';
		adminDashboard.style.display = 'none';
		stopAdminAutoRefresh(); // Stop auto-refresh when not admin
		regularUsage.style.display = 'flex';
		loadRegularUsage();
		startRegularUsageAutoRefresh();
	}
}

async function loadAdminDashboard() {
	// Always use a normalized identifier
	const currentId = (sessionStorage.getItem('currentUserIdentifier') || '').toLowerCase();
	const adminLoading = document.getElementById('adminLoading');
	const adminError = document.getElementById('adminError');
	const adminContent = document.getElementById('adminContent');

	try {
		adminLoading.style.display = 'block';
		adminError.style.display = 'none';
		adminContent.style.display = 'none';

	// Load full admin dashboard (includes users, registrations and ads)
	const response = await fetch('/api/admin/dashboard', {
			headers: {
				'X-User-Identifier': currentId
			}
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const data = await response.json();

		if (!data || !data.ok) {
			throw new Error((data && data.message) || 'Failed to load data');
		}

	// Normalize fields from /api/admin/dashboard or fallback to realtime shape
	const summary = data.summary || { totalUsers: data.totalUsers || 0, activeUsers: data.activeUsers || 0 };
	const routers = Array.isArray(data.routersTable) ? data.routersTable : (Array.isArray(data.routers) ? data.routers : []);
	const users = Array.isArray(data.usersTable) ? data.usersTable : (Array.isArray(data.users) ? data.users : []);
	const registrations = Array.isArray(data.registrations) ? data.registrations : [];
	const ads = Array.isArray(data.ads) ? data.ads : (Array.isArray(data.adsTable) ? data.adsTable : []);

		// Update system stats
		const systemStats = document.getElementById('systemStats');
		if (systemStats) {
			systemStats.innerHTML = `
				<div><span style="opacity:.6;">Total Users:</span> <span>${summary.totalUsers || 0}</span></div>
				<div><span style="opacity:.6;">Active Users:</span> <span style="color:var(--brand);font-weight:700;">${summary.activeUsers || 0}</span></div>
				<div><span style="opacity:.6;">Total Routers:</span> <span>${summary.totalRouters || 0}</span></div>
				<div><span style="opacity:.6;">Total Data Served:</span> <span>${(Number(summary.totalDataServed || 0)).toFixed(2)} MB</span></div>
			`;
		}

		// Update network stats
		const networkStats = document.getElementById('networkStats');
		if (networkStats) {
			networkStats.innerHTML = `
				<div><span style="opacity:.6;">Avg Download:</span> <span>${(Number(summary.averageDownMbps || 0)).toFixed(2)} Mbps</span></div>
				<div><span style="opacity:.6;">Avg Upload:</span> <span>${(Number(summary.averageUpMbps || 0)).toFixed(2)} Mbps</span></div>
				<div><span style="opacity:.6;">Last Updated:</span> <span>${new Date(data.timestamp || Date.now()).toLocaleTimeString()}</span></div>
			`;
		}

		// Update routers table
		const routersTableBody = document.querySelector('#adminRoutersTable tbody');
		if (routersTableBody) {
			routersTableBody.innerHTML = routers.map(router => `
				<tr style="border-bottom:1px solid #eee;">
					<td style="padding:8px;font-weight:600;">${router.routerId || ''}</td>
					<td style="padding:8px;">${router.ipAddress || ''}</td>
					<td style="padding:8px;">${router.location || ''}</td>
					<td style="padding:8px;">${(Number(router.totalDataServed || 0)).toFixed(2)} MB</td>
					<td style="padding:8px;font-weight:600;color:var(--brand);">${router.connectedUsers || 0}</td>
					<td style="padding:8px;"><span style="color:#28a745;font-weight:600;">${router.status || 'Unknown'}</span></td>
					<td style="padding:8px;">${(Number(router.downMbps || 0)).toFixed(2)}</td>
					<td style="padding:8px;">${(Number(router.upMbps || 0)).toFixed(2)}</td>
					<td style="padding:8px;">${router.lastMaintenance || '-'}</td>
					<td style="padding:8px;">${Array.isArray(router.flags) ? router.flags.join(', ') : (router.flags || 'None')}</td>
				</tr>
			`).join('');
		}

		// Update users table
		const usersTableBody = document.querySelector('#adminUsersTable tbody');
		if (usersTableBody) {
			usersTableBody.innerHTML = users.map(user => `
				<tr style="border-bottom:1px solid #eee;">
					<td style="padding:6px;font-weight:600;font-size:10px;max-width:120px;overflow:hidden;text-overflow:ellipsis;">${user.identifier || ''}</td>
					<td style="padding:6px;">${user.ip || ''}</td>
					<td style="padding:6px;">${user.wifiNetwork || ''}</td>
					<td style="padding:6px;">${user.routerId || ''}</td>
					<td style="padding:6px;color:var(--brand);font-weight:600;">${(Number(user.downMbps || 0)).toFixed(2)}</td>
					<td style="padding:6px;color:var(--brand);font-weight:600;">${(Number(user.upMbps || 0)).toFixed(2)}</td>
					<td style="padding:6px;">${(Number(user.totalDataMB || 0)).toFixed(2)} MB</td>
					<td style="padding:6px;">${(Number(user.totalUsedMB || 0)).toFixed(2)} MB</td>
					<td style="padding:6px;">${(Number(user.remainingDataMB || 0)).toFixed(2)} MB</td>
					<td style="padding:6px;">${user.connectionDuration || 0} min</td>
					<td style="padding:6px;">${user.lastActivity ? new Date(user.lastActivity).toLocaleTimeString() : '-'}</td>
					<td style="padding:6px;"><span style="color:${user.isActive ? '#007bff' : '#ffc107'};font-weight:600;">${user.status || 'Unknown'}</span></td>
				</tr>
			`).join('');
		}

		// --- Temp unlocks admin functions for My Usage admin panel (guarded) ---
		async function loadTempUnlocksAdmin() {
			const secretEl = document.getElementById('adminSecretLocal');
			const tbody = document.querySelector('#homeTempUnlocksTable tbody');
			if(!secretEl || !tbody){ console.warn('Admin temp unlock UI not present; loadTempUnlocksAdmin is a no-op.'); return; }
			const secret = secretEl.value;
			tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:12px;">Loading...</td></tr>';
			try {
				const res = await fetch('/api/admin/temp-unlocks?secret=' + encodeURIComponent(secret));
				if (!res.ok) throw new Error('Failed to load');
				const data = await res.json();
				if (!data.ok) throw new Error(data.message || 'Failed');
				const rows = data.unlocks || [];
				if (!rows.length) { tbody.innerHTML = '<tr><td colspan="5">No active temp unlocks</td></tr>'; return; }
				tbody.innerHTML = rows.map(r => `
					<tr>
						<td style="padding:8px;font-weight:600;">${r.id}</td>
						<td style="padding:8px;">${r.identifier}</td>
						<td style="padding:8px;">${r.deviceId}</td>
						<td style="padding:8px;">${new Date(r.expiry).toLocaleString()}</td>
						<td style="padding:8px;"><button onclick="revokeUnlockById(${r.id})">Revoke</button></td>
					</tr>
				`).join('');
			} catch (err) {
				tbody.innerHTML = '<tr><td colspan="5" style="color:#c30000;">Error: ' + (err.message||err) + '</td></tr>';
			}
		}

		async function revokeUnlockById(id) {
			const secretEl = document.getElementById('adminSecretLocal');
			if(!secretEl){ console.warn('Admin temp unlock UI not present; revokeUnlockById is a no-op.'); return; }
			const secret = secretEl.value;
			if (!confirm('Revoke unlock ID ' + id + '?')) return;
			try {
				const res = await fetch('/api/admin/temp-unlocks/revoke', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id, secret }) });
				const data = await res.json();
				if (!data.ok) throw new Error(data.message || 'Failed');
				alert('Revoked');
				loadTempUnlocksAdmin();
			} catch (err) { alert('Revoke failed: ' + (err.message||err)); }
		}

		async function bulkRevokeUnlocks() {
			const secretEl = document.getElementById('adminSecretLocal');
			if(!secretEl){ console.warn('Admin temp unlock UI not present; bulkRevokeUnlocks is a no-op.'); return; }
			const secret = secretEl.value;
			const res = await fetch('/api/admin/temp-unlocks?secret=' + encodeURIComponent(secret));
			if (!res.ok) return alert('Failed to load unlocks');
			const data = await res.json(); if (!data.ok) return alert('Failed to load unlocks');
			const rows = (data.unlocks||[]).filter(r => Number(r.expiry) <= Date.now());
			if (!rows.length) return alert('No expired unlocks to revoke');
			if (!confirm('Revoke ' + rows.length + ' expired unlock(s)?')) return;
			let removed=0;
			for (const r of rows) {
				try { const rr = await fetch('/api/admin/temp-unlocks/revoke',{ method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id: r.id, secret }) }); const j = await rr.json(); if (j.ok && j.removed) removed += j.removed; } catch(e) {}
			}
			alert('Revoked '+removed+' rows');
			loadTempUnlocksAdmin();
		}

		// Update registrations table
		const registrationsTableBody = document.querySelector('#adminRegistrationsTable tbody');
		if (registrationsTableBody) {
			registrationsTableBody.innerHTML = registrations.map(reg => `
				<tr style="border-bottom:1px solid #eee;">
					<td style="padding:6px;font-weight:600;font-size:10px;">${reg.userId || reg.identifier || ''}</td>
					<td style="padding:6px;">${reg.email || ''}</td>
					<td style="padding:6px;">${reg.registrationDate ? new Date(reg.registrationDate).toLocaleDateString() : '-'}</td>
					<td style="padding:6px;font-weight:600;color:var(--brand);">${reg.loginCount || 0}</td>
					<td style="padding:6px;">${reg.lastLogin ? new Date(reg.lastLogin).toLocaleString() : '-'}</td>
					<td style="padding:6px;">${reg.lastLoginIP || '-'}</td>
					<td style="padding:6px;max-width:150px;overflow:hidden;text-overflow:ellipsis;">${reg.lastLoginDevice ? reg.lastLoginDevice.substring(0, 50) : '-'}</td>
					<td style="padding:6px;font-weight:600;color:var(--brand);">${reg.profileChangeCount || 0}</td>
					<td style="padding:6px;">${reg.lastProfileChange ? new Date(reg.lastProfileChange).toLocaleString() : '-'}</td>
					<td style="padding:6px;font-weight:600;color:var(--brand);">${reg.passwordResetCount || 0}</td>
					<td style="padding:6px;">${reg.lastPasswordReset ? new Date(reg.lastPasswordReset).toLocaleString() : '-'}</td>
				</tr>
			`).join('');
		}

		// Update ads table
		const adsTableBody = document.querySelector('#adminAdsTable tbody');
		if (adsTableBody) {
			adsTableBody.innerHTML = ads.map(ad => `
				<tr style="border-bottom:1px solid #eee;">
					<td style="padding:6px;font-weight:600;">${ad.adId || ''}</td>
					<td style="padding:6px;max-width:120px;overflow:hidden;text-overflow:ellipsis;">${ad.title || ''}</td>
					<td style="padding:6px;">${ad.type || ''}</td>
					<td style="padding:6px;font-weight:600;color:var(--brand);">${ad.views || 0}</td>
					<td style="padding:6px;font-weight:600;color:var(--brand);">${ad.clicks || 0}</td>
					<td style="padding:6px;font-weight:600;">${ad.ctr ? (Number(ad.ctr).toFixed(2)) : '0.00'}%</td>
					<td style="padding:6px;">${ad.uniqueUsers || 0}</td>
					<td style="padding:6px;">${ad.watchDurationSeconds || 0}</td>
					<td style="padding:6px;max-width:100px;overflow:hidden;text-overflow:ellipsis;">${Array.isArray(ad.routerZones) ? ad.routerZones.join(', ') : (ad.routerZones || '-')}</td>
					<td style="padding:6px;max-width:150px;overflow:hidden;text-overflow:ellipsis;">${ad.ageDemographics ? Object.entries(ad.ageDemographics).map(([k,v]) => `${k}:${v}`).join(', ') : '-'}</td>
				</tr>
			`).join('');
		}

		adminLoading.style.display = 'none';
		adminContent.style.display = 'flex';

		// Start auto-refresh for admin dashboard (every 10 seconds)
		startAdminAutoRefresh();

	} catch (error) {
		console.error('Admin dashboard error:', error);
		if (adminLoading) adminLoading.style.display = 'none';
		if (adminError) {
			adminError.style.display = 'block';
			adminError.textContent = `Error loading dashboard: ${error && error.message ? error.message : 'Unknown error'}`;
		}

		// Retry auto-refresh even on error (every 15 seconds)
		setTimeout(() => {
			if (document.getElementById('adminDashboard') && document.getElementById('adminDashboard').style.display !== 'none') {
				loadAdminDashboard();
			}
		}, 15000);
	}
}

// Auto-refresh functionality for admin dashboard
let adminRefreshTimer = null;
let adminRefreshInterval = 5000; // Refresh every 5 seconds for better accuracy

function startAdminAutoRefresh() {
	// Clear any existing timer
	if (adminRefreshTimer) {
		clearTimeout(adminRefreshTimer);
	}
	
	// Set up smooth auto-refresh every 5 seconds
	adminRefreshTimer = setTimeout(async () => {
		// Only refresh if admin dashboard is still visible
		if (document.getElementById('adminDashboard').style.display !== 'none') {
			try {
				// Silent refresh - don't show loading state to avoid hiccups
				await refreshAdminDataSilently();
			} catch (error) {
				console.error('Silent refresh failed:', error);
			}
			// Continue the refresh cycle
			startAdminAutoRefresh();
		}
	}, adminRefreshInterval);
}

async function refreshAdminDataSilently() {
	const currentId = (sessionStorage.getItem('currentUserIdentifier') || '').toLowerCase();

	try {
	// Load full admin dashboard data without showing loading state
	const response = await fetch('/api/admin/dashboard', {
			headers: {
				'X-User-Identifier': currentId
			}
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const data = await response.json();

		if (!data || !data.ok) {
			throw new Error((data && data.message) || 'Failed to load data');
		}

	// Normalize fields to support both /realtime-usage and /dashboard shapes
	const summary = data.summary || { totalUsers: data.totalUsers || 0, activeUsers: data.activeUsers || 0 };
	const routers = Array.isArray(data.routersTable) ? data.routersTable : (Array.isArray(data.routers) ? data.routers : []);
	const users = Array.isArray(data.usersTable) ? data.usersTable : (Array.isArray(data.users) ? data.users : []);
	const registrations = Array.isArray(data.registrations) ? data.registrations : [];
	const ads = Array.isArray(data.ads) ? data.ads : (Array.isArray(data.adsTable) ? data.adsTable : []);

		// Update system stats silently
		const systemStats = document.getElementById('systemStats');
		if (systemStats) {
			systemStats.innerHTML = `
				<div><span style="opacity:.6;">Total Users:</span> <span>${summary.totalUsers || 0}</span></div>
				<div><span style="opacity:.6;">Active Users:</span> <span style="color:var(--brand);font-weight:700;">${summary.activeUsers || 0}</span></div>
				<div><span style="opacity:.6;">Total Routers:</span> <span>${summary.totalRouters || 0}</span></div>
				<div><span style="opacity:.6;">Total Data Served:</span> <span>${(Number(summary.totalDataServed || 0)).toFixed(2)} MB</span></div>
			`;
		}

		// Update network stats silently with LIVE bandwidth like sports scores
		const networkStats = document.getElementById('networkStats');
		if (networkStats) {
			const totalDown = Number(summary.totalDownMbps || 0);
			const totalUp = Number(summary.totalUpMbps || 0);
			const peakDown = Number(summary.networkPeakDown || 0);
			const peakUp = Number(summary.networkPeakUp || 0);

			// Color coding like sports scores
			const downColor = totalDown > 20 ? '#ff4444' : totalDown > 5 ? '#ff8800' : '#44ff44';
			const upColor = totalUp > 10 ? '#ff4444' : totalUp > 2 ? '#ff8800' : '#44ff44';

			networkStats.innerHTML = `
				<div style="display:flex;justify-content:space-between;margin-bottom:10px;">
					<div style="text-align:center;flex:1;">
						<div style="opacity:.6;font-size:12px;">LIVE DOWNLOAD</div>
						<div style="color:${downColor};font-weight:800;font-size:24px;text-shadow:0 0 5px ${downColor}40;">${totalDown.toFixed(1)}</div>
						<div style="opacity:.8;font-size:11px;">Mbps</div>
					</div>
					<div style="text-align:center;flex:1;">
						<div style="opacity:.6;font-size:12px;">LIVE UPLOAD</div>
						<div style="color:${upColor};font-weight:800;font-size:24px;text-shadow:0 0 5px ${upColor}40;">${totalUp.toFixed(1)}</div>
						<div style="opacity:.8;font-size:11px;">Mbps</div>
					</div>
				</div>
				<div style="display:flex;justify-content:space-between;font-size:11px;opacity:.7;">
					<div>Peak ↓ ${peakDown.toFixed(1)} Mbps</div>
					<div>Peak ↑ ${peakUp.toFixed(1)} Mbps</div>
				</div>
				<div style="margin-top:5px;text-align:center;font-size:10px;opacity:.6;">
					Network Status: <span style="color:var(--brand);">${summary.networkStatus || 'Normal'}</span>
				</div>
			`;
		}

		// Update tables silently
		const routersTableBody = document.querySelector('#adminRoutersTable tbody');
		if (routersTableBody) {
			routersTableBody.innerHTML = routers.map(router => `
				<tr style="border-bottom:1px solid #eee;">
					<td style="padding:8px;font-weight:600;">${router.routerId || ''}</td>
					<td style="padding:8px;">${router.ipAddress || ''}</td>
					<td style="padding:8px;">${router.location || ''}</td>
					<td style="padding:8px;">${(Number(router.totalDataServed || 0)).toFixed(2)} MB</td>
					<td style="padding:8px;font-weight:600;color:var(--brand);">${router.connectedUsers || 0}</td>
					<td style="padding:8px;"><span style="color:#28a745;font-weight:600;">${router.status || 'Unknown'}</span></td>
					<td style="padding:8px;">${(Number(router.downMbps || 0)).toFixed(2)}</td>
					<td style="padding:8px;">${(Number(router.upMbps || 0)).toFixed(2)}</td>
					<td style="padding:8px;">${router.lastMaintenance || '-'}</td>
					<td style="padding:8px;">${Array.isArray(router.flags) ? router.flags.join(', ') : (router.flags || 'None')}</td>
				</tr>
			`).join('');
		}

		const usersTableBody = document.querySelector('#adminUsersTable tbody');
		if (usersTableBody) {
			usersTableBody.innerHTML = users.map(user => `
				<tr style="border-bottom:1px solid #eee;">
					<td style="padding:6px;font-weight:600;font-size:10px;max-width:120px;overflow:hidden;text-overflow:ellipsis;">${user.identifier || ''}</td>
					<td style="padding:6px;">${user.ip || ''}</td>
					<td style="padding:6px;">${user.wifiNetwork || ''}</td>
					<td style="padding:6px;">${user.routerId || ''}</td>
					<td style="padding:6px;color:var(--brand);font-weight:600;">${(Number(user.downMbps || 0)).toFixed(2)}</td>
					<td style="padding:6px;color:var(--brand);font-weight:600;">${(Number(user.upMbps || 0)).toFixed(2)}</td>
					<td style="padding:6px;">${(Number(user.totalDataMB || 0)).toFixed(2)} MB</td>
					<td style="padding:6px;">${(Number(user.remainingDataMB || 0)).toFixed(2)} MB</td>
					<td style="padding:6px;">${user.connectionDuration || 0} min</td>
					<td style="padding:6px;">${user.lastActivity ? new Date(user.lastActivity).toLocaleTimeString() : '-'}</td>
					<td style="padding:6px;"><span style="color:${user.isActive ? '#007bff' : '#ffc107'};font-weight:600;">${user.status || 'Unknown'}</span></td>
				</tr>
			`).join('');
		}

		const registrationsTableBody = document.querySelector('#adminRegistrationsTable tbody');
		if (registrationsTableBody) {
			registrationsTableBody.innerHTML = registrations.map(reg => `
				<tr style="border-bottom:1px solid #eee;">
					<td style="padding:6px;font-weight:600;font-size:10px;">${reg.userId || reg.identifier || ''}</td>
					<td style="padding:6px;">${reg.email || ''}</td>
					<td style="padding:6px;">${reg.dob || '-'}</td>
					<td style="padding:6px;">${reg.registrationDate ? new Date(reg.registrationDate).toLocaleDateString() : '-'}</td>
					<td style="padding:6px;font-weight:600;color:var(--brand);">${reg.loginCount || 0}</td>
					<td style="padding:6px;">${reg.lastLogin ? new Date(reg.lastLogin).toLocaleDateString() + ' ' + new Date(reg.lastLogin).toLocaleTimeString() : '-'}</td>
					<td style="padding:6px;">${reg.lastLoginIP || '-'}</td>
					<td style="padding:6px;max-width:150px;overflow:hidden;text-overflow:ellipsis;">${reg.lastLoginDevice ? reg.lastLoginDevice.substring(0, 50) : '-'}</td>
					<td style="padding:6px;font-weight:600;color:var(--brand);">${reg.profileChangeCount || 0}</td>
					<td style="padding:6px;">${reg.lastProfileChange ? new Date(reg.lastProfileChange).toLocaleDateString() + ' ' + new Date(reg.lastProfileChange).toLocaleTimeString() : '-'}</td>
					<td style="padding:6px;font-weight:600;color:var(--brand);">${reg.passwordResetCount || 0}</td>
					<td style="padding:6px;">${reg.lastPasswordReset ? new Date(reg.lastPasswordReset).toLocaleTimeString() : '-'}</td>
				</tr>
			`).join('');
		}

		if (document.getElementById('adminContent')) {
			document.getElementById('adminContent').style.display = 'flex';
		}

	} catch (error) {
		console.error('Silent refresh error:', error);
		// Let caller handle error; throw to allow retry logic to run
		throw error;
	}
}

function stopAdminAutoRefresh() {
	if (adminRefreshTimer) {
		clearTimeout(adminRefreshTimer);
		adminRefreshTimer = null;
	}
}

async function loadRegularUsage() {
	const currentId = sessionStorage.getItem('currentUserIdentifier');
	const err = document.getElementById('usageError');
	
	// Reset UI
	err.textContent = '';
	document.getElementById('statBundleInUse').textContent='-';
	document.getElementById('statRemaining').textContent='-';
	document.getElementById('statDateTime').textContent=new Date().toLocaleString();
	document.getElementById('statTotalUnlocked').textContent='-';
	document.getElementById('statMostUsedBundle').textContent='-';
	
	const histBody=document.getElementById('usageHistoryBody');
	const histEmpty=document.getElementById('usageHistoryEmpty');
	const headRow = document.querySelector('#usageHistoryTable thead tr');
	
	if(histBody) histBody.innerHTML=''; 
	histEmpty.style.display='none';
	
	try{
		const res=await fetch('/api/me/usage?identifier='+encodeURIComponent(currentId));
		if(!res.ok) throw new Error('HTTP '+res.status);
		const data=await res.json(); if(!data.ok) throw new Error('Bad payload');
		
		// Stats
		document.getElementById('statTotalUnlocked').textContent=data.totalBundleMB+' MB';
		document.getElementById('statRemaining').textContent=data.remainingMB+' MB';
		
		// Active bundle
		const active=[...data.purchases].reverse().find(p=> (p.bundleMB - p.usedMB) > 0);
		document.getElementById('statBundleInUse').textContent=active? active.bundleMB+' MB':'-';
		
		// Most used bundle size
		const counts={}; data.purchases.forEach(p=>{ counts[p.bundleMB]=(counts[p.bundleMB]||0)+1; });
		let most='-'; let max=0; for(const k in counts){ if(counts[k]>max){ max=counts[k]; most=k+' MB'; } }
		document.getElementById('statMostUsedBundle').textContent=most;
		
		// Reset table headers for user view
		if(headRow){ headRow.innerHTML='<th style="text-align:left;padding:8px 10px;position:sticky;top:0;">Bundle</th><th style="text-align:left;padding:8px 10px;position:sticky;top:0;">Used</th><th style="text-align:left;padding:8px 10px;position:sticky;top:0;">Remaining</th><th style="text-align:left;padding:8px 10px;position:sticky;top:0;">Router</th><th style="text-align:left;padding:8px 10px;position:sticky;top:0;">Granted At</th>'; }
		
		if(!data.purchases.length){ histEmpty.style.display='block'; return; }
		
		data.purchases.slice(-25).reverse().forEach(p=>{
			const tr=document.createElement('tr');
			const remaining=Math.max(0,p.bundleMB - p.usedMB);
			tr.innerHTML='<td style="padding:6px 8px;">'+p.bundleMB+' MB</td>'+
						 '<td style="padding:6px 8px;">'+p.usedMB+' MB</td>'+
						 '<td style="padding:6px 8px;">'+remaining+' MB</td>'+
						 '<td style="padding:6px 8px;">'+(p.routerId||'router')+'</td>'+
						 '<td style="padding:6px 8px;">'+new Date(p.grantedAtISO).toLocaleString()+'</td>';
			if(histBody) histBody.appendChild(tr);
		});
	}catch(e){
		console.error('Usage fetch failed', e);
		err.textContent=(e && e.message && e.message.startsWith('HTTP 4'))? 'Not authorized or missing data.' : (e && e.message && e.message.startsWith('TypeError'))? 'Server not reachable.' : 'Error loading your usage';
	}
}
// Auto-refresh regular usage every 1s while the modal is open
let regularUsageTimer = null;
function startRegularUsageAutoRefresh(){
	stopRegularUsageAutoRefresh();
	regularUsageTimer = setInterval(()=>{
		try{ loadRegularUsage(); }catch(e){}
	}, 1000);
}
function stopRegularUsageAutoRefresh(){ if(regularUsageTimer){ clearInterval(regularUsageTimer); regularUsageTimer=null; } }
	document.getElementById('statRemaining').textContent='-';
	document.getElementById('statDateTime').textContent=new Date().toLocaleString();
	document.getElementById('statTotalUnlocked').textContent='-';
	document.getElementById('statMostUsedBundle').textContent='-';
	
	const histBody=document.getElementById('usageHistoryBody');
	const histEmpty=document.getElementById('usageHistoryEmpty');
	
function closeUsage(){ 
	// Stop admin auto-refresh when closing usage modal
	stopAdminAutoRefresh();
	
	const ov=document.getElementById('usageOverlay'); 
	if(ov){ ov.classList.remove('active'); ov.setAttribute('aria-hidden','true'); } 
	const p=document.getElementById('usagePanel'); 
	if(p){ p.classList.remove('active'); p.setAttribute('aria-hidden','true'); } 
}
function showHelp(){ if(typeof profileDrawer!=='undefined' && profileDrawer.classList.contains('active')){ try{ closeProfileDrawer(false); }catch{} } openHelp(); }
function openHelp(){ const ov=document.getElementById('helpOverlay'); if(!ov) return; if(!ov.classList.contains('active')){ ov.classList.add('active'); ov.removeAttribute('aria-hidden'); requestAnimationFrame(()=>{ const h=ov.querySelector('h2'); if(h && !isTouchDevice()) h.focus&&h.focus(); }); } }
function closeHelp(){ const ov=document.getElementById('helpOverlay'); if(!ov) return; ov.classList.remove('active'); ov.setAttribute('aria-hidden','true'); }

function scrollToFooter(){ document.getElementById('siteFooter').scrollIntoView({behavior:'smooth'}); }
function openChangePass(){ document.getElementById('cpPanel').classList.add('active'); }
function closeChangePass(){ document.getElementById('cpPanel').classList.remove('active'); }

// Access modal controls
const accessModal=document.getElementById('accessModal');
let lastFocusedBeforeModal=null;
function openAccessModal(adMode=false){
	lastFocusedBeforeModal=document.activeElement;
	accessModal.classList.add('active');
	accessModal.removeAttribute('aria-hidden');
	if(!adMode){
		// show bundle list
		document.querySelector('.bundle-list').style.display='flex';
		document.getElementById('bundleNote').style.display='block';
		// show lead on small screens when user opens modal
		try{ if(window.matchMedia && window.matchMedia('(max-width:700px)').matches){ const l=accessModal.querySelector('.lead'); if(l) l.style.display='block'; } }catch{}
		document.getElementById('adPlayer').classList.remove('active');
		setTimeout(()=>{ try{ const first=accessModal.querySelector('.bundle-btn'); if(first && !isTouchDevice()){ first.focus(); } }catch(e){} },50);
	}else{
		// hide lead immediately on phones when opening into ad mode
		try{ if(window.matchMedia && window.matchMedia('(max-width:700px)').matches){ const l=accessModal.querySelector('.lead'); if(l) l.style.display='none'; } }catch{}
		setTimeout(()=>{ try{
			// Don't shift focus to the mute button on touch devices (this can cause visual 'vibrate' effects)
			if(!(('ontouchstart' in window) || (navigator.maxTouchPoints && navigator.maxTouchPoints>0))){
				const mute=document.getElementById('muteBtn'); if(mute && !isTouchDevice()) mute.focus();
			}
		}catch(e){}
		},50);
	}
	trapFocus(accessModal);
}
function closeAccessModal(){
	accessModal.classList.remove('active');
	accessModal.setAttribute('aria-hidden','true');
	releaseFocusTrap();
	if(lastFocusedBeforeModal && !isTouchDevice()) lastFocusedBeforeModal.focus();
}
function chooseBundle(size){
	openAccessModal(true); // keep modal open but switch to ad player
	startAdSequence(size);
}
// Close on overlay click
accessModal.addEventListener('click',e=>{ if(e.target===accessModal) closeAccessModal(); });
document.addEventListener('keydown',e=>{ if(e.key==='Escape' && accessModal.classList.contains('active')) closeAccessModal(); });

// Basic focus trap implementation
let focusTrapHandler=null;
function trapFocus(container){
	const selectors='button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
	const focusable=[...container.querySelectorAll(selectors)].filter(el=>!el.hasAttribute('disabled'));
	function handler(e){
		if(e.key!=='Tab') return;
		const first=focusable[0];
		const last=focusable[focusable.length-1];
		if(e.shiftKey){ if(document.activeElement===first){ e.preventDefault(); last.focus(); } }
		else { if(document.activeElement===last){ e.preventDefault(); first.focus(); } }
	}
	focusTrapHandler=handler;
	document.addEventListener('keydown',handler);
}
function releaseFocusTrap(){ if(focusTrapHandler){ document.removeEventListener('keydown',focusTrapHandler); focusTrapHandler=null; } }

// Inline ad sequence logic
const adPlayer=document.getElementById('adPlayer');
// Router / session helpers
function detectRouterId(){
	// Basic heuristic: use hostname (could refine later with backend-provided ID)
	return (location.hostname||'default').replace(/[^a-zA-Z0-9_-]/g,'') || 'default';
}
let sessionPingTimer=null;
function startSessionPing(){
	const identifier=(sessionStorage.getItem('currentUserIdentifier')||'').toLowerCase();
	if(!identifier) return;
	const send=()=>{ fetch('/api/session/ping',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifier, routerId:detectRouterId()})}).catch(()=>{}); };
	send();
	clearInterval(sessionPingTimer); sessionPingTimer=setInterval(send, 60*1000); // every minute
}
startSessionPing();
const adVideo=document.getElementById('adVideo');
const skipBtn=document.getElementById('skipBtn');
const muteBtn=document.getElementById('muteBtn');
const playPauseBtn=document.getElementById('playPauseBtn');
const fsBtn=document.getElementById('fsBtn');
const adSequenceLabel=document.getElementById('adSequenceLabel');
const adStatus=document.getElementById('adStatus');
const adProgressInline=document.getElementById('adProgressInline');
const videoLoading=document.getElementById('videoLoading');
const toast=document.getElementById('globalToast');
let adList=[];let currentAdIndex=0;let skipTimer=null;let progressInterval=null;let bundleSizeSelected=0;let adGrantTimeout=null;let skipCountdownStarted=false;let skipFallbackTimer=null;let videoStartStamp=0;let autoSkipTimer=null;let skipCountdownPaused=false;
// Track full ad sequence activity for persistent wake lock
let adSequenceActive=false;
// Persisted mute helpers (centralized)
function getPersistedMute(){ try{ return localStorage.getItem('adMuted'); }catch(e){ return null; } }
function setPersistedMute(v){ try{ if(v===null) localStorage.removeItem('adMuted'); else localStorage.setItem('adMuted', v); }catch(e){} }
function updateMuteButton(){ try{ if(!muteBtn) return; const isMuted = adVideo && adVideo.muted; muteBtn.classList.toggle('active', isMuted); muteBtn.textContent = isMuted ? 'Unmute' : 'Mute'; }catch(e){} }
// --- Ad metrics helpers ---
let currentAdViewLogged=false;
let adQuartilesSent=null; // track sent quartile milestones
function adIdentifierForEntry(entry){
	if(!entry) return 'unknown-ad';
	if(entry.id) return 'yt_'+entry.id; // YouTube id
	if(entry.url) return (entry.adId)||('vid_'+entry.url.split('/').slice(-1)[0].split('?')[0]);
	if(entry.images) return 'img_'+(entry.images[0]||'set');
	return 'ad_'+currentAdIndex;
}
async function logAdEvent(eventType, extra){
	try {
		const identifier=(sessionStorage.getItem('currentUserIdentifier')||'').toLowerCase();
		const entry=adList[currentAdIndex];
		const adId=adIdentifierForEntry(entry);
		const resp = await fetch('/api/ad/event',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({adId,identifier,eventType,watchSeconds: extra && extra.watchSeconds || 0, routerId: detectRouterId() })});
		if(!resp.ok){ console.warn('Ad event failed', eventType, resp.status); try { showToast && showToast('Ad metric save failed '+resp.status); } catch{} }
		else {
			try {
				const data=await resp.json();
				console.log('[AD-EVENT-RESPONSE]', data);
				
				// Enhanced device unlock handling
				if(data.bundleUpgrade && data.bundleUpgrade.deviceId) {
					const message = data.bundleUpgrade.message || `Device unlocked! ${data.bundleUpgrade.bundleMB}MB granted`;
					showToast(message, 'success');
					
					// Update device info
					if (deviceInfo) {
						deviceInfo.unlocked = true;
						deviceInfo.bundleMB = data.bundleUpgrade.bundleMB;
					}
					
					// Refresh device status
					setTimeout(async () => {
						await checkDeviceStatus();
					}, 1000);
				}
				
				if(data.rewards && data.rewards.length){
					const messages = data.rewards.join(', ');
					showToast(messages, 'success');
				}
				
				if(data.quota){ 
					lastQuotaState=data.quota; 
					if(data.quota.remainingMB>0 && quotaBlockShown){ 
						quotaBlockShown=false; 
						dismissQuotaBlock(); 
					} 
				}
			}catch(parseErr){
				console.error('[AD-EVENT-PARSE-ERROR]', parseErr);
			}
		}
	} catch(err){ console.warn('logAdEvent failed', eventType, err?.message); }
}

// 20 royalty-free short stock clips (Pixabay / Pexels style CDN links; replace with my own ads when ready)
// Stable short sample/public-domain clips (mix of samplelib & MDN & w3c) – replace with my ad CDN later
// MP4 direct clips (fast load) - Using more reliable video sources with better browser compatibility
const mp4Ads=[
	// More reliable test videos with broader codec support
	'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
	'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
	'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
	'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
	'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4',
	'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
	'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeltdowns.mp4',
	'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
	'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/SubaruOutbackOnStreetAndDirt.mp4',
	'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4',
	// Fallback to basic working test videos
	'https://www.learningcontainer.com/wp-content/uploads/2020/05/sample-mp4-file.mp4',
	'https://sample-videos.com/zip/10/mp4/SampleVideo_1280x720_1mb.mp4',
	// Local fallback videos (create simple test videos)
	'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAAAAGlzb21pc28yYXZjMQAAAKBtZGF0AAAAFwX//9hAAACc2F2YQEAAAC4mFhYtAAPgAAAADAAcAVyAd2QXgBgAAA=='
];

// Optional high-quality / adaptive streaming sources (4K capable) 
// These demo manifests do NOT contain Dolby Atmos – they are placeholders showing how to integrate adaptive streams.
// To truly offer Dolby Atmos you must: (1) license/ingest Atmos-encoded content (E-AC-3 JOC), (2) ensure device/browser support (limited in browsers),
// (3) provide fallback AAC stereo. Never label audio "Dolby Atmos" unless it actually contains Atmos metadata.
const adaptiveAds=[
	{ type:'hls', url:'https://storage.googleapis.com/shaka-demo-assets/angel-one-hls/hls.m3u8', label:'Angel One (HLS 4K demo)' },
	{ type:'dash', url:'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd', label:'Big Buck Bunny (DASH 4K demo)' }
	// Add your own hosted HLS (.m3u8) or DASH (.mpd) manifests with multiple video + audio tracks.
];

// Spatial audio simulation (NOT Dolby Atmos). Auto‑activates AFTER user unmutes (Netflix‑style) – no on‑screen toggle.
const USE_SPATIAL_AUDIO_SIM=true; // set false to disable
let spatialAudioCtx=null, spatialPanner=null, spatialSourceNode=null, spatialAnimating=false, spatialPending=true;
function enableSpatialAudioSimulation(){
	if(!USE_SPATIAL_AUDIO_SIM) return;
	// Only start once user has actively unmuted (policy friendly + expected UX)
	if(adVideo.muted){ spatialPending=true; return; }
	if(spatialAudioCtx) return; // already active
	try{
		const C=window.AudioContext||window.webkitAudioContext; if(!C) return;
		const ctx=new C();
		const source=ctx.createMediaElementSource(adVideo);
		const panner=ctx.createPanner();
		panner.panningModel='HRTF';
		panner.distanceModel='inverse';
		panner.positionZ.setValueAtTime(-1, ctx.currentTime); // slightly in front
		source.connect(panner).connect(ctx.destination);
		spatialAudioCtx=ctx; spatialPanner=panner; spatialSourceNode=source; spatialPending=false;
		spatialAnimating=true;
		let start=performance.now();
		(function orbit(){
			if(!spatialAnimating || !spatialAudioCtx) return;
			const t=(performance.now()-start)/1000; const r=0.6;
			const x=Math.cos(t*0.15)*r; const y=Math.sin(t*0.07)*0.2; const z=-0.8+Math.sin(t*0.11)*0.15;
			try{
				panner.positionX.setValueAtTime(x,ctx.currentTime);
				panner.positionY.setValueAtTime(y,ctx.currentTime);
				panner.positionZ.setValueAtTime(z,ctx.currentTime);
			}catch{}
			requestAnimationFrame(orbit);
		})();
	}catch(e){ console.warn('Spatial audio sim failed',e); }
}
function disableSpatialAudioSimulation(){ spatialAnimating=false; if(spatialAudioCtx){ try{ spatialAudioCtx.close(); }catch{} spatialAudioCtx=null; spatialPanner=null; spatialSourceNode=null; spatialPending=true; } }
// React to user unmute / volume change to (re)start spatial pipeline
adVideo.addEventListener('volumechange',()=>{ if(!adVideo.muted){ enableSpatialAudioSimulation(); if(spatialAudioCtx && spatialAudioCtx.state==='suspended'){ spatialAudioCtx.resume().catch(()=>{}); } } });

// HLS / DASH support detection & dynamic loader
function supportsNativeHls(){
	const v=document.createElement('video');
	return v.canPlayType('application/vnd.apple.mpegurl') || v.canPlayType('application/x-mpegURL');
}
function loadScriptOnce(src){ return new Promise((res,rej)=>{ if(document.querySelector('script[data-src="'+src+'"]')) return res(); const s=document.createElement('script'); s.src=src; s.async=true; s.setAttribute('data-src',src); s.onload=()=>res(); s.onerror=()=>rej(new Error('load '+src)); document.head.appendChild(s); }); }
let hlsLibReady=false; let dashLibReady=false;
async function ensureHls(){ if(hlsLibReady) return true; try{ await loadScriptOnce('https://cdn.jsdelivr.net/npm/hls.js@1.5.7/dist/hls.min.js'); hlsLibReady= !!window.Hls; }catch{} return hlsLibReady; }
async function ensureDash(){ if(dashLibReady) return true; try{ await loadScriptOnce('https://cdn.jsdelivr.net/npm/dashjs@4.7.3/dist/dash.all.min.js'); dashLibReady= !!window.dashjs; }catch{} return dashLibReady; }

// Decide whether to include high-quality adaptive ads based on device & connection
function allowHighQualityAds(){
	const conn=navigator.connection||{}; const effective=conn.effectiveType||''; // 'slow-2g','2g','3g','4g'
	const bigScreen= (window.devicePixelRatio*Math.max(screen.width,screen.height)) >= 3000; // rough 1440p+
	const goodNet = !effective || /^(4g|wifi)$/i.test(effective);
	return bigScreen && goodNet; // tighten criteria so we don't burn data on small/slow devices
}

async function setupAdaptivePlayback(manifest){
	// manifest.type: hls | dash
	if(manifest.type==='hls'){
		if(supportsNativeHls()){
			adVideo.src=manifest.url; adVideo.load();
		} else if(await ensureHls()){
			if(window.Hls.isSupported()){
				const hls=new window.Hls({ maxMaxBufferLength:30 });
				hls.loadSource(manifest.url); hls.attachMedia(adVideo);
			} else { adVideo.src=manifest.url; }
		} else { throw new Error('HLS lib failed'); }
	} else if(manifest.type==='dash'){
		if(await ensureDash()){
			const player=window.dashjs.MediaPlayer().create();
			player.initialize(adVideo, manifest.url, true);
		} else { adVideo.src=manifest.url; }
	}
}

// Requested YouTube video IDs (public links). We'll embed with autoplay & mute. Add more as needed.
const ytAds=[
	'P9vKxPUFers',
	'eUUmpBFoF7I',
	'YlXHVIsxpO0',
	'DQqhzrtAFdQ',
	'BnDUqZZvs94',
	'efD3-nMdqv0',
	'5On7eaFT-Js',
	'XatOfS-_fF0',
	'ZbsiKjVAV28'
	// Bing hosted video not directly embeddable without extraction; skip for now
];

// Unified pool marks type
const adPool=[
	...mp4Ads.map(u=>({type:'mp4',url:u})),
	...ytAds.map(id=>({type:'yt',id}))
];

// Lightweight image fallback assets (could be local or remote). Replace URLs with your own creatives.
const imgAds=[
 'https://picsum.photos/seed/isn1/800/450',
 'https://picsum.photos/seed/isn2/800/450',
 'https://picsum.photos/seed/isn3/800/450',
 'https://picsum.photos/seed/isn4/800/450'
];

// Advertising source mode toggles
const USE_YOUTUBE_ONLY=false; // we now prefer Google MP4 clips again
const USE_MP4_ONLY=true;      // focus on faster-loading Google-hosted MP4 sample videos. If you still see black (audio-only) playback, set this to false to allow auto YouTube fallback.

// --- YouTube API integration (non-interrupting mute/unmute) ---
let ytApiLoaded=false, ytPlayerReady=false, ytPlayerInstance=null, pendingYtId=null;
function loadYouTubeAPI(){
	if(ytApiLoaded) return; ytApiLoaded=true;
	const tag=document.createElement('script'); tag.src='https://www.youtube.com/iframe_api'; document.head.appendChild(tag);
}
window.onYouTubeIframeAPIReady=function(){
	ytPlayerInstance=new YT.Player('ytPlayer',{
		videoId: pendingYtId||'',
		playerVars:{autoplay:1,controls:0,rel:0,playsinline:1,modestbranding:1,enablejsapi:1,mute:1},
		events:{
			'onReady':()=>{ ytPlayerReady=true; if(pendingYtId){ ytPlayerInstance.loadVideoById(pendingYtId); pendingYtId=null; }
				// Start muted for guaranteed autoplay
				try{ ytPlayerInstance.mute(); ytPlayerInstance.playVideo(); }catch{}
			},
			'onStateChange':(e)=>{ if(e.data===YT.PlayerState.PLAYING){ adStatus.textContent='Playing'; simulateYtProgress(); maybeStartSkipCountdown(); handlePlaybackStateChange(true); if(!currentAdViewLogged){ currentAdViewLogged=true; logAdEvent('view'); }
				// Attempt gentle unmute after short delay (will stay muted if policy blocks with no user gesture beyond initial click)
				setTimeout(()=>{ try{ ytPlayerInstance.unMute(); if(ytPlayerInstance.isMuted()){ /* stays muted */ muteBtn.classList.add('active'); muteBtn.textContent='Unmute'; } else { muteBtn.classList.remove('active'); muteBtn.textContent='Mute'; } }catch{} },400);
			} else if(e.data===YT.PlayerState.PAUSED || e.data===YT.PlayerState.ENDED){ handlePlaybackStateChange(false); } }
		}
	});
};
function playYouTubeAd(id){
	const yt=document.getElementById('ytPlayer');
	adVideo.style.display='none'; yt.style.display='block';
	if(!ytApiLoaded) loadYouTubeAPI();
	if(ytPlayerReady && ytPlayerInstance){ ytPlayerInstance.loadVideoById(id); /* try unmuted after state change */ }
	else pendingYtId=id;
	adStatus.textContent='Loading...';
}
function simulateYtProgress(){
	cancelAnimationFrame(progressInterval); adProgressInline.style.width='0%';
	function frame(){
		if(!ytPlayerInstance) return;
		let d=0,c=0; try{ d=ytPlayerInstance.getDuration(); c=ytPlayerInstance.getCurrentTime(); }catch{}
		if(d && c>=0){ adProgressInline.style.width=Math.min(100,(c/d)*100)+'%'; }
		if(ytPlayerInstance.getPlayerState && ytPlayerInstance.getPlayerState()===YT.PlayerState.PLAYING) progressInterval=requestAnimationFrame(frame);
	}
	progressInterval=requestAnimationFrame(frame);
}

function startAdSequence(bundleSize){
	bundleSizeSelected=bundleSize;
	// Initialize video tracking variables
	videoStartTime = null;
	videoWatchTime = 0;
	videoCompletionValidated = false;
	
	const adCount=bundleSize===100?5:bundleSize===250?10:15;
	let basePool;
	if(USE_MP4_ONLY) basePool=mp4Ads.map(u=>({type:'mp4',url:u}));
	else if(USE_YOUTUBE_ONLY) basePool=ytAds.map(id=>({type:'yt',id}));
	else basePool=adPool;
	const shuffled=[...basePool].sort(()=>Math.random()-0.5);
		adList=shuffled.slice(0,adCount);
		// If the available pool is smaller than the requested adCount, repeat items to reach the expected length
		if(adList.length < adCount && shuffled.length){
			let idx = 0;
			while(adList.length < adCount){
				// Push copies of entries from the shuffled pool to reach adCount
				adList.push(Object.assign({}, shuffled[idx % shuffled.length]));
				idx++;
			}
		}
	// Optionally inject one adaptive (potential 4K) stream at start if device suitable
	try{
		if(allowHighQualityAds() && adaptiveAds.length){
			const hi=adaptiveAds[Math.floor(Math.random()*adaptiveAds.length)];
			adList.unshift({ type: hi.type, url: hi.url,adaptive:true, label: hi.label });
		}
	}catch{}
	currentAdIndex=0;
	adSequenceActive=true; // mark sequence active
	requestWakeLock(); // ensure wake lock from very start (before first video plays)
	forceStartMobileKeepAwake(); // new: always start mobile fallback early
	if(typeof HARD_WAKE_MODE!=='undefined' && HARD_WAKE_MODE){ try{ ensureHardWake(); }catch{} }
	if(typeof EXTREME_WAKE_MODE!=='undefined' && EXTREME_WAKE_MODE){ try{ startExtremeWake(); }catch{} }
	// Hide bundle controls/note and the lead on phones so the UI matches previous behaviour
	document.querySelector('.bundle-list').style.display='none';
	document.getElementById('bundleNote').style.display='none';
	try{ if(window.matchMedia && window.matchMedia('(max-width:700px)').matches){ const l=document.querySelector('#accessModal .lead'); if(l) l.style.display='none'; } }catch{}
	adPlayer.classList.add('active');
	playCurrentInlineAd();
	// Ensure next ad is warmed immediately for smoother transitions
	try{ preloadNextAdIfNeeded(); }catch{}
	// Safeguard: if the video is unexpectedly paused after UI changes, try to resume once active
	setTimeout(()=>{ try{ const v=adVideo; if(v && v.paused && adPlayer.classList.contains('active')){ v.play().catch(()=>{}); } }catch{} },350);
}

// Build an initial queued adList when the home page loads so ads are in-line and preloaded
function initAdQueue() {
	try{
		// Default bundle size for pre-queue (small) so we don't consume too much data
		const defaultCount = 5;
				if(!adList || !adList.length){
						// Try to fetch server-driven playlist first
						try{
								fetch(`/api/ads/playlist?count=${defaultCount}&routerId=${encodeURIComponent(detectRouterId())}`)
									.then(r=>r.json())
									.then(j=>{
										if(j && j.ok && Array.isArray(j.playlist) && j.playlist.length){
											adList = j.playlist;
											currentAdIndex = 0;
											console.log('[AD-QUEUE] Using server playlist', adList.length);
											setTimeout(()=>{ try{ preloadNextAdIfNeeded(); }catch{} }, 200);
											return;
										}
									}).catch(()=>{});
						}catch{}

						const basePool = USE_MP4_ONLY ? mp4Ads.map(u=>({type:'mp4',url:u})) : adPool;
						const shuffled = [...basePool].sort(()=>Math.random()-0.5);
						adList = shuffled.slice(0, defaultCount);
			currentAdIndex = 0;
			console.log('[AD-QUEUE] Initialized adQueue with', adList.length, 'items');
			// Preload the next ad immediately
			setTimeout(()=>{ try{ preloadNextAdIfNeeded(); }catch{} }, 200);
		}
	}catch(e){ console.warn('[AD-QUEUE-INIT-ERR]', e && e.message); }
}

function detectRouterId(){
	try{
		if(window && window.ROUTER_ID) return window.ROUTER_ID;
		const m = location.search.match(/[?&]routerId=([^&]+)/);
		if(m) return decodeURIComponent(m[1]);
	}catch(e){}
	return '';
}

// Initialize on DOM ready
if(document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(initAdQueue, 120);
else document.addEventListener('DOMContentLoaded', ()=>setTimeout(initAdQueue, 120));

// Helper: ensure ad playback resumes when the player gains focus or becomes active
function ensureAdPlaybackOnFocus(){
	try{
		const v=adVideo;
		if(!v) return;
		if(adPlayer.classList.contains('active')){
			if(v.paused) v.play().catch(()=>{});
		}
	}catch{}
}
function playCurrentInlineAd(){
	clearAdTimers();
	const entry=adList[currentAdIndex];
	const yt=document.getElementById('ytPlayer');
	const thumb=document.getElementById('adThumb');
	const imgFallback=document.getElementById('imgFallback');
	adVideo.style.display='none'; yt.style.display='none';
	// Apply persisted/global mute preference so subsequent ads follow user choice
	const persisted = getPersistedMute();
	if(persisted==='unmuted'){ adVideo.muted = false; } else if(persisted==='muted'){ adVideo.muted = true; } else { adVideo.muted = isTouchDevice() ? true : false; }
	// Ensure native controls are disabled during ad playback
	try{ adVideo.removeAttribute('controls'); adVideo.controls = false; adVideo.disablePictureInPicture = true; }catch(e){}
	if(muteBtn){ updateMuteButton(); }
	adStatus.textContent='Loading...';
	skipBtn.classList.remove('enabled'); skipBtn.disabled=true; skipBtn.textContent='Skip (10)';
	skipCountdownStarted=false;
	adProgressInline.style.width='0%';
	imgFallback.classList.remove('active'); imgFallback.innerHTML='<div style="position:absolute;bottom:12px;left:12px;font-size:12px;background:rgba(0,0,0,.5);padding:4px 10px;border-radius:20px;">Sponsored</div>';
	
	if(entry.type==='mp4' || entry.type==='hls' || entry.type==='dash'){
		// clear youtube src if any
		if(ytPlayerInstance && ytPlayerReady){ try{ ytPlayerInstance.stopVideo(); }catch{} }
		videoLoading.classList.remove('hidden');
		// Reset any previous force flags
		delete adVideo._forceSeekDone; delete adVideo._reloadAttempt;
		adVideo.classList.remove('visible');
		adVideo.removeAttribute('src');
			adVideo.currentTime=0; adVideo.volume=1; adVideo.style.display='block'; videoStartStamp=performance.now(); visibilityLoop();
			// Track last known time to prevent seeking/scrubbing during ad sequence
			adVideo._lastKnownTime = 0;
			adVideo.addEventListener('timeupdate', function(){ try{ adVideo._lastKnownTime = adVideo.currentTime; }catch(e){} });
			adVideo.addEventListener('seeking', function(ev){ try{ if(adSequenceActive){ // block seek
				if(Math.abs(adVideo.currentTime - (adVideo._lastKnownTime||0))>0.5){ adVideo.currentTime = adVideo._lastKnownTime || 0; }
				}
			}catch(e){} });
		
		// Enhanced video loading with format validation
		(async()=>{
			try{
				if(entry.type==='mp4'){
					// Enhanced MP4 loading with codec detection
					console.log('[VIDEO-LOADING] Attempting to load:', entry.url);
					
					// Test if browser can play this video format
					const canPlay = adVideo.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
					console.log('[VIDEO-CODEC] Can play H.264 MP4:', canPlay);
					
					if(canPlay === '') {
						console.warn('[VIDEO-CODEC] Browser may not support H.264, trying anyway...');
					}
					
					// Tune video element for faster starts
					try{ adVideo.setAttribute('playsinline',''); adVideo.preload='auto'; adVideo.removeAttribute('controls'); }catch{}
					// Warm the connection with a lightweight range HEAD (if CORS allows) to reduce latency on some CDNs
					(async()=>{
						try{
							await fetch(entry.url, { method: 'HEAD', mode:'cors', cache:'no-cache' });
						}catch(e){ /* HEAD may be blocked by CORS; ignore */ }
						// Now set the src and load
						adVideo.src = entry.url;
						adVideo._retryCount = 0;
						adVideo._maxRetries = 3;
						adVideo._currentEntry = entry;
						adVideo.load();
						// Error handler with backoff
						adVideo._onerrorHandler = async function(){
							try{
								adVideo._retryCount = (adVideo._retryCount||0) + 1;
								if(adVideo._retryCount <= adVideo._maxRetries){
									const wait = 250 * Math.pow(2, adVideo._retryCount-1);
									console.warn('[VIDEO-ERROR] retry', adVideo._retryCount, 'waiting', wait);
									setTimeout(()=>{ try{ adVideo.load(); adVideo.play().catch(()=>{}); }catch{} }, wait);
								} else {
									console.error('[VIDEO-ERROR] max retries reached, using fallback');
									tryVideoFallback();
								}
							}catch(e){ tryVideoFallback(); }
						};
						adVideo.addEventListener('error', adVideo._onerrorHandler);
					})();

								// When metadata is loaded, try to play immediately for fastest start
								adVideo.addEventListener('loadedmetadata', function onMeta(){ adVideo.removeEventListener('loadedmetadata', onMeta); try{ adVideo.play().catch(()=>{}); }catch{} });
					
				}else{
					await setupAdaptivePlayback(entry);
				}
			}catch(e){ 
				console.warn('[VIDEO-LOAD] Adaptive load failed, trying fallback:', e); 
				tryVideoFallback();
			}
		})();
		
		// Enhanced play attempt with better error handling
		const tryPlay = async () => {
			try {
				await adVideo.play();
				console.log('[VIDEO-PLAY] Success');
			} catch(playErr) {
				console.warn('[VIDEO-PLAY] Initial play failed:', playErr);
				// Try again after a delay
				setTimeout(async () => {
					try {
						await adVideo.play();
						console.log('[VIDEO-PLAY] Retry success');
					} catch(retryErr) {
						console.error('[VIDEO-PLAY] Retry failed:', retryErr);
						// If autoplay fails, user will need to click play
						adStatus.textContent = 'Click play to start video';
					}
				}, 250);
			}
		};
		
		tryPlay();
		currentAdViewLogged=false;
		
		// Extra fallback: force reveal after 1s even if no videoWidth yet
		setTimeout(()=>{ if(!adVideo.classList.contains('visible')) forceVideoFrameReveal(); },1000);
		// start progress loop immediately (duration may be unknown until metadata)
		startInlineProgress();
		// Wait for actual playback to begin to start skip timer
		adVideo.addEventListener('playing',()=>{ adStatus.textContent='Playing'; maybeStartSkipCountdown(); detectBlackFrameFallback(); startFrameMonitor(); // spatial audio waits for explicit unmute
			if(!currentAdViewLogged){ currentAdViewLogged=true; logAdEvent('view'); }
			// Preload the next MP4 ad (if any) to reduce startup latency for the following ad
			try{ preloadNextAdIfNeeded(); }catch(e){ /* non-fatal */ }
		},{ once:true });
		// If still not playing after 2s, try a gentle reload once
		setTimeout(()=>{ if(adVideo.currentTime===0 && !adVideo._reloadOnce){ adVideo._reloadOnce=true; const s=adVideo.src; adVideo.load(); adVideo.src=s; tryPlay(); } },2000);
		// If still blank after 4s, try fallback video
		setTimeout(()=>{ if(adVideo.currentTime===0){ console.log('[VIDEO-TIMEOUT] Trying fallback video'); tryVideoFallback(); } },4000);
		// Safety: first timeupdate triggers countdown if not already started
		const firstFrameHandler=()=>{ if(!skipCountdownStarted && adVideo.currentTime>0) maybeStartSkipCountdown(); adVideo.removeEventListener('timeupdate', firstFrameHandler); };
		adVideo.addEventListener('timeupdate', firstFrameHandler);
		// Fallback after 2s if some progress
		skipFallbackTimer=setTimeout(()=>{ if(!skipCountdownStarted && adVideo.currentTime>0) maybeStartSkipCountdown(); },2000);
	}else if(entry.type==='yt'){
		// Show thumbnail instantly for perceived load speed
		const id=entry.id;
		thumb.src='https://i.ytimg.com/vi/'+id+'/hqdefault.jpg';
		thumb.parentElement.classList.add('loading-thumb');
		currentAdViewLogged=false; playYouTubeAd(entry.id);
		// progress handled by simulateYtProgress on state change; skip countdown started on PLAYING
		// Safety: if still not playing after 1.2s, start skip countdown anyway so user isn't stuck
		setTimeout(()=>{ if(!skipCountdownStarted){ maybeStartSkipCountdown(); } },1200);
		setTimeout(()=>{ thumb.parentElement && thumb.parentElement.classList.remove('loading-thumb'); },1800);
	}else if(entry.type==='imgseq'){
		// Display image slideshow as a silent ad
		const imgs=entry.images||imgAds.slice(0,3); currentAdViewLogged=false;
		imgFallback.classList.add('active'); if(!currentAdViewLogged){ currentAdViewLogged=true; logAdEvent('view'); }
		let idx=0; let slideTimer=null;
		imgs.forEach((src,i)=>{ const im=new Image(); im.src=src; if(i===0) im.classList.add('active'); imgFallback.appendChild(im); });
		function next(){ const list=[...imgFallback.querySelectorAll('img')]; list.forEach(im=>im.classList.remove('active')); idx=(idx+1)%list.length; list[idx].classList.add('active'); }
		slideTimer=setInterval(next,1500);
		adStatus.textContent='Showing'; maybeStartSkipCountdown(); startInlineProgress();
		// treat as 10s ad progress
		let t0=performance.now();
		(function prog(){ const pct=Math.min(100, ((performance.now()-t0)/10000)*100); adProgressInline.style.width=pct+'%'; if(pct<100) requestAnimationFrame(prog); })();
	}
	adSequenceLabel.textContent='Ad '+(currentAdIndex+1)+' / '+adList.length+' • '+bundleSizeSelected+' MB';
}

// Enhanced fallback system
function tryVideoFallback() {
	console.log('[VIDEO-FALLBACK] Attempting video fallback');
	adStatus.textContent = 'Trying alternative video...';

	// Get list of working fallback videos (prioritise Google CDN samples)
	const fallbackVideos = [
		'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
		'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
		'https://www.learningcontainer.com/wp-content/uploads/2020/05/sample-mp4-file.mp4'
	];

	// Prepare alternatives excluding the current source
	const currentSrc = (adVideo && adVideo.src) ? adVideo.src : '';
	const alternatives = fallbackVideos.filter(url => url && url !== currentSrc);

	// Keep a retry counter on the video element to avoid infinite loops
	adVideo._fallbackIndex = (adVideo._fallbackIndex || 0);

	function attemptNextFallback(){
		if(adVideo._fallbackIndex >= alternatives.length){
			console.log('[VIDEO-FALLBACK] All fallbacks tried, skipping');
			adStatus.textContent = 'Video unavailable - skipping';
			// Small delay so UI updates are visible
			setTimeout(nextInlineAd, 900);
			return;
		}

		const fallbackUrl = alternatives[adVideo._fallbackIndex++];
		console.log('[VIDEO-FALLBACK] Trying:', fallbackUrl);
		adVideo.src = fallbackUrl;
		adVideo.load();

		// Try to play the fallback; if it fails within 800ms, try next
		let played = false;
		const playAttempt = async ()=>{
			try{
				await adVideo.play();
				played = true; console.log('[VIDEO-FALLBACK] Success'); adStatus.textContent='Playing';
			}catch(err){ console.warn('[VIDEO-FALLBACK] play failed', err); }
		};
		playAttempt();

		setTimeout(()=>{
			if(!played){
				console.warn('[VIDEO-FALLBACK] fallback did not start, trying next');
				attemptNextFallback();
			}
		}, 800);
	}

	// Start the fallback attempts
	attemptNextFallback();
}
function maybeStartSkipCountdown(){ if(skipCountdownStarted) return; skipCountdownStarted=true; startSkipCountdown(10); }
function startSkipCountdown(sec){
	let remaining=sec; 
	skipBtn.textContent='Skip ('+remaining+')';
	
	function updateCountdown() {
		if (skipCountdownPaused || adVideo.paused) {
			// Don't countdown while paused
			skipBtn.textContent='Skip ('+remaining+' - Paused)';
			return;
		}
		
		remaining--; 
		if(remaining<=0){ 
			clearInterval(skipTimer); 
			skipBtn.disabled=false; 
			skipBtn.classList.add('enabled'); 
			skipBtn.textContent='Skip'; 
		} else { 
			skipBtn.textContent='Skip ('+remaining+')'; 
		} 
	}
	
	skipTimer=setInterval(updateCountdown, 1000);
}
function startInlineProgress(){
		const current=adList[currentAdIndex];
		if(current.type==='mp4'){
			function frame(){
				if(adVideo.duration && !isNaN(adVideo.duration)){
					const pct=(adVideo.currentTime/adVideo.duration)*100; adProgressInline.style.width=pct+'%';
				}
				if(!adVideo.ended) progressInterval=requestAnimationFrame(frame);
			}
			progressInterval=requestAnimationFrame(frame);
		} else { // YouTube simulated until skip or next
			let pct=0; const step=()=>{ pct+=0.6; if(pct>100) pct=100; adProgressInline.style.width=pct+'%'; if(pct<100 && currentAdIndex<adList.length) progressInterval=requestAnimationFrame(step); }; step();
		}
}
skipBtn.addEventListener('click',()=>{ 
	if(skipBtn.disabled) return; 
	
	// Clear auto-skip timer if user manually skips
	if(autoSkipTimer) {
		clearTimeout(autoSkipTimer);
		autoSkipTimer = null;
	}
	
	try{ logAdEvent('skip',{watchSeconds: Math.round(adVideo.currentTime||0)}); }catch{} 
	nextInlineAd(); 
});
// Debounce helper to avoid rapid repeated taps causing visual vibration or playback instability
function debounceClick(fn, wait=250){
	let last=0;
	return function(ev){
		const now=Date.now();
		if(now-last < wait) { ev && ev.preventDefault && ev.preventDefault(); return; }
		last = now;
		try{ fn.apply(this, arguments); }catch(e){}
	};
}

muteBtn.addEventListener('click', debounceClick((ev)=>{

	// provide immediate press visual like other overlay controls
	try{ muteBtn.classList.add('pressed'); setTimeout(()=> muteBtn.classList.remove('pressed'), 180); }catch(e){}

	const current = adList[currentAdIndex] || {};
	// Toggle mute only; do not change play/pause state
	try{
		if(current.type === 'yt'){
			if(ytPlayerInstance && ytPlayerReady){
				if(ytPlayerInstance.isMuted && ytPlayerInstance.isMuted()){
					try{ ytPlayerInstance.unMute(); }catch{};
						setPersistedMute('unmuted');
						updateMuteButton();
				} else {
					try{ ytPlayerInstance.mute(); }catch{};
						setPersistedMute('muted');
						updateMuteButton();
				}
			}
		} else {
			// mp4/hls/dash/imgseq and default
			adVideo.muted = !adVideo.muted;
			setPersistedMute(adVideo.muted ? 'muted' : 'unmuted');
			updateMuteButton();
		}
	}catch(e){ console.warn('mute toggle failed', e); }
	if(!adVideo.paused) adStatus.textContent = adVideo.muted ? 'Muted' : 'Playing';
	if(adSequenceActive) requestWakeLock();
}));
if(playPauseBtn){
	playPauseBtn.addEventListener('click', debounceClick(()=>{
		const current=adList[currentAdIndex];
		if(current.type==='mp4'){
			if(adVideo.paused){ adVideo.play().catch(()=>{}); playPauseBtn.textContent='Pause'; playPauseBtn.setAttribute('aria-label','Pause ad'); }
			else { adVideo.pause(); playPauseBtn.textContent='Play'; playPauseBtn.setAttribute('aria-label','Play ad'); }
		}else if(current.type==='yt' && ytPlayerInstance && ytPlayerReady){
			const state=ytPlayerInstance.getPlayerState();
			if(state===YT.PlayerState.PLAYING){ ytPlayerInstance.pauseVideo(); playPauseBtn.textContent='Play'; playPauseBtn.setAttribute('aria-label','Play ad'); }
			else { ytPlayerInstance.playVideo(); playPauseBtn.textContent='Pause'; playPauseBtn.setAttribute('aria-label','Pause ad'); }
		}
	}));
}

// Fullscreen stability: when entering fullscreen, reduce CSS transitions/animations to avoid visual jitter
function applyStableForFullscreen(enable){
	try{
		if(enable) document.documentElement.classList.add('stable');
		else document.documentElement.classList.remove('stable');
	}catch(e){}
}
document.addEventListener('fullscreenchange', ()=>{ applyStableForFullscreen(!!document.fullscreenElement); });
// Attach to fsBtn if present (prevent focus jumps)
try{
	if(fsBtn){
		// Debounced fullscreen toggle
		fsBtn.addEventListener('click', debounceClick(()=>{
			try{
				if(!document.fullscreenElement){
					const el = adPlayer || document.documentElement;
					el.requestFullscreen && el.requestFullscreen().catch(()=>{});
					applyStableForFullscreen(true);
					fsBtn.textContent='Exit FS'; fsBtn.setAttribute('aria-label','Exit fullscreen');
				} else {
					document.exitFullscreen && document.exitFullscreen().catch(()=>{});
					applyStableForFullscreen(false);
					fsBtn.textContent='Fullscreen'; fsBtn.setAttribute('aria-label','Fullscreen video');
				}
			}catch{}
		},200));
		fsBtn.addEventListener('mousedown', (e)=>{ e.preventDefault(); });
	}
}catch(e){}
	// Attach press visuals to pressable overlay buttons
	try{
	document.querySelectorAll('.pressable').forEach(btn=>{
		btn.addEventListener('pointerdown', ()=> btn.classList.add('pressed'));
		btn.addEventListener('pointerup', ()=> btn.classList.remove('pressed'));
		btn.addEventListener('pointercancel', ()=> btn.classList.remove('pressed'));
		btn.addEventListener('mouseleave', ()=> btn.classList.remove('pressed'));
	});
}catch(e){}
// Enhanced video completion tracking with validation
let videoStartTime = 0;
let videoWatchTime = 0;
let lastProgressUpdate = 0;
let videoCompletionValidated = false;

adVideo.addEventListener('playing',()=>{ 
	if(playPauseBtn){ playPauseBtn.textContent='Pause'; playPauseBtn.setAttribute('aria-label','Pause ad'); }
	skipCountdownPaused = false; // Resume skip countdown when video plays
	
	// Track when video actually starts playing
	if(videoStartTime === 0) {
		videoStartTime = Date.now();
		lastProgressUpdate = Date.now();
		videoWatchTime = 0;
		videoCompletionValidated = false;
		console.log('[VIDEO-TRACKING] Video playback started');
	}
});

adVideo.addEventListener('pause',()=>{ 
	if(playPauseBtn && !adVideo.ended){ playPauseBtn.textContent='Play'; playPauseBtn.setAttribute('aria-label','Play ad'); }
	skipCountdownPaused = true; // Pause skip countdown when video is paused
});

// Enhanced video end detection with proper validation
adVideo.addEventListener('ended',()=> {
	console.log('[VIDEO-TRACKING] Video ended event fired');
	validateAndCompleteVideo();
	
	// Auto-skip to next video after 3 seconds if user doesn't click skip
	adStatus.textContent = 'Video completed! Next video in 3 seconds...';
	skipBtn.textContent = 'Skip (Auto-skip in 3s)';
	skipBtn.disabled = false;
	skipBtn.classList.add('enabled');
	
	autoSkipTimer = setTimeout(() => {
		console.log('[AUTO-SKIP] Auto-advancing to next video');
		nextInlineAd();
	}, 3000);
});

// Track actual watch time during playback
adVideo.addEventListener('timeupdate', ()=> {
	if(videoStartTime > 0 && !adVideo.paused && !adVideo.ended) {
		const now = Date.now();
		if(now - lastProgressUpdate > 1000) { // Update every second
			videoWatchTime += (now - lastProgressUpdate) / 1000;
			lastProgressUpdate = now;
		}
	}
});

function validateAndCompleteVideo() {
	const actualWatchTime = Math.max(videoWatchTime, adVideo.currentTime || 0);
	const videoDuration = adVideo.duration || 0;
	const completionPercentage = videoDuration > 0 ? (actualWatchTime / videoDuration) * 100 : 0;
	
	console.log('[VIDEO-VALIDATION]', {
		watchTime: actualWatchTime,
		duration: videoDuration,
		completion: completionPercentage,
		currentTime: adVideo.currentTime,
		ended: adVideo.ended
	});
	
	// Require at least 80% completion or 45 seconds minimum watch time
	const minWatchTime = 45; // 45 seconds minimum
	const minCompletionPercent = 80; // 80% of video must be watched
	
	if(actualWatchTime >= minWatchTime && completionPercentage >= minCompletionPercent) {
		videoCompletionValidated = true;
		console.log('[VIDEO-VALIDATION] Video completion validated - proceeding to next ad');
		nextInlineAd();
	} else {
		console.log('[VIDEO-VALIDATION] Video not sufficiently watched', {
			required: { minWatchTime, minCompletionPercent },
			actual: { watchTime: actualWatchTime, completion: completionPercentage }
		});
		
		// Show user feedback about incomplete video
		if(adStatus) {
			adStatus.textContent = `Please watch at least ${minCompletionPercent}% of the video (${Math.round(minWatchTime)}s minimum)`;
			adStatus.style.color = '#ff6b6b';
		}
		
		// Reset video to try again
		setTimeout(() => {
			if(adStatus) {
				adStatus.style.color = '';
				adStatus.textContent = 'Please watch the complete advertisement';
			}
		}, 3000);
		
		// Don't proceed to next ad - user must watch this one properly
		return;
	}
}

// --- Screen Wake Lock (prevent sleep during ad playback) ---
let activeWakeLock=null, wakeLockFallbackInterval=null, noSleepTinyVideo=null, wakeLockRequested=false, wakeLockHeartbeatInterval=null;
let hardWakeCanvas=null, hardWakeCtx=null, hardWakeRafId=null, hardWakeNudgeInterval=null, hardWakeAudioResumeInterval=null;
const WAKELOCK_CHECK_INTERVAL=15000;
const WAKELOCK_HEARTBEAT_INTERVAL=10000; // more aggressive periodic re-assert
// Aggressive wake modes cause heavy RAF/interval usage and can make phones jitter/vibrate.
// Detect touch devices and avoid enabling these modes there.
function isTouchDevice(){ try{ return ('ontouchstart' in window) || (navigator.maxTouchPoints>0) || (navigator.msMaxTouchPoints>0); }catch(e){ return false; } }
const HARD_WAKE_MODE = !isTouchDevice(); // enable extra aggressive anti-sleep on non-touch devices
const ULTRA_WAKE_MODE = !isTouchDevice(); // ultra-aggressive (battery heavy) enabled only on non-touch
const EXTREME_WAKE_MODE = false; // never enable extreme mode by default (too heavy)
function isWakeLockSupported(){ return 'wakeLock' in navigator; }
function isIOS(){ return /iP(ad|hone|od)/.test(navigator.userAgent); }
async function requestWakeLock(){
	wakeLockRequested=true;
	try{
		if(isWakeLockSupported()){
			if(!activeWakeLock){
				activeWakeLock = await navigator.wakeLock.request('screen');
				activeWakeLock.addEventListener('release',()=>{ activeWakeLock=null; if(wakeLockRequested){ setTimeout(()=>{ if(wakeLockRequested && !activeWakeLock) requestWakeLock(); },1000); startWakeLockFallback(); }});
			}
		} else {
			startWakeLockFallback();
		}
	}catch(err){
		startWakeLockFallback();
	}
	startWakeLockHeartbeat();
}
function releaseWakeLock(){
	wakeLockRequested=false;
	if(activeWakeLock){ try{ activeWakeLock.release(); }catch{} activeWakeLock=null; }
	stopWakeLockFallback();
	stopWakeLockHeartbeat();
	stopHardWake();
	stopExtremeWake();
}
function startWakeLockFallback(){
	if(!wakeLockRequested) return;
	if(!noSleepTinyVideo){
		noSleepTinyVideo=document.createElement('video');
		noSleepTinyVideo.setAttribute('playsinline','');
		noSleepTinyVideo.muted=true; noSleepTinyVideo.loop=true;
		Object.assign(noSleepTinyVideo.style,{width:'1px',height:'1px',position:'fixed',opacity:'0',pointerEvents:'none',bottom:'0',left:'0'});
		// 1 second silent mp4
		noSleepTinyVideo.src='data:video/mp4;base64,AAAAHGZ0eXBtcDQyAAAAAG1wNDFtcDQyaXNvbWF2YzEAAAAIZnJlZQAAAChtZGF0AAAAFgX///9hAAACc2F2YzEAAAAA';
		document.body.appendChild(noSleepTinyVideo);
	}
	noSleepTinyVideo.play().catch(()=>{});
	if(!wakeLockFallbackInterval){
		wakeLockFallbackInterval=setInterval(()=>{ if(noSleepTinyVideo && noSleepTinyVideo.paused) noSleepTinyVideo.play().catch(()=>{}); }, WAKELOCK_CHECK_INTERVAL);
	}
}
function stopWakeLockFallback(){
	if(wakeLockFallbackInterval){ clearInterval(wakeLockFallbackInterval); wakeLockFallbackInterval=null; }
	if(noSleepTinyVideo){ try{ noSleepTinyVideo.pause(); }catch{} }
}
function startWakeLockHeartbeat(){
	if(wakeLockHeartbeatInterval) return;
	wakeLockHeartbeatInterval=setInterval(()=>{
		if(!wakeLockRequested) return;
		if(isWakeLockSupported() && !activeWakeLock){ requestWakeLock(); }
		if(noSleepTinyVideo && noSleepTinyVideo.paused) noSleepTinyVideo.play().catch(()=>{});
		if(HARD_WAKE_MODE) ensureHardWake();
	}, WAKELOCK_HEARTBEAT_INTERVAL);
}
function ensureHardWake(){
	// 1. Offscreen tiny canvas animation (GPU/CPU activity to signal foreground use)
	if(!hardWakeCanvas){
		try{ hardWakeCanvas=document.createElement('canvas'); hardWakeCanvas.width=64; hardWakeCanvas.height=64; hardWakeCanvas.style.cssText='position:fixed;left:-2000px;top:-2000px;opacity:0;pointer-events:none;'; document.body.appendChild(hardWakeCanvas); hardWakeCtx=hardWakeCanvas.getContext('2d'); }catch{}
	}
	if(hardWakeCtx && !hardWakeRafId){
		let t=0; const loop=()=>{ if(!wakeLockRequested){ hardWakeRafId=null; return; } t++; try{ hardWakeCtx.fillStyle='#'+((t*48271)%0xFFFFFF).toString(16).padStart(6,'0'); hardWakeCtx.fillRect(0,0,64,64); }catch{} hardWakeRafId=requestAnimationFrame(loop); }; hardWakeRafId=requestAnimationFrame(loop);
	}
	// 2. Scroll nudge (very small, reversible)
	if(!hardWakeNudgeInterval){
		let down=true; hardWakeNudgeInterval=setInterval(()=>{ if(!wakeLockRequested) return; try{ window.scrollBy(0,down?1:-1); down=!down; }catch{} },45000);
	}
	// 3. Resume suspended audio context if present (muted or not)
	if(!hardWakeAudioResumeInterval){
		hardWakeAudioResumeInterval=setInterval(()=>{ try{ if(window.wakeSilentAudioCtx && window.wakeSilentAudioCtx.state==='suspended'){ window.wakeSilentAudioCtx.resume(); } }catch{} },15000);
	}
	if(ULTRA_WAKE_MODE) ensureUltraWake();
}
// Ultra wake: adds WebGL canvas, second hidden looping video (webm), worker ping, and title jitter (subtle)
let ultraWakeGlCanvas=null, ultraWakeGlCtx=null, ultraWakeGlRaf=null, ultraWakeVideo2=null, ultraWakeWorker=null, ultraWakeTitleInterval=null;
function ensureUltraWake(){
	// WebGL canvas draws changing color to keep GPU active
	if(!ultraWakeGlCanvas){
		try{ ultraWakeGlCanvas=document.createElement('canvas'); ultraWakeGlCanvas.width=32; ultraWakeGlCanvas.height=32; ultraWakeGlCanvas.style.cssText='position:fixed;right:-1000px;bottom:-1000px;opacity:0;pointer-events:none;'; document.body.appendChild(ultraWakeGlCanvas); ultraWakeGlCtx=ultraWakeGlCanvas.getContext('webgl')||ultraWakeGlCanvas.getContext('experimental-webgl'); }catch{}
	}
	if(ultraWakeGlCtx && !ultraWakeGlRaf){
		let f=0; const gl=ultraWakeGlCtx; const draw=()=>{ if(!wakeLockRequested){ ultraWakeGlRaf=null; return; } try{ const c=(f++%255)/255; gl.clearColor(c, 0.2, 1.0-c, 1); gl.clear(gl.COLOR_BUFFER_BIT); }catch{} ultraWakeGlRaf=requestAnimationFrame(draw); }; ultraWakeGlRaf=requestAnimationFrame(draw);
	}
	// Second hidden video using webm container to diversify media pipeline
	if(!ultraWakeVideo2){
		try{ ultraWakeVideo2=document.createElement('video'); ultraWakeVideo2.setAttribute('playsinline',''); ultraWakeVideo2.muted=true; ultraWakeVideo2.loop=true; ultraWakeVideo2.disableRemotePlayback=true; ultraWakeVideo2.style.cssText='position:fixed;top:-2000px;left:-2000px;width:1px;height:1px;opacity:0;pointer-events:none;';
			ultraWakeVideo2.src='data:video/webm;base64,GkXfo0AgQoaBAUL3gQFC8oEEQvOBCEKCBAAAAAA='; document.body.appendChild(ultraWakeVideo2); ultraWakeVideo2.play().catch(()=>{}); setInterval(()=>{ if(wakeLockRequested && ultraWakeVideo2.paused) ultraWakeVideo2.play().catch(()=>{}); },12000);
		}catch{}
	}
	// Worker ping (very light) to show JS activity
	if(!ultraWakeWorker){
		try{ const blob=new Blob([`let active=true; function ping(){ if(!active) return; setTimeout(ping,15000); postMessage(Date.now()); } ping(); onmessage=e=>{ if(e.data==='stop') active=false; };`],{type:'application/javascript'}); const url=URL.createObjectURL(blob); ultraWakeWorker=new Worker(url); ultraWakeWorker.onmessage=()=>{ /* no-op */ }; }catch{}
	}
	// Subtle title jitter every 90s (avoid spam). Stores original title.
	if(!ultraWakeTitleInterval){
		try{ if(!document._origTitle) document._origTitle=document.title; ultraWakeTitleInterval=setInterval(()=>{ if(!wakeLockRequested) return; document.title=document._origTitle+(Math.random()<0.5?'':' '); },90000); }catch{}
	}
}
function stopUltraWake(){
	if(ultraWakeGlRaf){ cancelAnimationFrame(ultraWakeGlRaf); ultraWakeGlRaf=null; }
	if(ultraWakeWorker){ try{ ultraWakeWorker.postMessage('stop'); ultraWakeWorker.terminate(); }catch{} ultraWakeWorker=null; }
	if(ultraWakeTitleInterval){ clearInterval(ultraWakeTitleInterval); ultraWakeTitleInterval=null; if(document._origTitle) document.title=document._origTitle; }
}
// Extreme wake (every second assertions)
let extremeWakeInterval=null;
function startExtremeWake(){
	if(!EXTREME_WAKE_MODE) return;
	if(extremeWakeInterval) return;
	extremeWakeInterval=setInterval(()=>{
		if(!wakeLockRequested) return;
		try{ requestWakeLock(); }catch{}
		try{ if(HARD_WAKE_MODE) ensureHardWake(); }catch{}
		try{ if(ULTRA_WAKE_MODE) ensureUltraWake(); }catch{}
		if(mobileKeepAwakeVid && mobileKeepAwakeVid.paused) mobileKeepAwakeVid.play().catch(()=>{});
		if(noSleepTinyVideo && noSleepTinyVideo.paused) noSleepTinyVideo.play().catch(()=>{});
		try{ if(window.wakeSilentAudioCtx && window.wakeSilentAudioCtx.state==='suspended'){ window.wakeSilentAudioCtx.resume(); } }catch{}
	},1000);
}
function stopExtremeWake(){ if(extremeWakeInterval){ clearInterval(extremeWakeInterval); extremeWakeInterval=null; } }
function stopHardWake(){
	if(hardWakeRafId){ cancelAnimationFrame(hardWakeRafId); hardWakeRafId=null; }
	if(hardWakeNudgeInterval){ clearInterval(hardWakeNudgeInterval); hardWakeNudgeInterval=null; }
	if(hardWakeAudioResumeInterval){ clearInterval(hardWakeAudioResumeInterval); hardWakeAudioResumeInterval=null; }
	if(ULTRA_WAKE_MODE) stopUltraWake();
}
function stopWakeLockHeartbeat(){ if(wakeLockHeartbeatInterval){ clearInterval(wakeLockHeartbeatInterval); wakeLockHeartbeatInterval=null; } }
function handlePlaybackStateChange(isPlaying){
	if(isPlaying || adSequenceActive){ requestWakeLock(); }
	else { releaseWakeLock(); }
}
// Explicit mobile keep-awake fallback (always-on tiny looping inline video) to supplement existing logic
let mobileKeepAwakeVid=null;
function forceStartMobileKeepAwake(){
	const ua=navigator.userAgent||'';
	if(!/Android|iPhone|iPad|iPod/i.test(ua)) return; // mobile only
	if(!mobileKeepAwakeVid){
		mobileKeepAwakeVid=document.createElement('video');
		mobileKeepAwakeVid.setAttribute('playsinline','');
		mobileKeepAwakeVid.muted=true; mobileKeepAwakeVid.loop=true; mobileKeepAwakeVid.disableRemotePlayback=true;
		Object.assign(mobileKeepAwakeVid.style,{position:'fixed',width:'1px',height:'1px',opacity:'0',pointerEvents:'none',bottom:'0',left:'0',zIndex:'-1'});
		// Short silent MP4 (different from fallback to reduce identical optimization pauses)
		mobileKeepAwakeVid.src='data:video/mp4;base64,AAAAHGZ0eXBpc29tAAAAAGlzb21pc28yYXZjMQAAAAhmcmVlAAAAG21kYXQhEAUAB//+AAACc2F2YwEAAAAA';
		document.body.appendChild(mobileKeepAwakeVid);
	}
	// Try play immediately and periodically ensure it stays playing
	const tryPlay=()=> mobileKeepAwakeVid.play().catch(()=>{});
	tryPlay();
	if(!isTouchDevice()){
		if(!mobileKeepAwakeVid._keepInt){ mobileKeepAwakeVid._keepInt=setInterval(()=>{ if(mobileKeepAwakeVid.paused) tryPlay(); },15000); }
		// Pulse: restart playback briefly every 60s to convince stubborn power managers
		if(!mobileKeepAwakeVid._pulseInt){ mobileKeepAwakeVid._pulseInt=setInterval(()=>{
			if(!mobileKeepAwakeVid) return;
			try{ mobileKeepAwakeVid.pause(); }catch{}
			setTimeout(()=>{ tryPlay(); },300);
		},60000); }
	}
}
function stopMobileKeepAwake(){ if(mobileKeepAwakeVid){ try{ mobileKeepAwakeVid.pause(); }catch{} } }
// Reacquire on visibility/orientation/fullscreen returns
['visibilitychange','orientationchange'].forEach(evt=>document.addEventListener(evt,()=>{ if(document.visibilityState==='visible' && wakeLockRequested){ if(isWakeLockSupported() && !activeWakeLock) requestWakeLock(); else if(!isWakeLockSupported()) startWakeLockFallback(); } }));
document.addEventListener('fullscreenchange',()=>{ if(!document.fullscreenElement && wakeLockRequested){ if(isWakeLockSupported() && !activeWakeLock) requestWakeLock(); }});
// Mobile nudge: slight no-op scroll to keep some devices awake (Android Chrome sometimes dims despite video)
let lastNudge=0; if(!isTouchDevice()){ setInterval(()=>{ if(!adSequenceActive) return; const now=Date.now(); if(now-lastNudge>60000){ lastNudge=now; try{ window.scrollBy(0,1); window.scrollBy(0,-1); }catch{} } },15000); }
// If device goes hidden and returns, immediately re-play tiny video fallback if needed
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible' && wakeLockRequested){ if(noSleepTinyVideo && noSleepTinyVideo.paused) noSleepTinyVideo.play().catch(()=>{}); } });
// Inline MP4 events
adVideo.addEventListener('playing',()=>handlePlaybackStateChange(true));
adVideo.addEventListener('pause',()=>handlePlaybackStateChange(false));
adVideo.addEventListener('ended',()=>handlePlaybackStateChange(false));
['waiting','stalled','seeking'].forEach(ev=> adVideo.addEventListener(ev,()=>{ if(adSequenceActive) handlePlaybackStateChange(true); }));
let lastWakePing=0; adVideo.addEventListener('timeupdate',()=>{ const now=Date.now(); if(now-lastWakePing>30000){ if(adSequenceActive) requestWakeLock(); lastWakePing=now; }});
// Ensure release when closing modal
function closeAccessModal(){
	accessModal.classList.remove('active');
	accessModal.setAttribute('aria-hidden','true');
	releaseFocusTrap();
	if(lastFocusedBeforeModal) lastFocusedBeforeModal.focus();
	// End sequence if still active and release wake lock
	adSequenceActive=false;
	releaseWakeLock();
	disableSpatialAudioSimulation();
	stopMobileKeepAwake();
}
adVideo.addEventListener('error',(e)=>{ 
	console.error('[VIDEO-ERROR]', {
		error: e,
		src: adVideo.src,
		networkState: adVideo.networkState,
		readyState: adVideo.readyState,
		currentEntry: adList[currentAdIndex],
		retryCount: adVideo._retryCount || 0,
		userAgent: navigator.userAgent
	});
	
	// Try alternative video before giving up
	if((adVideo._retryCount || 0) < (adVideo._maxRetries || 3)) {
		adVideo._retryCount = (adVideo._retryCount || 0) + 1;
		
		console.log(`[VIDEO-RETRY] Attempt ${adVideo._retryCount}/${adVideo._maxRetries}`);
		
		// Use the enhanced fallback system
		tryVideoFallback();
		return; // Don't skip yet, give the retry a chance
	}
	
	// All retries exhausted
	videoLoading.classList.add('hidden'); 
	
	// Try to get more specific error info
	let errorMsg = 'Ad load error';
	if(adVideo.error) {
		switch(adVideo.error.code) {
			case MediaError.MEDIA_ERR_ABORTED:
				errorMsg = 'Video loading aborted';
				break;
			case MediaError.MEDIA_ERR_NETWORK:
				errorMsg = 'Network error loading video';
				break;
			case MediaError.MEDIA_ERR_DECODE:
				errorMsg = 'Video decode error';
				break;
			case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
				errorMsg = 'Video format not supported - trying alternative';
				// Try one more fallback for format issues
				if((adVideo._formatRetries || 0) < 1) {
					adVideo._formatRetries = 1;
					tryVideoFallback();
					return;
				}
				break;
			default:
				errorMsg = 'Unknown video error';
		}
	}
	
	console.error('[VIDEO-FINAL-ERROR]', errorMsg);
	adStatus.textContent = errorMsg + ' – skipping'; 
	setTimeout(nextInlineAd, 500); 
});
adVideo.addEventListener('loadedmetadata',()=>{ forceVideoFrameReveal(); });
adVideo.addEventListener('loadeddata',()=>{ forceVideoFrameReveal(); });
adVideo.addEventListener('playing',()=>{ forceVideoFrameReveal(); });
adVideo.addEventListener('timeupdate',()=>{ if(!adVideo.classList.contains('visible')) forceVideoFrameReveal(); });
// Ultra mode: frequent wake assertion even while muted (every ~5s via timeupdate pace)
if(ULTRA_WAKE_MODE){
	let lastUltraWake=0;
	adVideo.addEventListener('timeupdate',()=>{
		if(!adSequenceActive) return;
		const now=Date.now();
		if(now-lastUltraWake>5000){
			if(adVideo.muted || adVideo.volume===0){ requestWakeLock(); ensureHardWake(); }
			lastUltraWake=now;
		}
	});
}
adVideo.addEventListener('timeupdate',()=>{
	const entry=adList[currentAdIndex]||{};
	if(!(entry.type==='mp4'||entry.type==='hls'||entry.type==='dash')) return;
	if(!adQuartilesSent) adQuartilesSent={};
	if(adVideo.duration){
		const pct=(adVideo.currentTime/adVideo.duration)*100;
		if(pct>=25 && !adQuartilesSent[25]){ adQuartilesSent[25]=true; logAdEvent('quartile25',{watchSeconds:Math.round(adVideo.currentTime)}); }
		if(pct>=50 && !adQuartilesSent[50]){ adQuartilesSent[50]=true; logAdEvent('quartile50',{watchSeconds:Math.round(adVideo.currentTime)}); }
		if(pct>=75 && !adQuartilesSent[75]){ adQuartilesSent[75]=true; logAdEvent('quartile75',{watchSeconds:Math.round(adVideo.currentTime)}); }
	}
});
adVideo.addEventListener('waiting',()=>{ if(!adVideo.paused) videoLoading.classList.remove('hidden'); });
adVideo.addEventListener('canplay',()=>{ forceVideoFrameReveal(); if(!skipCountdownStarted) {/* skip countdown still waits for playing */} });
function nextInlineAd(){
	clearAdTimers();
	
	// Reset video tracking for next video
	videoStartTime = 0;
	videoWatchTime = 0;
	lastProgressUpdate = Date.now();
	videoCompletionValidated = false;
	
	currentAdIndex++;
	if(currentAdIndex<adList.length){ 
		playCurrentInlineAd(); 
	} else { 
		// All videos completed - grant bundle
		grantBundle(); 
	}
}

function grantBundle(){
	adStatus.textContent='Granting '+bundleSizeSelected+' MB...';
	adProgressInline.style.width='100%';
	const grantDelay=1500; // Slightly longer delay for server processing
	const identifier=(sessionStorage.getItem('currentUserIdentifier')||'').toLowerCase();
	
	// Calculate total watch time across all videos for validation
	const totalWatchTime = Math.round(adVideo.currentTime || 0);
	
	// Enhanced completion logging with validation
	try{ 
		logAdEvent('complete', {
			watchSeconds: totalWatchTime,
			videosWatched: currentAdIndex,
			bundleRequested: bundleSizeSelected,
			validated: videoCompletionValidated
		}); 
	}catch{}
	
	adGrantTimeout=setTimeout(async ()=>{ 
		adStatus.textContent='Processing bundle grant...';
		
		try{ 
			if(identifier){ 
				const requestData = {
					identifier, 
					bundleMB: bundleSizeSelected, 
					routerId: detectRouterId(), 
					source: 'ad-sequence',
					totalWatchTime: totalWatchTime,
					videosCompleted: currentAdIndex
				};
				
				console.log('[BUNDLE-REQUEST]', requestData);
				
				const response = await fetch('/api/bundle/grant', {
					method: 'POST',
					headers: {'Content-Type': 'application/json'},
					body: JSON.stringify(requestData)
				}); 
				
				if(response.ok){ 
					const result = await response.json();
					console.log('[BUNDLE-GRANTED]', result);
					
					if(result.quota){ 
						lastQuotaState = result.quota; 
					}
					
					adStatus.textContent = bundleSizeSelected + ' MB activated successfully!';
					adStatus.style.color = '#10b981'; // Green success color
					
					showToast(bundleSizeSelected + ' MB data bundle activated! Enjoy your internet access.'); 
					// Notify server of video completion so device/session is marked as notified
					try {
						await fetch('/api/video/complete', {
							method: 'POST',
							headers: {'Content-Type':'application/json'},
							body: JSON.stringify({
								identifier: identifier,
								videoUrl: adList && adList.length ? (adList[currentAdIndex-1] || '') : '',
								duration: totalWatchTime || 0,
								deviceId: null
							})
						});
						console.log('[VIDEO-COMPLETE-NOTIFY] server notified of completion for', identifier);
					} catch(notifyErr){ console.warn('[VIDEO-COMPLETE-NOTIFY-ERR]', notifyErr); }
					
					// Inform user clearly that internet should now be available
					adStatus.textContent = bundleSizeSelected + ' MB activated — internet should be available now.';
				} else {
					// Handle grant failure
					const errorData = await response.json().catch(() => ({}));
					console.warn('[BUNDLE-GRANT-FAILED]', response.status, errorData);
					
					adStatus.textContent = 'Bundle grant failed: ' + (errorData.message || 'Server error');
					adStatus.style.color = '#ef4444'; // Red error color
					
					showToast('Bundle grant failed. Please try watching the videos again.', 'error');
					
					// Allow user to retry
					setTimeout(() => {
						adStatus.style.color = '';
						adStatus.textContent = 'Please watch advertisements to earn data';
					}, 5000);
					return; // Don't close modal on failure
				}
			}
		} catch(err) {
			console.error('[BUNDLE-GRANT-ERROR]', err);
			adStatus.textContent = 'Network error during bundle grant';
			adStatus.style.color = '#ef4444';
			showToast('Network error. Please check your connection and try again.', 'error');
			return;
		}
		
		refreshProxyStatusSoon();
		setTimeout(()=>{ closeAccessModal(); }, 1500); // Give user time to see success message
	}, grantDelay);
	
	disableSpatialAudioSimulation();
}
function clearAdTimers(){
	if(skipTimer) clearInterval(skipTimer); skipTimer=null;
	if(progressInterval) cancelAnimationFrame(progressInterval); progressInterval=null;
	if(adGrantTimeout) clearTimeout(adGrantTimeout); adGrantTimeout=null;
	if(skipFallbackTimer) clearTimeout(skipFallbackTimer); skipFallbackTimer=null;
	if(autoSkipTimer) clearTimeout(autoSkipTimer); autoSkipTimer=null;
	skipCountdownPaused = false;
	adQuartilesSent=null;
}
function tryShowFrame(){
	if(adVideo.videoWidth>0 && adVideo.readyState>=2){
		videoLoading.classList.add('hidden');
		adVideo.classList.add('visible');
	}else{
		// Passive wait; next events will retry
	}
}
function forceVideoFrameReveal(){
	if(adVideo.videoWidth>0 || adVideo.readyState>=2 || adVideo.currentTime>0){
		showVideoSurface();
		return;
	}
	if(!adVideo._nudge){
		adVideo._nudge=true;
		// Try a couple of quick seeks to jump past potential initial black frames.
		[0.05,0.15,0.25].forEach((t,i)=> setTimeout(()=>{ try{ adVideo.currentTime=t; }catch{} }, i*120));
		setTimeout(()=>{ if(adVideo.videoWidth>0 || adVideo.currentTime>0) showVideoSurface(); },420);
		// Hard timeout: attempt reload then force surface so user doesn't just see black.
		setTimeout(()=>{ if(!adVideo.classList.contains('visible')){ try{ const cur=adVideo.src; adVideo.pause(); adVideo.load(); if(cur) adVideo.src=cur; adVideo.play().catch(()=>{}); }catch{} showVideoSurface(true); } },1200);
	}
}
function showVideoSurface(forceDecor=false){
	adVideo.classList.add('visible');
	videoLoading.classList.add('hidden');
	// Basic brightness sniff to detect fully black first frame
	try{
		if(adVideo.videoWidth>0 && adVideo.videoHeight>0){
			const c=document.createElement('canvas'); c.width=32; c.height=18; const ctx=c.getContext('2d'); ctx.drawImage(adVideo,0,0,32,18); const data=ctx.getImageData(0,0,32,18).data; let sum=0; for(let i=0;i<data.length;i+=4) sum+=data[i]+data[i+1]+data[i+2]; const avg=sum/(data.length/4)/3; if(avg<5 || forceDecor){ adVideo.style.background='linear-gradient(135deg,#111,#222)'; }
		}
	}catch{}
	// Capture frame as poster for stubborn desktop black playback
	if(!adVideo._frameCaptured){
		try{ if(adVideo.videoWidth>0){ const c=document.createElement('canvas'); c.width=adVideo.videoWidth; c.height=Math.min(adVideo.videoHeight, adVideo.videoWidth*9/16); const ctx=c.getContext('2d'); ctx.drawImage(adVideo,0,0,c.width,c.height); const dataUrl=c.toDataURL('image/jpeg',0.6); adVideo.setAttribute('poster', dataUrl); adVideo._frameCaptured=true; } }catch{}
	}
}

// Preload the next MP4 ad to reduce startup latency for subsequent ads
function preloadNextAdIfNeeded(){
	try{
		const nextIndex = currentAdIndex + 1;
		if(!adList || nextIndex >= adList.length) return;
		const next = adList[nextIndex];
		if(!next || next.type!=='mp4' || !next.url) return;

		// Avoid repeated churn: reuse existing preload link if same URL
		const existing = document.querySelector('link[data-preload-next-ad]');
		if(existing && existing.href === next.url) return;

		if(existing) existing.remove();

		const link = document.createElement('link');
		link.rel = 'preload';
		link.as = 'video';
		link.href = next.url;
		link.setAttribute('data-preload-next-ad', '1');
		// Some CDNs require crossorigin to be set for preloads to work properly
		try{ link.crossOrigin = 'anonymous'; }catch{}
		document.head.appendChild(link);
		console.log('[PRELOAD] Next ad preloaded:', next.url);
		// Aggressive warming: attempt to fetch the first chunk (range) to warm TCP/TLS and CDNs
		try{ partialFetchWarm(next.url, {bytes: 131072, timeoutMs: 3000}).catch(()=>{}); }catch(e){ /* non-fatal */ }
	}catch(e){ console.warn('[PRELOAD-ERR]', e); }
}

// Try to fetch a small initial byte range to warm connections (non-blocking, tolerant)
async function partialFetchWarm(url, opts){
	opts = opts || {};
	const bytes = opts.bytes || 65536; // default 64KB
	const timeoutMs = opts.timeoutMs || 3000;
	try{
		if(!window.fetch) return;
		const controller = new AbortController();
		const id = setTimeout(()=>controller.abort(), timeoutMs);
		const rangeHeader = 'bytes=0-'+(Math.max(1024, bytes)-1);
		// Use CORS mode and request range; many CDNs honor Range on CORS requests
		const res = await fetch(url, { method: 'GET', mode: 'cors', cache: 'no-cache', headers: { 'Range': rangeHeader }, signal: controller.signal });
		clearTimeout(id);
		if(!res || !res.ok) { console.warn('[WARM] ranged fetch failed', res && res.status); return; }
		// Consume the body but don't store it: read a small chunk and then cancel if possible
		try{
			const reader = res.body && res.body.getReader && res.body.getReader();
			if(reader){
				// read one chunk then release
				const { value, done } = await reader.read();
				try{ reader.cancel(); }catch{};
			} else {
				// fallback: read as blob but we expect small size
				await res.blob().catch(()=>{});
			}
		}catch(e){ /* ignore */ }
		console.log('[WARM] Partial fetch succeeded for', url);
	}catch(err){
		if(err && err.name === 'AbortError') console.warn('[WARM] Partial fetch timed out');
		else console.warn('[WARM] Partial fetch error', err && err.message);
	}
}

// Detect persistent black video (audio only) and fallback to YouTube ad
function detectBlackFrameFallback(){
	const entry=adList[currentAdIndex];
	if(!entry || entry.type!=='mp4') return;
	// If after 1.2s of playing we still have no videoWidth, quickly swap to alternative
	setTimeout(()=>{
		if(adVideo.paused || adVideo.ended) return;
		if(adVideo.videoWidth===0){
			console.warn('MP4 appears video-less (no videoWidth), swapping ad source');
			// Prefer a YouTube fallback if available and API allowed
			if(!USE_MP4_ONLY && ytAds.length){
				adList[currentAdIndex]={type:'yt', id: ytAds[Math.floor(Math.random()*ytAds.length)]};
			}else{
				adList[currentAdIndex]={type:'imgseq', images: imgAds.sort(()=>Math.random()-0.5).slice(0,3)};
			}
			playCurrentInlineAd();
		}
	},1200);
}
// Monitor a few initial frames for brightness; if persistently near-black while currentTime advances (audio likely playing) -> fallback
let frameMonitorTimer=null; let darkFrameCount=0; let totalFrameSamples=0; let frameMonitorStartedAt=0;
function startFrameMonitor(){
	clearFrameMonitor();
	darkFrameCount=0; totalFrameSamples=0; frameMonitorStartedAt=performance.now();
	const canvas=document.createElement('canvas'); const ctx=canvas.getContext('2d'); canvas.width=64; canvas.height=36;
	function sample(){
		if(adVideo.paused || adVideo.ended){ clearFrameMonitor(); return; }
		if(adVideo.readyState>=2 && adVideo.videoWidth>0){
			try{
				ctx.drawImage(adVideo,0,0,64,36);
				const data=ctx.getImageData(0,0,64,36).data; let lum=0; for(let i=0;i<data.length;i+=4){ lum+=(data[i]+data[i+1]+data[i+2]); }
				const avg=lum/((data.length/4)*3); // 0-255
				totalFrameSamples++;
				if(avg<8) darkFrameCount++;
				// If 15+ samples and >80% are dark while currentTime advanced >1.5s -> treat as black video
				if(totalFrameSamples>=10){
					const ratio=darkFrameCount/totalFrameSamples;
					if(ratio>0.85 && adVideo.currentTime>1.2){
						console.warn('Persistent black/near-black frames; rotating ad source');
						clearFrameMonitor();
						if(!USE_MP4_ONLY && ytAds.length){
							adList[currentAdIndex]={type:'yt', id: ytAds[Math.floor(Math.random()*ytAds.length)]};
						}else{
							adList[currentAdIndex]={type:'imgseq',images:imgAds.sort(()=>Math.random()-0.5).slice(0,3)};
						}
						playCurrentInlineAd();
						return;
					}
				}
			}catch{}
		}
		if(performance.now()-frameMonitorStartedAt<4000){
			frameMonitorTimer=requestAnimationFrame(sample);
		} else {
			clearFrameMonitor();
		}
	}
	frameMonitorTimer=requestAnimationFrame(sample);
}
function clearFrameMonitor(){ if(frameMonitorTimer){ cancelAnimationFrame(frameMonitorTimer); frameMonitorTimer=null; } }
function visibilityLoop(){
	if(!adVideo.src) return;
	if(adVideo.videoWidth>0){ adVideo.classList.add('visible'); videoLoading.classList.add('hidden'); return; }
	if(performance.now()-videoStartStamp>3500){ adVideo.classList.add('visible'); videoLoading.classList.add('hidden'); return; }
	requestAnimationFrame(visibilityLoop);
}
function simulateYouTubeProgress(){ /* handled in startInlineProgress for yt */ }
function showToast(msg, type = 'info'){
	toast.textContent=msg; 
	toast.classList.remove('success', 'error', 'warning'); // Remove previous types
	toast.classList.add('show');
	if (type && type !== 'info') {
		toast.classList.add(type);
	}
	setTimeout(()=> {
		toast.classList.remove('show');
		setTimeout(() => toast.classList.remove('success', 'error', 'warning'), 300);
	}, 5000); // Longer duration for important messages
}
document.addEventListener('keydown',e=>{ if(e.key==='Escape' && adPlayer.classList.contains('active')){ e.preventDefault(); } });

// Terms overlay controls
function openTerms(){ const ov=document.getElementById('termsOverlay'); if(!ov) return; ov.classList.add('active'); ov.removeAttribute('aria-hidden'); }
function closeTerms(){ const ov=document.getElementById('termsOverlay'); if(!ov) return; ov.classList.remove('active'); ov.setAttribute('aria-hidden','true'); }

// Account modal logic
const accountOverlay=document.getElementById('accountOverlay');
function openAccountModal(){
	if(!sessionStorage.getItem('currentUserIdentifier')){ showToast('Please login first'); return; }
	accountOverlay.classList.add('active'); accountOverlay.removeAttribute('aria-hidden');
	loadProfile();
}
function closeAccountModal(){ accountOverlay.classList.remove('active'); accountOverlay.setAttribute('aria-hidden','true'); }
async function loadProfile(){
	const id=(sessionStorage.getItem('currentUserIdentifier')||'').toLowerCase();
	if(!id) return;
	try{
		const url='/api/me/profile?identifier='+encodeURIComponent(id);
		console.log('[profile] fetching', url);
		const res=await fetch(url, { headers:{ 'Accept':'application/json' }});
		const status=res.status;
		let raw=await res.text();
		let data; try{ data=JSON.parse(raw); }catch{ data=null; }
		if(!res.ok){
			console.error('[profile] http error', status, raw);
			// If server returned diagnostic info, show that to the user instead of a generic error
			try{
				const ps=document.getElementById('profileStatus');
				if(ps && data){
					if(data.diagnostics){
						let diagMsg = 'User not found. Checked: ' + (data.diagnostics.checked||[]).join(', ');
						if(data.diagnostics.xlsxPossibleMatches && data.diagnostics.xlsxPossibleMatches>0){
							diagMsg += '. Legacy store possible matches: ' + data.diagnostics.xlsxPossibleMatches + '. Try password reset or contact admin.';
						}
						ps.textContent = diagMsg;
						ps.style.color = '#c30000';
						return;
					}
					// Fallback: show server-provided message if available
					ps.textContent = (data && data.message) ? data.message : ('HTTP ' + status);
					ps.style.color = '#c30000';
					return;
				}
			}catch(e){ /* ignore UI update errors */ }
			throw new Error('HTTP '+status+' '+(data&&data.message?data.message:'' ) );
		}
		if(!data || !data.ok){
			console.error('[profile] bad payload', raw);
			throw new Error('Bad payload');
		}
		const p=data.profile; const form=document.getElementById('profileForm');
		form.email.value=p.email||''; form.firstName.value=p.firstName||''; form.surname.value=p.surname||''; // phone shown read-only
		form.phone.value=p.phone||''; form.dob.value=p.dob||'';
			const av=document.getElementById('avatarCircle'); av.textContent='';
			if(p.avatarUrl){
				av.style.backgroundImage='url("'+p.avatarUrl+'")';
				document.getElementById('removeAvatarBtn').style.display='inline-block';
			}
			else if(p.avatarData){
				av.style.backgroundImage='url("'+p.avatarData+'")';
				document.getElementById('removeAvatarBtn').style.display='inline-block';
			}
			else{
				av.style.backgroundImage='none';
				const fi=(p.firstName||'').trim();
				const si=(p.surname||'').trim();
				av.textContent=(fi?fi[0]:'?')+(si?si[0]:'');
				document.getElementById('removeAvatarBtn').style.display='none';
			}
		try{ sessionStorage.setItem('currentUserProfile', JSON.stringify(p)); }catch{}
		setInitials();
		const ps=document.getElementById('profileStatus'); if(ps) ps.textContent='';
	}catch(e){ const ps=document.getElementById('profileStatus'); if(ps) ps.textContent='Error loading profile: '+(e&&e.message?e.message:'unknown'); }
}
function handleAvatar(inp){
	const file=inp.files&&inp.files[0]; if(!file) return; if(file.size>1024*1024){ showToast('Image too large (max 1MB before compression)'); return; }
	const reader=new FileReader();
	reader.onload=()=>{
		// Compress via canvas to ~250KB target
		const img=new Image();
		img.onload=()=>{
			const maxDim=320; // small square for avatar
			let w=img.width, h=img.height;
			if(w>h && w>maxDim){ h=Math.round(h*(maxDim/w)); w=maxDim; }
			else if(h>=w && h>maxDim){ w=Math.round(w*(maxDim/h)); h=maxDim; }
			const canvas=document.createElement('canvas'); canvas.width=w; canvas.height=h; const ctx=canvas.getContext('2d');
			ctx.drawImage(img,0,0,w,h);
			// Prefer JPEG for better compression except if original is PNG with transparency
			let dataUrl; try { dataUrl=canvas.toDataURL('image/jpeg',0.85); } catch { dataUrl=reader.result; }
			if(dataUrl.length>350000){ // try lower quality
				try{ dataUrl=canvas.toDataURL('image/jpeg',0.7); }catch{}
			}
			if(dataUrl.length>400000){ showToast('Avatar still large after compression'); return; }
			const av=document.getElementById('avatarCircle'); if(!av) return;
			av.style.backgroundImage='url("'+dataUrl+'")'; av.textContent=''; av.dataset.avatar=dataUrl;
			try{
				const form=document.getElementById('profileForm');
				const cached=JSON.parse(sessionStorage.getItem('currentUserProfile')||'{}');
				cached.firstName=form.firstName.value.trim();
				cached.surname=form.surname.value.trim();
				cached.avatarData=dataUrl; // still store for session only
				sessionStorage.setItem('currentUserProfile', JSON.stringify(cached));
			}catch{}
		};
		img.src=reader.result;
	};
	reader.readAsDataURL(file);
}
function removeAvatar(){
	const av=document.getElementById('avatarCircle');
	if(av){
		av.style.backgroundImage='none';
		av.textContent='--';
		delete av.dataset.avatar; // indicate removal
		av.dataset.removeAvatar='1';
		showToast('Avatar marked for removal. Click Save.');
		const btn=document.getElementById('removeAvatarBtn'); if(btn) btn.style.display='none';
		// update cache preview
		try{ const cached=JSON.parse(sessionStorage.getItem('currentUserProfile')||'{}'); delete cached.avatarUrl; delete cached.avatarData; sessionStorage.setItem('currentUserProfile', JSON.stringify(cached)); }catch{}
		setInitials();
	}
}
// Delete account modal flow
function openDeleteModal(){
	const m=document.getElementById('deleteModal'); if(!m) return;
	const acc=document.getElementById('accountOverlay'); if(acc) acc.classList.add('blurred');
	m.classList.add('active');
	m.removeAttribute('aria-hidden');
	document.getElementById('deleteModalStatus').textContent='';
	document.getElementById('deleteStepPassword').style.display='flex';
	document.getElementById('deleteStepConfirm').style.display='none';
	setTimeout(()=>{ try{ const p=document.getElementById('del_pass'); if(p && !isTouchDevice()) p.focus(); }catch(e){} },40);
}
function closeDeleteModal(){
	const m=document.getElementById('deleteModal'); if(!m) return;
	const acc=document.getElementById('accountOverlay'); if(acc) acc.classList.remove('blurred');
	m.classList.remove('active');
	m.setAttribute('aria-hidden','true');
}
async function submitDeletePassword(){
	const pass=document.getElementById('del_pass').value.trim();
	const status=document.getElementById('deleteModalStatus');
	if(!pass){ status.textContent='Enter password.'; status.style.color='#c30000'; return; }
	// Verify password by attempting a lightweight auth call (reuse login endpoint)
	const id=(sessionStorage.getItem('currentUserIdentifier')||'');
	if(!id){ status.textContent='Session missing.'; status.style.color='#c30000'; return; }
	status.textContent='Verifying password...'; status.style.color='#555';
	try{
		const res=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:id,password:pass})});
		if(!res.ok){ status.textContent='Password incorrect.'; status.style.color='#c30000'; return; }
	}catch{ status.textContent='Network error.'; status.style.color='#c30000'; return; }
	status.textContent='Password verified. Confirm deletion.'; status.style.color='#059669';
	document.getElementById('deleteStepPassword').style.display='none';
	document.getElementById('deleteStepConfirm').style.display='flex';
}
function backDeletePassword(){ document.getElementById('deleteStepPassword').style.display='flex'; document.getElementById('deleteStepConfirm').style.display='none'; }
async function confirmDeleteAccount(){
	const id=(sessionStorage.getItem('currentUserIdentifier')||'').toLowerCase();
	const pass=document.getElementById('del_pass').value.trim();
	const status=document.getElementById('deleteModalStatus');
	const yesBtn=document.querySelector('#deleteStepConfirm button.confirm-delete-btn') || document.querySelector('#deleteStepConfirm button[onclick*="confirmDeleteAccount"]');
	if(!id){ status.textContent='Not logged in.'; status.style.color='#c30000'; return; }
	if(!pass){ status.textContent='Missing password.'; status.style.color='#c30000'; return; }
	status.textContent='Deleting...'; status.style.color='#555';
	if(yesBtn){ yesBtn.disabled=true; yesBtn.style.opacity='.6'; }
	try {
		const res=await fetch('/api/me/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifier:id,password:pass})});
		const data=await res.json().catch(()=>({}));
		if(res.ok && data.ok){
			status.textContent='Account deleted. Redirecting...'; status.style.color='#059669';
			sessionStorage.removeItem('currentUserIdentifier');
			sessionStorage.removeItem('currentUserProfile');
			setTimeout(()=>{ window.location.href='login.html'; },600);
		} else {
			status.textContent=(data && data.message) ? data.message : 'Delete failed'; status.style.color='#c30000';
			if(yesBtn){ yesBtn.disabled=false; yesBtn.style.opacity=''; }
		}
	} catch(err){
		status.textContent='Network error'; status.style.color='#c30000';
		if(yesBtn){ yesBtn.disabled=false; yesBtn.style.opacity=''; }
	}
}
document.addEventListener('click',e=>{ const m=document.getElementById('deleteModal'); if(m && e.target===m) closeDeleteModal(); });
document.addEventListener('keydown',e=>{ if(e.key==='Escape'){ const m=document.getElementById('deleteModal'); if(m && m.classList.contains('active')) closeDeleteModal(); }});
// Inline Change Password logic inside account modal
function toggleChangePassword(show){
	const section=document.getElementById('changePassSection');
	const profileSection=document.getElementById('profileSection');
	if(show===undefined) show = section.style.display==='none';
	if(show){ section.style.display='flex'; profileSection.style.display='none'; document.getElementById('cp_inline_status').textContent=''; }
	else { section.style.display='none'; profileSection.style.display='flex'; }
}
function openChangePass(){ toggleChangePassword(true); }
function closeChangePass(){ toggleChangePassword(false); }
function isStrongPassword(p){return /[A-Z]/.test(p)&&/[a-z]/.test(p)&&/\d/.test(p)&&/[^A-Za-z0-9]/.test(p)&&p.length>=8;}
async function submitInlinePasswordChange(){
	const id=(sessionStorage.getItem('currentUserIdentifier')||'');
	const cur=document.getElementById('cp_current').value.trim();
	const np=document.getElementById('cp_new').value.trim();
	const np2=document.getElementById('cp_new2').value.trim();
	const status=document.getElementById('cp_inline_status');
	function msg(t,c){ status.textContent=t; status.style.color=c==='error'? '#c30000': c==='success'? '#059669':'#555'; }
	if(!id){ msg('Session missing. Re-login.','error'); return; }
	if(!cur||!np||!np2){ msg('Fill all fields','error'); return; }
	if(np!==np2){ msg('New passwords mismatch','error'); return; }
	if(!isStrongPassword(np)){ msg('Weak password (need upper, lower, number, symbol, 8+)','error'); return; }
	msg('Updating...');
	try{
		const res=await fetch('/api/change-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifier:id,oldPassword:cur,newPassword:np})});
		const data=await res.json().catch(()=>({}));
		if(res.ok && data.ok){ msg('Password updated','success'); document.getElementById('cp_current').value=''; document.getElementById('cp_new').value=''; document.getElementById('cp_new2').value=''; setTimeout(()=>toggleChangePassword(false),800); }
		else msg(data.message||'Update failed','error');
	}catch{ msg('Network error','error'); }
}
async function saveProfile(e){
	e.preventDefault(); const form=e.target; const id=(sessionStorage.getItem('currentUserIdentifier')||'').toLowerCase(); if(!id) return false;
	const status=document.getElementById('profileStatus');
	// Only allow updating first name, surname and date of birth (and avatar)
	const avCircle=document.getElementById('avatarCircle');
	const payload={ identifier:id, firstName:form.firstName.value.trim(), surname:form.surname.value.trim(), dob:form.dob.value };
	if(avCircle.dataset.avatar){ payload.avatarData=avCircle.dataset.avatar; }
	if(avCircle.dataset.removeAvatar==='1'){ payload.removeAvatar=true; }
	status.textContent='Saving...';
	try{
		const res=await fetch('/api/me/profile/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
		const data=await res.json().catch(()=>({}));
		if(!res.ok || !data.ok){ status.textContent=data.message||'Save failed'; status.style.color='#c30000'; }
		else {
			status.textContent='Saved'; status.style.color='#059669';
			try{ sessionStorage.setItem('currentUserProfile', JSON.stringify(data.profile)); }catch{}
			setInitials();
			// Close the My Account modal shortly after a successful save
			setTimeout(()=>{ closeAccountModal(); },600);
		}
	}catch{ status.textContent='Network error'; status.style.color='#c30000'; }
	return false;
}

async function deleteAccount(){
	const id=(sessionStorage.getItem('currentUserIdentifier')||'').toLowerCase();
	if(!id){ showToast('Not logged in'); return; }
	const pass=document.getElementById('deletePass').value.trim();
	const status=document.getElementById('deleteStatus');
	function msg(t,c){ status.textContent=t; status.style.color= c==='error'? '#c30000': c==='success'? '#059669':'#555'; }
	if(!pass){ msg('Enter password','error'); return; }
	if(!confirm('Delete your account permanently? This cannot be undone.')) return;
	msg('Deleting...');
	try{
		const res=await fetch('/api/me/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifier:id,password:pass})});
		const data=await res.json().catch(()=>({}));
		if(res.ok && data.ok){ msg('Account deleted','success'); showToast('Account deleted'); sessionStorage.removeItem('currentUserIdentifier'); sessionStorage.removeItem('currentUserProfile'); setTimeout(()=>{ window.location.href='login.html'; },800); }
		else msg(data.message||'Delete failed','error');
	}catch{ msg('Network error','error'); }
}

function isStrongPassword(p){return /[A-Z]/.test(p)&&/[a-z]/.test(p)&&/\d/.test(p)&&/[^A-Za-z0-9]/.test(p)&&p.length>=8;}
async function changePassword(e){
	e.preventDefault();
	const id = sessionStorage.getItem('currentUserIdentifier');
	const oldP=document.getElementById('oldPass').value.trim();
	const newP=document.getElementById('newPass').value.trim();
	const newP2=document.getElementById('newPass2').value.trim();
	const status=document.getElementById('cp-status');
	function msg(t,c){status.textContent=t;status.className='status-msg '+c;}
	if(!id){msg('Session missing, please login again.','error');return false;}
	if(!oldP||!newP||!newP2){msg('Fill all fields','error');return false;}
	if(newP!==newP2){msg('New passwords mismatch','error');return false;}
	if(!isStrongPassword(newP)){msg('Weak password: need upper, lower, number, symbol & 8+ chars','error');return false;}
	try{
		const res=await fetch('/api/change-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifier:id,oldPassword:oldP,newPassword:newP})});
		const data=await res.json().catch(()=>({}));
		if(res.ok && data.ok){msg('Password updated','success');document.getElementById('oldPass').value='';document.getElementById('newPass').value='';document.getElementById('newPass2').value='';setTimeout(()=>closeChangePass(),800);} else msg(data.message||'Update failed','error');
	}catch{ msg('Network error','error'); }
	return false;
}
// ---- Global ad click logging (if not already added earlier) ----
if(!window._adClickListenerAttached){
	window._adClickListenerAttached=true;
	document.addEventListener('click',e=>{ const player=e.target.closest && e.target.closest('#adPlayer'); if(player){ try{ logAdEvent('click',{watchSeconds:Math.round(adVideo.currentTime||0)}); }catch{} } });

	// Fetch portal/proxy config to populate Help > Connect Devices section
	(async function loadPortalConfig(){
		try {
			const r=await fetch('/api/portal/config?ts='+(Date.now()));
			if(!r.ok) throw new Error('http '+r.status);
			const j=await r.json();
			if(!j.ok) throw new Error('payload');
			const hostSpan=document.querySelector('[data-proxy-host]');
			const portSpan=document.querySelector('[data-proxy-port]');
			const pacLink=document.querySelector('[data-pac-url]');
			if(hostSpan) hostSpan.textContent=j.host;
			if(portSpan) portSpan.textContent=j.proxyPort;
			if(pacLink){ pacLink.textContent=j.pacUrl; pacLink.href=j.pacUrl; }
		} catch(err){
			['[data-proxy-host]','[data-proxy-port]','[data-pac-url]'].forEach(sel=>{ const el=document.querySelector(sel); if(el){ el.textContent='unavailable'; } });
		}
	})();

	// --- Proxy / Internet status badge ---
	const netStatusEl=document.getElementById('netStatus');
	let proxyStatusTimer=null;
	async function fetchProxyStatus(){
		try {
			const r=await fetch('/api/proxy/status',{cache:'no-store'});
			if(!r.ok) throw new Error('status '+r.status);
			const j=await r.json();
			if(!j.ok){ throw new Error('not ok'); }
			if(j.authorized){
				netStatusEl.textContent='Online '+(j.remainingMB!=null?('('+Math.max(0,Math.round(j.remainingMB))+' MB left)'):'');
				netStatusEl.style.background='#059669';
			} else if(j.exhausted){
				netStatusEl.textContent='Bundle Exhausted';
				netStatusEl.style.background='#c30000';
			} else {
				netStatusEl.textContent='Portal Only';
				netStatusEl.style.background='#444';
			}
		} catch(err){
			netStatusEl.textContent='Status Error';
			netStatusEl.style.background='#c30000';
		}
	}
	function scheduleProxyStatus(){ proxyStatusTimer=setTimeout(()=>{ fetchProxyStatus().finally(scheduleProxyStatus); }, 15000); }
	function refreshProxyStatusSoon(){ setTimeout(()=>fetchProxyStatus(),400); }
	fetchProxyStatus().then(scheduleProxyStatus);
}
// ---- Silent audio + rAF wake fallbacks (if not already inserted earlier) ----
if(!window._wakeAudioInit){
	window._wakeAudioInit=true;
	let wakeSilentAudioCtx=null, wakeSilentOsc=null;
	function ensureSilentAudioWake(){
		if(wakeSilentAudioCtx) return;
		try{
			const C=window.AudioContext||window.webkitAudioContext; if(!C) return;
			wakeSilentAudioCtx=new C();
			wakeSilentOsc=wakeSilentAudioCtx.createOscillator();
			wakeSilentOsc.type='sine'; wakeSilentOsc.frequency.value=30; // base low freq
			const g=wakeSilentAudioCtx.createGain(); g.gain.value=0.000015; // tiny non-zero
			wakeSilentOsc.connect(g).connect(wakeSilentAudioCtx.destination);
			wakeSilentOsc.start();
			// Add a second ultra-low oscillator to create minute CPU/audio callbacks
			if(ULTRA_WAKE_MODE){
				try{
					const osc2=wakeSilentAudioCtx.createOscillator(); osc2.type='square'; osc2.frequency.value=11; const g2=wakeSilentAudioCtx.createGain(); g2.gain.value=0.00001; osc2.connect(g2).connect(wakeSilentAudioCtx.destination); osc2.start();
					// subtle periodic modulation
					setInterval(()=>{ try{ wakeSilentOsc.frequency.setValueAtTime(25 + Math.random()*10, wakeSilentAudioCtx.currentTime+0.05); }catch{} },20000);
				}catch{}
			}
		}catch{}
	}
	let rAFWakeId=null; function startRafWake(){ if(rAFWakeId) return; function loop(){ if(adSequenceActive){ rAFWakeId=requestAnimationFrame(loop);} else { rAFWakeId=null; } } rAFWakeId=requestAnimationFrame(loop); }
	document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible' && adSequenceActive){ ensureSilentAudioWake(); startRafWake(); } });
	const _origStartAdSeqRef=startAdSequence; startAdSequence=function(b){ ensureSilentAudioWake(); startRafWake(); requestWakeLock(); return _origStartAdSeqRef(b); };

	// Reassert wake lock & audio on common gestures (helps some Android variants)
	['touchstart','pointerdown','keydown','mousemove'].forEach(evt=>{
		document.addEventListener(evt,()=>{
			if(adSequenceActive){ ensureSilentAudioWake(); requestWakeLock(); if(mobileKeepAwakeVid && mobileKeepAwakeVid.paused) mobileKeepAwakeVid.play().catch(()=>{}); }
		},{passive:true});
	});
}
