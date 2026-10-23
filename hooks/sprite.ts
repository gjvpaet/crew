import type { Accessory, MascotPrefs, MascotStyle, Role } from '../types'

export type SpriteCell = { ch: string; fg?: string; bg?: string }

export const PALETTE = { body: '#7C9CF5', shade: '#5570C8', eye: '#1C1F2B' }

export const ACCENTS: Record<Exclude<Accessory, 'none'>, { main: string; dark: string }> = {
	headset: { main: '#AEB6C4', dark: '#5B6475' },
	beret: { main: '#E0566B', dark: '#B83A50' },
	glasses: { main: '#2B2F3A', dark: '#2B2F3A' },
	hardhat: { main: '#F2B705', dark: '#C99500' }
}

export const DEFAULT_ACCESSORY: Record<Role, Accessory> = {
	developer: 'headset',
	designer: 'beret',
	researcher: 'glasses',
	reviewer: 'hardhat',
	plain: 'none'
}

// B body, D shade (feet), E eye, A accessory, a accessory dark, '.' empty.
const BASE = ['........', '........', '..BBBB..', '.BBBBBB.', '.BEBBEB.', '.BBBBBB.', '..BBBB..', '.DD..DD.']

const OVERLAYS: Record<Accessory, Record<number, string>> = {
	headset: { 1: '..AAAA..', 2: '.A....A.', 3: 'a......a', 4: 'a......a' },
	beret: { 0: '....a...', 1: '..AAAAA.', 2: '.AAAAA..' },
	glasses: { 4: '.AEAAEA.' },
	hardhat: { 1: '..AAAA..', 2: 'aAAAAAAa' },
	none: {}
}

const styleFor = (role: Role, prefs: MascotPrefs): MascotStyle => prefs[role] ?? {}

// A stored or hand-edited pref may name an accessory this build has never heard of: it draws as none.
function accessoryFor(role: Role, prefs: MascotPrefs): Accessory {
	const accessory = styleFor(role, prefs).accessory ?? DEFAULT_ACCESSORY[role]
	return Object.prototype.hasOwnProperty.call(OVERLAYS, accessory) ? accessory : 'none'
}

export function spriteGrid(role: Role, prefs: MascotPrefs): string[] {
	const overlay = OVERLAYS[accessoryFor(role, prefs)] ?? {}
	return BASE.map((row, index) => {
		const layer = overlay[index]
		if (!layer) return row
		return [...row].map((ch, col) => (layer[col] === '.' ? ch : layer[col])).join('')
	})
}

function colourOf(ch: string, accessory: Accessory, style: MascotStyle): string | undefined {
	const accent = accessory === 'none' ? undefined : ACCENTS[accessory]
	switch (ch) {
		case 'B':
			return style.body ?? PALETTE.body
		case 'D':
			return style.body ?? PALETTE.shade
		case 'E':
			return PALETTE.eye
		case 'A':
			return style.accent ?? accent?.main
		case 'a':
			return style.accent ?? accent?.dark
		default:
			return undefined
	}
}

export type SpritePixel = { x: number; y: number; fill: string }

// Every coloured pixel of the 8×8 sprite: the one source both the half-block cells and the SVG draw from.
export function spritePixels(role: Role, prefs: MascotPrefs): SpritePixel[] {
	const style = styleFor(role, prefs)
	const accessory = accessoryFor(role, prefs)
	const pixels: SpritePixel[] = []
	spriteGrid(role, prefs).forEach((row, y) => {
		;[...row].forEach((ch, x) => {
			const fill = colourOf(ch, accessory, style)
			if (fill) pixels.push({ x, y, fill })
		})
	})
	return pixels
}

function cell(top: string | undefined, bottom: string | undefined): SpriteCell {
	if (top && bottom) return { ch: '▀', fg: top, bg: bottom }
	if (top) return { ch: '▀', fg: top }
	if (bottom) return { ch: '▄', fg: bottom }
	return { ch: ' ' }
}

export function spriteCells(role: Role, prefs: MascotPrefs): SpriteCell[][] {
	const colours: Array<Array<string | undefined>> = Array.from({ length: 8 }, () => Array(8).fill(undefined))
	for (const { x, y, fill } of spritePixels(role, prefs)) colours[y][x] = fill
	const rows: SpriteCell[][] = []
	for (let r = 0; r < 4; r++) {
		const top = colours[r * 2]
		const bottom = colours[r * 2 + 1]
		rows.push(top.map((fill, col) => cell(fill, bottom[col])))
	}
	return rows
}
