const { ipcMain, session, app, BrowserWindow, powerSaveBlocker } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

// SLYA is a 24/7 automation process. Chromium otherwise throttles timers when
// its window is covered, minimized, or inactive on Windows.
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

const APP_ROOT = __dirname

function getInstallInstanceName()
{
	const baseName = path.basename(APP_ROOT)
	const match = baseName.match(/^SLYA\s*-\s*(.+)$/i)
	return match ? match[1].trim() : ''
}

function readInstanceConfig()
{
	const configPath = path.join(APP_ROOT, 'instance-config.json')
	try {
		if (!fs.existsSync(configPath)) return {}
		return JSON.parse(fs.readFileSync(configPath, 'utf8'))
	} catch (error) {
		console.error('Failed to read instance-config.json:', error)
		return {}
	}
}

const instanceConfig = readInstanceConfig()
const APP_INSTANCE_NAME = String(instanceConfig.instanceName || getInstallInstanceName()).replace(/[<>]/g, '').trim()
const APP_NAME = APP_INSTANCE_NAME ? `SLYA - ${APP_INSTANCE_NAME}` : 'SLYA'
const APP_ID = APP_INSTANCE_NAME ? `slya.${APP_INSTANCE_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '')}` : 'slya'


const ORIGINAL_UPDATE_URL = 'https://raw.githubusercontent.com/Swift42/SLY-Assistant/refs/heads/patch-collection-for-0.7.0/SLY_Assistant.user.js'
const AEP_UPDATE_BASE_URL = 'https://raw.githubusercontent.com/aephiaviktor/SLY-Assistant/refs/heads/aep-release'
const AEP_UPDATE_URL = `${AEP_UPDATE_BASE_URL}/SLY_Assistant.user.js`
const AEP_WRAPPER_UPDATE_FILES = [
	{ url: `${AEP_UPDATE_BASE_URL}/electron-app/main.js`, target: 'main.js', transform: preserveElectronMainIdentity },
	{ url: `${AEP_UPDATE_BASE_URL}/electron-app/preload.js`, target: 'preload.js' },
	{ url: `${AEP_UPDATE_BASE_URL}/electron-app/app/index.html`, target: path.join('app', 'index.html'), transform: preserveElectronIndexIdentity }
]
app.setName(APP_NAME)
app.setAppUserModelId(APP_ID)
app.setPath('userData', path.join(APP_ROOT, 'data'))

const loadApp = (win, version, aephiaVersion) => {
	win.loadFile(path.join(APP_ROOT, 'app', 'index.html'), { query: { version: version, aephiaVersion: aephiaVersion, appInstanceName: APP_INSTANCE_NAME } } )
}

function serializeCrashValue(value)
{
	if (value instanceof Error) {
		return {
			name: value.name,
			message: value.message,
			stack: value.stack,
			code: value.code
		}
	}
	if (value && typeof value === 'object') {
		try {
			return JSON.parse(JSON.stringify(value))
		} catch {
			return String(value)
		}
	}
	return value
}

