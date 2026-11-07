import type { ElectronAPI } from '@electron-toolkit/preload'
import type { BoxmakerApi } from '../shared/api'

declare global {
  interface Window {
    electron: ElectronAPI
    boxmaker: BoxmakerApi
  }
}
