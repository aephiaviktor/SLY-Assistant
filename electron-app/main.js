const { ipcMain, session, app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const APP_NAME = 'SLYA'
const APP_ID = 'slya'
const APP_INSTANCE_NAME = APP_NAME.replace(/^SLYA\s*-\s*/, '')
const ORIGINAL_UPDATE_URL = 'https://raw.githubusercontent.com/Swift42/SLY-Assistant/refs/heads/patch-collection-for-0.7.0/SLY_Assistant.user.js'
const AEP_UPDATE_BASE_URL = 'https://raw.githubusercontent.com/aephiaviktor/SLY-Assistant/refs/heads/aephia-slya-v0.7.35-07'
const AEP_UPDATE_URL = `${AEP_UPDATE_BASE_URL}/SLY_Assistant.user.js`
const AEP_WRAPPER_UPDATE_FILES = [
	{ url: `${AEP_UPDATE_BASE_URL}/electron-app/main.js`, target: 'main.js', transform: preserveElectronMainIdentity },
	{ url: `${AEP_UPDATE_BASE_URL}/electron-app/preload.js`, target: 'preload.js' },
	{ url: `${AEP_UPDATE_BASE_URL}/electron-app/app/index.html`, target: path.join('app', 'index.html'), transform: preserveElectronIndexIdentity }
]
app.setName(APP_NAME)
app.setAppUserModelId(APP_ID)
app.setPath('userData',path.join(__dirname, 'data'))

const loadApp = (win, version, aephiaVersion) => {
	win.loadFile('app/index.html', { query: { version: version, aephiaVersion: aephiaVersion, appInstanceName: APP_INSTANCE_NAME } } )
}

const createWindow = (version, aephiaVersion) => {
  const win = new BrowserWindow({
    title: APP_NAME,
    width: 800,
    height: 600,
    icon: path.join(__dirname, 'app/icons/128.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }    
  })
  //win.webContents.openDevTools()  
  win.setTitle(APP_NAME + (version ? ` v${version}` : ''))
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
	const file = fs.readFileSync("app/SLY_Assistant.user.js").toString()
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
		.replace(/const APP_NAME = '[^']+'/, `const APP_NAME = '${APP_NAME}'`)
		.replace(/const APP_ID = '[^']+'/, `const APP_ID = '${APP_ID}'`)
}

function preserveElectronIndexIdentity(file)
{
	return file
		.replace(/<title>[^<]+<\/title>/, `<title>${APP_NAME}</title>`)
		.replace(/appInstanceName'\) \|\| '[^']+'/, `appInstanceName') || ''`)
                .replace(/This SLYA - [^<]+ standalone version/g, `This SLYA standalone version`)
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


app.whenReady().then(async () => {
try {
  const startupLogPath = path.join(__dirname, 'data', 'upgrade-automation.log');
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
if(!fs.existsSync("app/SLY_Assistant.user.js"))
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
		const currentFile = fs.readFileSync("app/SLY_Assistant.user.js").toString()
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
		const logPath = path.join(__dirname, 'data', 'upgrade-automation.log');
		const stamped = `[${new Date().toISOString()}] ${String(line || '')}\n`;
		fs.appendFileSync(logPath, stamped, 'utf8');
		return { ok: true, path: logPath };
	} catch (error) {
		return { ok: false, error: String(error?.message || error) };
	}
  })
  
  
})