function logCrashEvent(type, details = {})
{
	const logPath = path.join(APP_ROOT, 'analysis', 'crash-events.jsonl')
	const event = {
		timestamp: new Date().toISOString(),
		app: APP_NAME,
		appId: APP_ID,
		instance: APP_INSTANCE_NAME || null,
		pid: process.pid,
		ppid: process.ppid,
		platform: process.platform,
		versions: {
			electron: process.versions.electron,
			chrome: process.versions.chrome,
			node: process.versions.node
		},
		type,
		details: serializeCrashValue(details)
	}
	try {
		fs.mkdirSync(path.dirname(logPath), { recursive: true })
		fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`, 'utf8')
	} catch (error) {
		console.error('[SLYA] failed to write crash event:', error)
	}
	console.error('[SLYA] crash event:', JSON.stringify({ type, details: event.details }))
}

function attachWindowCrashLogging(win)
{
	if (!win || !win.webContents) return
	win.webContents.on('render-process-gone', (_event, details) => {
		logCrashEvent('window-render-process-gone', {
			title: win.getTitle(),
			url: win.webContents.getURL(),
			details
		})
	})
	win.webContents.on('unresponsive', () => {
		logCrashEvent('window-unresponsive', {
			title: win.getTitle(),
			url: win.webContents.getURL()
		})
	})
}

function installCrashEventLogging()
{
	process.on('uncaughtExceptionMonitor', (error) => {
		logCrashEvent('uncaughtExceptionMonitor', error)
	})
	process.on('unhandledRejection', (reason) => {
		logCrashEvent('unhandledRejection', reason)
	})
	process.on('exit', (code) => {
		logCrashEvent('process-exit', { code })
	})
	app.on('render-process-gone', (_event, webContents, details) => {
		logCrashEvent('app-render-process-gone', {
			id: webContents?.id,
			url: typeof webContents?.getURL === 'function' ? webContents.getURL() : '',
			details
		})
	})
	app.on('child-process-gone', (_event, details) => {
		logCrashEvent('child-process-gone', details)
	})
	app.on('gpu-process-crashed', (_event, killed) => {
		logCrashEvent('gpu-process-crashed', { killed })
	})
}

const createWindow = (version, aephiaVersion) => {
  const win = new BrowserWindow({
    title: APP_NAME,
    width: 800,
    height: 600,
    icon: path.join(APP_ROOT, 'app/icons/128.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      backgroundThrottling: false
    }    
  })
  //win.webContents.openDevTools()  
  win.setTitle(APP_NAME + (version ? ` v${version}` : ''))
  attachWindowCrashLogging(win)
  loadApp(win, version, aephiaVersion)
  return win
}

function readUserscriptMeta(file, key)
{
	const metaPrefix = `@${key}`
	const line = file.split(/\r?\n/).find((entry) => entry.includes(metaPrefix))
	if (!line) return 'unknown'
	const value = line.slice(line.indexOf(metaPrefix) + metaPrefix.length).trim()
	return value || 'unknown'
}

function readInstalledSLYAMeta()
{
	const file = fs.readFileSync(path.join(APP_ROOT, 'app', 'SLY_Assistant.user.js')).toString()
	return {
		file,
		version: readUserscriptMeta(file, 'version'),
		aephiaVersion: readUserscriptMeta(file, 'aephia-version')
	}
}

async function fetchText(sourceUrl)
{
	const response = await fetch(sourceUrl)
	if (!response.ok) throw new Error(`Failed to fetch update file (${response.status}) from ${sourceUrl}`)
	return await response.text()
}

async function fetchSLYA(sourceUrl)
{
	const file = await fetchText(sourceUrl)
	const version = readUserscriptMeta(file, 'version')
	const aephiaVersion = readUserscriptMeta(file, 'aephia-version')
	return { file, version, aephiaVersion }
}

function preserveElectronMainIdentity(file)
{
	return file
}

function preserveElectronIndexIdentity(file)
{
	return file
		.replace(/<title>[^<]+<\/title>/, `<title>${APP_NAME}</title>`)
		.replace(/appInstanceName'\) \|\| '[^']*'/, `appInstanceName') || '${APP_INSTANCE_NAME.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)
		.replace(/This SLYA(?:\s*-\s*[^<]+)? standalone version/g, `This ${APP_NAME} standalone version`)
}

function writeUpdateFile(target, file)
{
	const targetPath = path.join(__dirname, target)
	fs.mkdirSync(path.dirname(targetPath), { recursive: true })
	fs.writeFileSync(targetPath, file)
}

async function updateSLYA(sourceUrl = AEP_UPDATE_URL)
{
	const latest = await fetchSLYA(sourceUrl)
	writeUpdateFile(path.join('app', 'SLY_Assistant.user.js'), latest.file)
	return latest
}

async function updateAepFromGitHub()
{
	preserveLeveldbBeforeUpdate()
	const latest = await updateSLYA(AEP_UPDATE_URL)
	for (const updateFile of AEP_WRAPPER_UPDATE_FILES) {
		let file = await fetchText(updateFile.url)
		if (updateFile.transform) file = updateFile.transform(file)
		writeUpdateFile(updateFile.target, file)
	}
	return latest
}

function restartApp()
{
	setTimeout(function() {
		app.relaunch()
		app.exit(0)
	}, 2000)
}

function wait(ms) {	return new Promise(resolve => {	setTimeout(resolve, ms); }); }


const LEVELDB_DIR = path.join(APP_ROOT, 'data', 'Local Storage', 'leveldb')
const LEVELDB_BAK_DIR = path.join(APP_ROOT, 'data', 'Local Storage', 'leveldb.bak')
const LEVELDB_PREV_BAK_DIR = path.join(APP_ROOT, 'data', 'Local Storage', 'leveldb.bak.prev')
const SLYA_STATE_BACKUP_DIR = path.join(APP_ROOT, 'data', 'slya-state-backups')
const SLYA_STATE_BACKUP_CURRENT = path.join(SLYA_STATE_BACKUP_DIR, 'slya-state-current.json')
const SLYA_STATE_BACKUP_PREV = path.join(SLYA_STATE_BACKUP_DIR, 'slya-state-prev.json')
const SLYA_STATE_BACKUP_META = path.join(SLYA_STATE_BACKUP_DIR, 'slya-state-meta.json')

function leveldbTimestamp()
{
	return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
}

function logToUpgradeLog(line)
{
	try {
		const logPath = path.join(APP_ROOT, 'data', 'upgrade-automation.log')
		fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${String(line || '')}\n`, 'utf8')
	} catch (e) {}
}

function atomicWriteJson(targetPath, payload)
{
	fs.mkdirSync(path.dirname(targetPath), { recursive: true })
	const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`
	fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8')
	fs.renameSync(tmpPath, targetPath)
}

function readJsonFileIfExists(filePath)
{
	try {
		if (!fs.existsSync(filePath)) return null
		return JSON.parse(fs.readFileSync(filePath, 'utf8'))
	} catch (error) {
		return { error: String(error?.message || error), path: filePath }
	}
}

function writeSlyaStateBackup(payload)
{
	try {
		if (!payload || typeof payload !== 'object') return { ok: false, error: 'missing payload' }
		fs.mkdirSync(SLYA_STATE_BACKUP_DIR, { recursive: true })
		if (fs.existsSync(SLYA_STATE_BACKUP_CURRENT)) {
			try { fs.copyFileSync(SLYA_STATE_BACKUP_CURRENT, SLYA_STATE_BACKUP_PREV) } catch (e) {}
		}
		const backup = {
			...payload,
			wrapper: {
				appName: APP_NAME,
				instanceName: APP_INSTANCE_NAME,
				writtenAt: new Date().toISOString(),
				appRoot: APP_ROOT
			}
		}
		atomicWriteJson(SLYA_STATE_BACKUP_CURRENT, backup)
		const bytes = fs.statSync(SLYA_STATE_BACKUP_CURRENT).size
		const metadata = {
			...(payload.metadata || {}),
			reason: String(payload.reason || payload.metadata?.reason || 'unknown'),
			aephiaVersion: payload.aephiaVersion || null,
			writtenAt: backup.writtenAt || null,
			bytes,
			path: SLYA_STATE_BACKUP_CURRENT,
			previousPath: fs.existsSync(SLYA_STATE_BACKUP_PREV) ? SLYA_STATE_BACKUP_PREV : null,
			wrapper: backup.wrapper
		}
		atomicWriteJson(SLYA_STATE_BACKUP_META, metadata)
		logToUpgradeLog(`[ELECTRON][SLYA-STATE-BAK] snapshot ok reason=${metadata.reason} bytes=${bytes} settingsKeys=${Number(metadata.settingsKeyCount || 0)} fleets=${Number(metadata.fleetConfigCount || 0)} crafts=${Number(metadata.craftConfigCount || 0)} activeCrafts=${Number(metadata.activeCraftingCount || 0)} path=${SLYA_STATE_BACKUP_CURRENT}`)
		return { ok: true, path: SLYA_STATE_BACKUP_CURRENT, metaPath: SLYA_STATE_BACKUP_META, bytes, metadata }
	} catch (error) {
		logToUpgradeLog(`[ELECTRON][SLYA-STATE-BAK] snapshot error=${String(error?.message || error)}`)
		return { ok: false, error: String(error?.message || error) }
	}
}

function readSlyaStateBackup()
{
	const current = readJsonFileIfExists(SLYA_STATE_BACKUP_CURRENT)
	const previous = readJsonFileIfExists(SLYA_STATE_BACKUP_PREV)
	const metadata = readJsonFileIfExists(SLYA_STATE_BACKUP_META)
	const best = current && !current.error ? current : previous && !previous.error ? previous : null
	const currentAgeMs = current && !current.error && current.writtenAt ? Date.now() - Date.parse(current.writtenAt) : null
	const previousAgeMs = previous && !previous.error && previous.writtenAt ? Date.now() - Date.parse(previous.writtenAt) : null
	logToUpgradeLog(`[ELECTRON][SLYA-STATE-BAK] read currentOk=${!!(current && !current.error)} currentAgeMin=${Number.isFinite(currentAgeMs) ? Math.round(currentAgeMs / 60000) : 'na'} previousOk=${!!(previous && !previous.error)} previousAgeMin=${Number.isFinite(previousAgeMs) ? Math.round(previousAgeMs / 60000) : 'na'} selected=${best === current ? 'current' : best === previous ? 'previous' : 'none'}`)
	return {
		ok: !!best,
		current,
		previous,
		metadata,
		best,
		paths: {
			current: SLYA_STATE_BACKUP_CURRENT,
			previous: SLYA_STATE_BACKUP_PREV,
			metadata: SLYA_STATE_BACKUP_META
		}
	}
}

function auditLeveldb(targetDir)
{
	const dir = targetDir || LEVELDB_DIR
	try {
		if (!fs.existsSync(dir)) return { exists: false, files: [], totalSize: 0 }
		const entries = fs.readdirSync(dir, { withFileTypes: true })
			.filter(e => e.isFile())
			.map(e => {
				try {
					const stat = fs.statSync(path.join(dir, e.name))
					return { name: e.name, size: stat.size, mtime: stat.mtimeMs }
				} catch (e) { return { name: e.name, size: 0, mtime: 0 } }
			})
			.sort((a, b) => a.name.localeCompare(b.name))
		const totalSize = entries.reduce((sum, f) => sum + f.size, 0)
		const lastModified = entries.reduce((max, f) => Math.max(max, Number(f.mtime || 0)), 0)
		return { exists: true, dir, files: entries, totalSize, count: entries.length, lastModified }
	} catch (e) {
		return { exists: false, files: [], totalSize: 0, lastModified: 0, error: String(e?.message || e) }
	}
}

function extractJsonObjectsContaining(text, marker)
{
	const objects = []
	let markerIndex = -1
	while ((markerIndex = text.indexOf(marker, markerIndex + 1)) !== -1) {
		const start = text.lastIndexOf('{', markerIndex)
		if (start === -1) continue
		let depth = 0
		let inString = false
		let escaped = false
		for (let i = start; i < text.length; i++) {
			const ch = text[i]
			if (inString) {
				if (escaped) escaped = false
				else if (ch === '\\') escaped = true
				else if (ch === '"') inString = false
				continue
			}
			if (ch === '"') {
				inString = true
				continue
			}
			if (ch === '{') depth++
			else if (ch === '}') {
				depth--
				if (depth === 0) {
					try { objects.push(JSON.parse(text.slice(start, i + 1))) } catch (e) {}
					break
				}
			}
		}
	}
	return objects
}

function getLeveldbSettingsHealth(targetDir)
{
	const result = {
		hasConfiguredSettings: false,
		hasAnySettings: false,
		keyCount: 0,
		hasSecret: false,
		hasInstanceName: false,
		hasRpc: false,
		hasInflux: false,
		saveProfile: false,
		savedProfileLength: 0,
		craftingJobs: 0,
		upgradeAutomationEnabled: false,
		fleetConfigCount: 0,
		craftConfigCount: 0,
		hasParsedSettings: false,
		hasUsableSettings: false
	}
	try {
		if (!fs.existsSync(targetDir)) return result
		const settingsObjects = []
		let combinedText = ''
		for (const name of fs.readdirSync(targetDir)) {
			if (!/\.(ldb|log)$/i.test(name)) continue
			const filePath = path.join(targetDir, name)
			let text = ''
			try { text = fs.readFileSync(filePath).toString('latin1') } catch (e) { continue }
			combinedText += '\n' + text
			settingsObjects.push(...extractJsonObjectsContaining(text, '"priorityFee"')
				.filter(settings => settings && typeof settings === 'object' && Object.prototype.hasOwnProperty.call(settings, 'mySecretKey')))
		}
		result.fleetConfigCount = (combinedText.match(/"moveType"\s*:/g) || []).length
		result.craftConfigCount = (combinedText.match(/"label"\s*:\s*"craft\d+"/g) || []).length
		if (!settingsObjects.length) {
			result.hasAnySettings = combinedText.includes('globalSettings') || combinedText.includes('"priorityFee"') || combinedText.includes('"mySecretKey"')
			result.hasSecret = /"mySecretKey"\s*:\s*"[^"]{10,}"/.test(combinedText)
			result.hasInstanceName = /"slyInstanceName"\s*:\s*"[^"]+"/.test(combinedText)
			result.hasRpc = /"heliusRpcURL"\s*:\s*"[^"]{10,}"/.test(combinedText)
			result.hasInflux = /"influxURL"\s*:\s*"[^"]{10,}"/.test(combinedText) && /"influxAuth"\s*:\s*"[^"]{10,}"/.test(combinedText)
			const savedProfileMatch = combinedText.match(/"savedProfile"\s*:\s*\[([^\]]*)\]/)
			result.savedProfileLength = savedProfileMatch && savedProfileMatch[1].trim() ? savedProfileMatch[1].split(',').length : 0
			result.saveProfile = /"saveProfile"\s*:\s*true/.test(combinedText)
			const craftingJobsMatch = combinedText.match(/"craftingJobs"\s*:\s*(\d+)/)
			result.craftingJobs = craftingJobsMatch ? Number(craftingJobsMatch[1]) : 0
			result.upgradeAutomationEnabled = /"upgradeAutomationEnabled"\s*:\s*true/.test(combinedText)
			result.hasUsableSettings = !!(result.hasAnySettings && result.hasInstanceName)
			result.hasConfiguredSettings = result.hasUsableSettings
			return result
		}
		const settings = settingsObjects[settingsObjects.length - 1]
		const savedProfile = Array.isArray(settings.savedProfile) ? settings.savedProfile : []
		result.hasParsedSettings = true
		result.hasAnySettings = true
		result.keyCount = Object.keys(settings || {}).length
		result.hasSecret = !!String(settings.mySecretKey || '').trim()
		result.hasInstanceName = !!String(settings.slyInstanceName || '').trim()
		result.hasRpc = !!String(settings.heliusRpcURL || '').trim()
		result.hasInflux = !!String(settings.influxURL || '').trim() && !!String(settings.influxAuth || '').trim() && !!String(settings.influxDB || '').trim()
		result.saveProfile = !!settings.saveProfile
		result.savedProfileLength = savedProfile.length
		result.craftingJobs = Number(settings.craftingJobs || 0)
		result.upgradeAutomationEnabled = !!settings.upgradeAutomationEnabled
		result.hasUsableSettings = true
		result.hasConfiguredSettings = result.hasUsableSettings
		return result
	} catch (e) {
		result.error = String(e?.message || e)
		return result
	}
}

