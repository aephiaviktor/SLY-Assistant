const { ipcMain, session, app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const APP_NAME = 'SLYA - MUD'
const APP_ID = 'slya.mud'
const ORIGINAL_UPDATE_URL = 'https://raw.githubusercontent.com/Swift42/SLY-Assistant/refs/heads/patch-collection-for-0.7.0/SLY_Assistant.user.js'
const AEP_UPDATE_URL = 'https://raw.githubusercontent.com/aephiaviktor/SLY-Assistant/refs/heads/patch-collection-for-0.7.0/SLY_Assistant.user.js'
app.setName(APP_NAME)
app.setAppUserModelId(APP_ID)
app.setPath('userData',path.join(__dirname, 'data'))

const createWindow = (version) => {
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
  win.loadFile('app/index.html', { query: { version: version } } )
  return win
}

async function fetchSLYA(sourceUrl)
{
	const response = await fetch(sourceUrl)
	if (!response.ok) throw new Error(`Failed to fetch SLYA update (${response.status}) from ${sourceUrl}`)
	const file = await response.text()
	const pos = file.indexOf('@version')
	const pos2 = file.indexOf("\n", pos)
	const version = pos >= 0 ? file.substring(pos + 8, pos2).trim() : 'unknown'
	return { file, version }
}

async function updateSLYA(sourceUrl = AEP_UPDATE_URL)
{
	const latest = await fetchSLYA(sourceUrl)
	fs.writeFileSync("app/SLY_Assistant.user.js", latest.file)
	return latest.version
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

var firstinit=false;
if(!fs.existsSync("app/SLY_Assistant.user.js"))
{
	win = createWindow(version)
	await wait(500);
	version = await updateSLYA();
	await wait(3000);
	win.webContents.send('firstinitdone','');
	await wait(3000);
	firstinit=true;
}
file = fs.readFileSync("app/SLY_Assistant.user.js").toString();
pos = file.indexOf('@version');
pos2 = file.indexOf("\n",pos);
version = file.substring(pos+8,pos2).trim();

if(firstinit)
{
	win.loadFile('app/index.html', { query: { version: version } } )
}
else
{
	win = createWindow(version)
}

  ipcMain.on('openDevTools', function() { win.openDevTools() })
  ipcMain.on('openUpdate', async function() {
	let originalVersion = 'unknown'
	let viktorVersion = 'unknown'
	let currentSource = 'Local/custom'
	let originalLatest = null
	let viktorLatest = null
	try { originalLatest = await fetchSLYA(ORIGINAL_UPDATE_URL); originalVersion = originalLatest.version } catch (error) { originalVersion = 'unavailable' }
	try { viktorLatest = await fetchSLYA(AEP_UPDATE_URL); viktorVersion = viktorLatest.version } catch (error) { viktorVersion = 'unavailable' }
	try {
		const currentFile = fs.readFileSync("app/SLY_Assistant.user.js").toString()
		if (viktorLatest && currentFile === viktorLatest.file) currentSource = 'Viktor'
		else if (originalLatest && currentFile === originalLatest.file) currentSource = 'Swift'
	} catch (error) {}
	  
	win.webContents.send('update', '<div style="position:absolute;left:50%;margin-left:-230px;top:30vh;width:460px;text-align:center;background-color:white;padding:10px;color:black">UPDATE<br>Current version '+currentSource+': '+version+'<br><button onClick="window.electronAPI.updateToLatestSwift()">Update to original latest: '+originalVersion+'</button><br><button onClick="window.electronAPI.updateToLatestAep()">Update to AEP latest: '+viktorVersion+'</button><br><small>(The app will automatically restart after the update)</small><br><button onClick="document.getElementById(\'updateOverlay\').remove()">Cancel</button><br></div>');
  })
  ipcMain.on('updateToLatestSwift', async function() {
	version = await updateSLYA(ORIGINAL_UPDATE_URL);
	win.webContents.send('update', '<div style="position:absolute;left:50%;margin-left:-200px;top:40vh;width:400px;text-align:center;background-color:#eee;color:black">ORIGINAL CODE UPDATED<br>Restarting ...<br></div>');
	setTimeout(function() { win.loadFile('app/index.html', { query: { version: version } } ) } , 2000 )
  })
  ipcMain.on('updateToLatestAep', async function() {
	version = await updateSLYA(AEP_UPDATE_URL);
	win.webContents.send('update', '<div style="position:absolute;left:50%;margin-left:-200px;top:40vh;width:400px;text-align:center;background-color:#eee;color:black">AEP CODE UPDATED<br>Restarting ...<br></div>');
	setTimeout(function() { win.loadFile('app/index.html', { query: { version: version } } ) } , 2000 )
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
