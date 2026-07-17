const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
    openDevTools: () => ipcRenderer.send('openDevTools', ''),
    openUpdate: () => ipcRenderer.send('openUpdate', ''),
    updateToLatestSwift: () => ipcRenderer.send('updateToLatestSwift', ''),
    updateToLatestAep: () => ipcRenderer.send('updateToLatestAep', ''),
    appendUpgradeAutomationLogFile: (line) => ipcRenderer.invoke('appendUpgradeAutomationLogFile', line),
    testUpgradeAutomationLogFile: () => ipcRenderer.invoke('appendUpgradeAutomationLogFile', '[ELECTRON] preload test call'),
    snapshotLeveldbToBackup: () => ipcRenderer.invoke('snapshotLeveldbToBackup'),
    writeSlyaStateBackup: (payload) => ipcRenderer.invoke('writeSlyaStateBackup', payload),
    readSlyaStateBackup: () => ipcRenderer.invoke('readSlyaStateBackup'),
    restoreLeveldbFromBackup: () => ipcRenderer.invoke('restoreLeveldbFromBackup'),
    auditLeveldb: () => ipcRenderer.invoke('auditLeveldb'),
})

ipcRenderer.on('firstinitdone', (event, data) => {
	const waitmsg = document.getElementById('wait');
	waitmsg.innerHTML='Latest version loaded - restarting ...';
});

ipcRenderer.on('updateAvailability', (event, data) => {
  const updateBtn = document.getElementById('updateBtn');
  if (!updateBtn) return;
  const available = !!data?.available;
  updateBtn.style.color = available ? '#4caf50' : '';
  updateBtn.title = available ? `AEP v${data.version} is available` : 'No AEP update available';
});

ipcRenderer.on('update', (event, data) => {
  const oldOverlay = document.getElementById('updateOverlay');
  if(oldOverlay) oldOverlay.remove();
  
  const body = document.querySelector('body');
  let el = document.createElement('div')
  el.id = 'updateOverlay';
  el.style.backgroundColor = 'rgba(0,0,0,0.5)';
  el.style.top = 0;
  el.style.left = 0;
  el.style.width = '100vw';
  el.style.height = '100vh';
  el.style.position = 'absolute';
  el.style.zIndex = '1000';
  el.innerHTML = data
  body.append(el)
})