function formatSettingsHealth(health)
{
	return `configured=${!!health.hasConfiguredSettings} usable=${!!health.hasUsableSettings} any=${!!health.hasAnySettings} parsed=${!!health.hasParsedSettings} keys=${Number(health.keyCount || 0)} secret=${!!health.hasSecret} instance=${!!health.hasInstanceName} rpc=${!!health.hasRpc} influx=${!!health.hasInflux} saveProfile=${!!health.saveProfile} savedProfileLen=${Number(health.savedProfileLength || 0)} craftingJobs=${Number(health.craftingJobs || 0)} lpEnabled=${!!health.upgradeAutomationEnabled} fleetConfigs=${Number(health.fleetConfigCount || 0)} craftConfigs=${Number(health.craftConfigCount || 0)}`
}

function copyLeveldbSnapshot(targetDir, label, sourceDir = LEVELDB_DIR)
{
	try {
		const source = auditLeveldb(sourceDir)
		if (!source.exists || source.totalSize === 0) return { ok: false, skipped: true, error: 'source leveldb is empty', source }
		try { fs.rmSync(targetDir, { recursive: true, force: true }) } catch (e) {}
		fs.mkdirSync(path.dirname(targetDir), { recursive: true })
		fs.cpSync(sourceDir, targetDir, { recursive: true, force: true })
		const copy = auditLeveldb(targetDir)
		logToUpgradeLog(`[ELECTRON][LEVELDB-${label}] copied sourceFiles=${source.count} sourceSize=${source.totalSize} copyFiles=${copy.count} copySize=${copy.totalSize} source=${sourceDir} target=${targetDir}`)
		return { ok: true, source, copy, target: targetDir, sourceDir }
	} catch (e) {
		logToUpgradeLog(`[ELECTRON][LEVELDB-${label}] error=${String(e?.message || e)} target=${targetDir}`)
		return { ok: false, error: String(e?.message || e), target: targetDir }
	}
}

