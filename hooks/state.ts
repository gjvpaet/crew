import { atom } from 'claude-code'

import type { MascotPrefs } from '../types'
import { EMPTY_STATE } from './tracker'

export const model = atom({ plugin: 'crew', key: 'model' } as const, EMPTY_STATE)
export const isBandHidden = atom({ plugin: 'crew', key: 'isBandHidden' } as const, false)
export const isFinishedOpen = atom({ plugin: 'crew', key: 'isFinishedOpen' } as const, false)
export const mascots = atom({ plugin: 'crew', key: 'mascots' } as const, {} as MascotPrefs)
