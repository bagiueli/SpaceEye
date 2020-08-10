import Axios from 'axios'
import { app, BrowserWindow, ipcMain, powerMonitor, screen, systemPreferences } from 'electron'
import * as path from 'path'
import * as url from 'url'

import {
    CLOSE_APPLICATION_CHANNEL,
    GET_SATELLITE_CONFIG_CHANNEL,
    GetSatelliteConfigIpcResponse,
    IpcParams,
    IpcRequest,
    SET_WALLPAPER_CHANNEL,
    SetWallpaperIpcParams
} from '../shared/IpcDefinitions'
import { AppConfigStore } from './app_config_store'
import { SatelliteConfigStore } from './satellite_config_store'
import { Initiator } from './update_lock'
import { WallpaperManager } from './wallpaper_manager'

const HEARTBEAT_INTERVAL = 600000
let heartbeatHandle: number

let win: BrowserWindow | null

Axios.defaults.adapter = require('axios/lib/adapters/http')

const installExtensions = async () => {
    const installer = require('electron-devtools-installer')
    const forceDownload = !!process.env.UPGRADE_EXTENSIONS
    const extensions = ['REACT_DEVELOPER_TOOLS', 'REDUX_DEVTOOLS']

    return Promise.all(
        extensions.map(name => installer.default(installer[name], forceDownload))
    ).catch(console.log) // eslint-disable-line no-console
}

const createWindow = async () => {
    if (process.env.NODE_ENV !== 'production') {
        await installExtensions()
    }

    win = new BrowserWindow({
        width: 800,
        height: 600,
        darkTheme: true,
        frame: false,
        webPreferences: {
            nodeIntegration: true
        },
        backgroundColor: '#222222'
    })
    if (process.platform === 'darwin') {
        win.setWindowButtonVisibility(false)
    }

    if (process.env.NODE_ENV !== 'production') {
        process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1' // eslint-disable-line require-atomic-updates
        win.loadURL(`http://localhost:2003`)
    } else {
        win.loadURL(
            url.format({
                pathname: path.join(__dirname, 'index.html'),
                protocol: 'file:',
                slashes: true
            })
        )
    }

    if (process.env.NODE_ENV !== 'production') {
        // Open DevTools, see https://github.com/electron/electron/issues/12438 for why we wait for dom-ready
        win.webContents.once('dom-ready', () => {
            win!.webContents.openDevTools({ mode: 'detach' })
        })
    }

    win.on('closed', () => {
        win = null
    })
}

/**
 * Heartbeat function which runs every `HEARTBEAT_INTERVAL` seconds to perform
 * any necessary tasks.
 */
async function heartbeat() {
    await WallpaperManager.update(Initiator.heartbeatFunction)
}

app.on('ready', () => {
    createWindow()
    heartbeatHandle = setInterval(heartbeat, HEARTBEAT_INTERVAL)

    // Display config change triggers update
    screen.on('display-added', async () => {
        await WallpaperManager.update(Initiator.displayChangeWatcher)
    })

    screen.on('display-removed', async () => {
        await WallpaperManager.update(Initiator.displayChangeWatcher)
    })

    screen.on('display-metrics-changed', async () => {
        await WallpaperManager.update(Initiator.displayChangeWatcher)
    })

    // Update when machine is unlocked/resumed
    // TODO: Need a new initiator
    if (process.platform === 'darwin' || process.platform === 'win32') {
        powerMonitor.on('unlock-screen', async () => {
            await WallpaperManager.update(Initiator.displayChangeWatcher)
        })
    }

    if (process.platform === 'linux' || process.platform === 'win32') {
        powerMonitor.on('resume', async () => {
            await WallpaperManager.update(Initiator.displayChangeWatcher)
        })
    }
})

app.on('will-quit', () => {
    clearInterval(heartbeatHandle)
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

app.on('activate', () => {
    if (win === null) {
        createWindow()
    }
})

ipcMain.on(CLOSE_APPLICATION_CHANNEL, () => {
    if (win !== undefined) {
        win!.close()
    }
})

ipcMain.on(GET_SATELLITE_CONFIG_CHANNEL, async (event, params: IpcRequest<IpcParams>) => {
    const configStore = SatelliteConfigStore.Instance
    try {
        const response: GetSatelliteConfigIpcResponse = {
            config: await configStore.getConfig()
        }
        event.reply(params.responseChannel, response)
    } catch (error) {
        const response: GetSatelliteConfigIpcResponse = {
            config: undefined
        }
        event.reply(params.responseChannel, response)
    }
})

ipcMain.on(SET_WALLPAPER_CHANNEL, async (event, params: IpcRequest<SetWallpaperIpcParams>) => {
    AppConfigStore.currentViewId = params.params.viewId
    await WallpaperManager.update(Initiator.user)
    event.reply(params.responseChannel, {})
})

if (process.platform === 'darwin') {
    systemPreferences.subscribeWorkspaceNotification(
        'NSWorkspaceActiveSpaceDidChangeNotification',
        async () => {
            await WallpaperManager.update(Initiator.displayChangeWatcher)
        }
    )
}