function getBackupCandidates()
{
	const candidates = [
		{ label: 'bak', dir: LEVELDB_BAK_DIR },
		{ label: 'bak.prev', dir: LEVELDB_PREV_BAK_DIR }
	]
	try {
		const parent = path.dirname(LEVELDB_DIR)
		for (const name of fs.readdirSync(parent)) {
			if (!name.startsWith('leveldb.pre-aep-update-')) continue
			candidates.push({ label: name, dir: path.join(parent, name) })
		}
	} catch (e) {}
	return candidates.map(candidate => {
		const audit = auditLeveldb(candidate.dir)
		const health = getLeveldbSettingsHealth(candidate.dir)
		return { ...candidate, audit, health }
	})
}

function findLatestUsableBackup()
{
	return getBackupCandidates()
		.filter(candidate => candidate.audit.exists && candidate.audit.totalSize >= 4096 && candidate.health.hasUsableSettings)
		.sort((a, b) => {
			const timeDiff = Number(b.audit.lastModified || 0) - Number(a.audit.lastModified || 0)
			if (timeDiff) return timeDiff
			return Number(b.audit.totalSize || 0) - Number(a.audit.totalSize || 0)
		})[0] || null
}

function liveNeedsRestoreFromBackup(live, liveHealth)
{
	// Do not restore merely because the string-based health scanner failed to
	// recognize settings inside Chromium's LevelDB files. Compaction can make a
	// valid current DB look "unusable" to this scanner, and restoring then can
	// resurrect an older config. Only restore when the live DB is actually
	// missing/tiny; userscript-level JSON fallback handles truly missing
	// settings after startup.
	return !live?.exists || Number(live.totalSize || 0) < 4096
}

function seedInitialLeveldbBackup()
{
	try {
		const live = auditLeveldb(LEVELDB_DIR)
		const bak = auditLeveldb(LEVELDB_BAK_DIR)
		const liveHealth = getLeveldbSettingsHealth(LEVELDB_DIR)
		if (!live.exists || live.totalSize < 4096 || bak.exists) {
			return { ok: false, skipped: true, live, bak, liveHealth }
		}
		if (!liveHealth.hasUsableSettings) {
			logToUpgradeLog(`[ELECTRON][LEVELDB-SEED-BAK] skipped unhealthy live ${formatSettingsHealth(liveHealth)}`)
			return { ok: false, skipped: true, live, bak, liveHealth }
		}
		const result = copyLeveldbSnapshot(LEVELDB_BAK_DIR, 'SEED-BAK')
		logToUpgradeLog(`[ELECTRON][LEVELDB-SEED-BAK] ${result.ok ? 'ok' : 'fail'} liveHealth=[${formatSettingsHealth(liveHealth)}]`)
		return { ...result, liveHealth }
	} catch (e) {
		logToUpgradeLog(`[ELECTRON][LEVELDB-SEED-BAK] error=${String(e?.message || e)}`)
		return { ok: false, error: String(e?.message || e) }
	}
}

function preserveLeveldbBeforeUpdate()
{
	try {
		const live = auditLeveldb(LEVELDB_DIR)
		if (!live.exists || live.totalSize < 4096) {
			logToUpgradeLog(`[ELECTRON][LEVELDB-PRE-UPDATE] skipped liveSize=${live.totalSize || 0}`)
			return { ok: false, skipped: true, live }
		}
		const timestampedDir = path.join(APP_ROOT, 'data', 'Local Storage', `leveldb.pre-aep-update-${leveldbTimestamp()}`)
		const preUpdate = copyLeveldbSnapshot(timestampedDir, 'PRE-UPDATE')
		const bak = auditLeveldb(LEVELDB_BAK_DIR)
		const liveHealth = getLeveldbSettingsHealth(LEVELDB_DIR)
		let seededBak = { ok: false, skipped: true }
		if ((!bak.exists || bak.totalSize === 0) && liveHealth.hasUsableSettings) {
			seededBak = copyLeveldbSnapshot(LEVELDB_BAK_DIR, 'PRE-UPDATE-BAK')
		}
		return { ok: preUpdate.ok, preUpdate, seededBak }
	} catch (e) {
		logToUpgradeLog(`[ELECTRON][LEVELDB-PRE-UPDATE] error=${String(e?.message || e)}`)
		return { ok: false, error: String(e?.message || e) }
	}
}

function snapshotLeveldbToBackup()
{
	try {
		if (!fs.existsSync(LEVELDB_DIR)) return { ok: false, error: 'leveldb dir missing' }
		const live = auditLeveldb(LEVELDB_DIR)
		if (!live.exists || live.totalSize === 0) return { ok: false, error: 'live leveldb is empty, skipping snapshot' }
		const liveHealth = getLeveldbSettingsHealth(LEVELDB_DIR)
		if (!liveHealth.hasUsableSettings) {
			logToUpgradeLog(`[ELECTRON][LEVELDB-BAK] snapshot continuing despite scanner-unverified live ${formatSettingsHealth(liveHealth)}`)
		}
		if (fs.existsSync(LEVELDB_BAK_DIR)) {
			try { fs.rmSync(LEVELDB_PREV_BAK_DIR, { recursive: true, force: true }) } catch (e) {}
			try { fs.cpSync(LEVELDB_BAK_DIR, LEVELDB_PREV_BAK_DIR, { recursive: true, force: true }) } catch (e) {}
		}
		// Remove old backup then copy live -> bak (synchronous, simple)
		try { fs.rmSync(LEVELDB_BAK_DIR, { recursive: true, force: true }) } catch (e) {}
		fs.cpSync(LEVELDB_DIR, LEVELDB_BAK_DIR, { recursive: true, force: true })
		const bak = auditLeveldb(LEVELDB_BAK_DIR)
		const bakHealth = getLeveldbSettingsHealth(LEVELDB_BAK_DIR)
		logToUpgradeLog(`[ELECTRON][LEVELDB-BAK] snapshot ok liveFiles=${live.count} liveSize=${live.totalSize} bakFiles=${bak.count} bakSize=${bak.totalSize} ${formatSettingsHealth(bakHealth)}`)
		return { ok: true, live, bak, liveHealth, bakHealth }
	} catch (e) {
		logToUpgradeLog(`[ELECTRON][LEVELDB-BAK] snapshot error=${String(e?.message || e)}`)
		return { ok: false, error: String(e?.message || e) }
	}
}

function restoreLeveldbFromBackup(sourceDir = null, sourceLabel = 'backup')
{
	try {
		let source = sourceDir ? { label: sourceLabel, dir: sourceDir, audit: auditLeveldb(sourceDir), health: getLeveldbSettingsHealth(sourceDir) } : findLatestUsableBackup()
		if (!source) return { ok: false, error: 'no configured backup leveldb to restore from' }
		if (!source.audit.exists || source.audit.totalSize === 0) return { ok: false, error: 'no backup leveldb to restore from' }
		if (!source.health.hasUsableSettings) return { ok: false, error: `backup is not usable enough to restore: ${formatSettingsHealth(source.health)}` }
		const beforeDir = path.join(path.dirname(LEVELDB_DIR), `leveldb.before-restore-${leveldbTimestamp()}`)
		try {
			const live = auditLeveldb(LEVELDB_DIR)
			if (live.exists && live.totalSize > 0) copyLeveldbSnapshot(beforeDir, 'BEFORE-RESTORE')
		} catch (e) {}
		// Overwrite live with bak contents
		try { fs.rmSync(LEVELDB_DIR, { recursive: true, force: true }) } catch (e) {}
		fs.mkdirSync(LEVELDB_DIR, { recursive: true })
		fs.cpSync(source.dir, LEVELDB_DIR, { recursive: true, force: true })
		const live = auditLeveldb(LEVELDB_DIR)
		const liveHealth = getLeveldbSettingsHealth(LEVELDB_DIR)
		logToUpgradeLog(`[ELECTRON][LEVELDB-RESTORE] restored from ${source.label} sourceFiles=${source.audit.count} sourceSize=${source.audit.totalSize} sourceHealth=[${formatSettingsHealth(source.health)}] liveFiles=${live.count} liveSize=${live.totalSize} liveHealth=[${formatSettingsHealth(liveHealth)}]`)
		return { ok: true, source, live, liveHealth, beforeDir }
	} catch (e) {
		logToUpgradeLog(`[ELECTRON][LEVELDB-RESTORE] error=${String(e?.message || e)}`)
		return { ok: false, error: String(e?.message || e) }
	}
}

function maybeAutoRestoreLeveldb()
{
	try {
		const live = auditLeveldb(LEVELDB_DIR)
		const liveHealth = getLeveldbSettingsHealth(LEVELDB_DIR)
		const latestBackup = findLatestUsableBackup()
		const bak = latestBackup?.audit || auditLeveldb(LEVELDB_BAK_DIR)
		const bakHealth = latestBackup?.health || getLeveldbSettingsHealth(LEVELDB_BAK_DIR)
		const liveNeedsRestore = liveNeedsRestoreFromBackup(live, liveHealth)
		const bakHasContent = !!latestBackup
		if (liveNeedsRestore && bakHasContent) {
			const result = restoreLeveldbFromBackup(latestBackup.dir, latestBackup.label)
			logToUpgradeLog(`[ELECTRON][LEVELDB-AUTO-RESTORE] triggered liveSize=${live.totalSize} backup=${latestBackup.label} bakSize=${bak.totalSize} liveHealth=[${formatSettingsHealth(liveHealth)}] bakHealth=[${formatSettingsHealth(bakHealth)}] result=${result.ok ? 'ok' : 'fail:' + result.error}`)
			return result
		} else {
			logToUpgradeLog(`[ELECTRON][LEVELDB-AUTO-RESTORE] skipped liveSize=${live.totalSize} latestBackup=${latestBackup?.label || 'none'} bakSize=${bak.totalSize} liveNeedsRestore=${liveNeedsRestore} liveMtime=${Number(live.lastModified || 0)} bakMtime=${Number(bak.lastModified || 0)} liveHealth=[${formatSettingsHealth(liveHealth)}] bakHasContent=${bakHasContent} bakHealth=[${formatSettingsHealth(bakHealth)}]`)
			return { ok: false, skipped: true, live, bak, liveHealth, bakHealth }
		}
	} catch (e) {
		logToUpgradeLog(`[ELECTRON][LEVELDB-AUTO-RESTORE] error=${String(e?.message || e)}`)
		return { ok: false, error: String(e?.message || e) }
	}
}


installCrashEventLogging()

app.whenReady().then(async () => {
const powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
logToUpgradeLog(`[ELECTRON][POWER] prevent-app-suspension blocker=${powerSaveBlockerId} active=${powerSaveBlocker.isStarted(powerSaveBlockerId)}`)
// Wrapper-level leveldb audit and auto-restore (before any SLYA save could overwrite evidence)
try {
  const liveAudit = auditLeveldb(LEVELDB_DIR);
  const bakAudit = auditLeveldb(LEVELDB_BAK_DIR);
  const liveNames = liveAudit.files.map(f => f.name).join(',');
  const bakNames = bakAudit.files.map(f => f.name).join(',');
  logToUpgradeLog(`[ELECTRON][LEVELDB-AUDIT] liveCount=${liveAudit.count} liveSize=${liveAudit.totalSize} liveFiles=[${liveNames}] bakCount=${bakAudit.count} bakSize=${bakAudit.totalSize} bakFiles=[${bakNames}]`);
  seedInitialLeveldbBackup();
  // Auto-restore if live is suspiciously fresh/empty and bak has content
  maybeAutoRestoreLeveldb();
} catch (e) {
  logToUpgradeLog(`[ELECTRON][LEVELDB-AUDIT] error=${String(e?.message || e)}`);
}
try {
  const startupLogPath = path.join(APP_ROOT, 'data', 'upgrade-automation.log');
  fs.appendFileSync(startupLogPath, `[${new Date().toISOString()}] [ELECTRON] main startup\n`, 'utf8');
} catch (e) {}
const filter = {
  urls: ['https://rpc.ironforge.network/*']
}
session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
  details.requestHeaders['Origin'] = 'https://based.staratlas.com'
  callback({ requestHeaders: details.requestHeaders })
})

var win
var version
var aephiaVersion

var firstinit=false;
if(!fs.existsSync(path.join(APP_ROOT, 'app', 'SLY_Assistant.user.js')))
{
	win = createWindow(version, aephiaVersion)
	await wait(500);
	const latest = await updateSLYA();
	version = latest.version;
	aephiaVersion = latest.aephiaVersion;
	await wait(3000);
	win.webContents.send('firstinitdone','');
	await wait(3000);
	firstinit=true;
}
const installedMeta = readInstalledSLYAMeta();
file = installedMeta.file;
version = installedMeta.version;
aephiaVersion = installedMeta.aephiaVersion;

if(firstinit)
{
	loadApp(win, version, aephiaVersion)
}
else
{
	win = createWindow(version, aephiaVersion)
}

  ipcMain.on('openDevTools', function() { win.openDevTools() })
  ipcMain.on('openUpdate', async function() {
	let originalVersion = 'unknown'
	let viktorVersion = 'unknown'
	let currentVersion = version
	let currentLabel = `SLYA v${version}`
	let originalLatest = null
	let viktorLatest = null
	try { originalLatest = await fetchSLYA(ORIGINAL_UPDATE_URL); originalVersion = originalLatest.version } catch (error) { originalVersion = 'unavailable' }
	try { viktorLatest = await fetchSLYA(AEP_UPDATE_URL); viktorVersion = viktorLatest.aephiaVersion !== 'unknown' ? viktorLatest.aephiaVersion : viktorLatest.version } catch (error) { viktorVersion = 'unavailable' }
	try {
		const currentFile = fs.readFileSync(path.join(APP_ROOT, 'app', 'SLY_Assistant.user.js')).toString()
		const currentAephiaVersion = readUserscriptMeta(currentFile, 'aephia-version')
		currentVersion = currentAephiaVersion !== 'unknown' ? currentAephiaVersion : readUserscriptMeta(currentFile, 'version')
		currentLabel = currentAephiaVersion !== 'unknown' ? `AEP v${currentVersion}` : `SLYA v${currentVersion}`
	} catch (error) {}
	  
	win.webContents.send('update', '<div style="position:absolute;left:50%;margin-left:-230px;top:30vh;width:460px;text-align:center;background-color:white;padding:10px;color:black">UPDATE<br>Current version: '+currentLabel+'<br><button onClick="window.electronAPI.updateToLatestSwift()">Update to SLYA v'+originalVersion+'</button><br><button onClick="window.electronAPI.updateToLatestAep()">Update to AEP v'+viktorVersion+'</button><br><small>(The app will automatically restart after the update)</small><br><button onClick="document.getElementById(\'updateOverlay\').remove()">Cancel</button><br></div>');
  })
  ipcMain.on('updateToLatestSwift', async function() {
	const latest = await updateSLYA(ORIGINAL_UPDATE_URL);
	version = latest.version;
	aephiaVersion = latest.aephiaVersion;
	win.webContents.send('update', '<div style="position:absolute;left:50%;margin-left:-200px;top:40vh;width:400px;text-align:center;background-color:#eee;color:black">SLYA CODE UPDATED<br>Restarting app ...<br></div>');
	restartApp()
  })
  ipcMain.on('updateToLatestAep', async function() {
	const latest = await updateAepFromGitHub();
	version = latest.version;
	aephiaVersion = latest.aephiaVersion;
	win.webContents.send('update', '<div style="position:absolute;left:50%;margin-left:-200px;top:40vh;width:400px;text-align:center;background-color:#eee;color:black">AEP CODE UPDATED<br>Restarting app ...<br></div>');
	restartApp()
  })

  ipcMain.handle('appendUpgradeAutomationLogFile', async (event, line) => {
	try {
		const logPath = path.join(APP_ROOT, 'data', 'upgrade-automation.log');
		const stamped = `[${new Date().toISOString()}] ${String(line || '')}\n`;
		fs.appendFileSync(logPath, stamped, 'utf8');
		return { ok: true, path: logPath };
	} catch (error) {
		return { ok: false, error: String(error?.message || error) };
	}
  })

  ipcMain.handle('snapshotLeveldbToBackup', async () => {
	return snapshotLeveldbToBackup();
  })

  ipcMain.handle('writeSlyaStateBackup', async (event, payload) => {
	return writeSlyaStateBackup(payload);
  })

  ipcMain.handle('readSlyaStateBackup', async () => {
	return readSlyaStateBackup();
  })

  ipcMain.handle('restoreLeveldbFromBackup', async () => {
	return restoreLeveldbFromBackup();
  })

  ipcMain.handle('auditLeveldb', async () => {
	const live = auditLeveldb(LEVELDB_DIR);
	const bak = auditLeveldb(LEVELDB_BAK_DIR);
	const prev = auditLeveldb(LEVELDB_PREV_BAK_DIR);
	const liveHealth = getLeveldbSettingsHealth(LEVELDB_DIR);
	const bakHealth = getLeveldbSettingsHealth(LEVELDB_BAK_DIR);
	const prevHealth = getLeveldbSettingsHealth(LEVELDB_PREV_BAK_DIR);
	return { live, bak, prev, liveHealth, bakHealth, prevHealth, latestBackup: findLatestUsableBackup()?.label || null };
  })
  
  
})
