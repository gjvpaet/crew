import type { Accessory, MascotPrefs, MascotStyle, Role } from '../types'

export type SpriteCell = { ch: string; fg?: string; bg?: string }

export type Species = 'pip' | 'bolt' | 'mochi' | 'wisp' | 'sprout' | 'bloop'

// running bobs and blinks; paused shuts its eyes; stopped is grey; still is a finished one at rest.
export type Pose = 'running' | 'paused' | 'stopped' | 'still'

// Who this one is and how it is doing, beside its role. `frame` is the terminal's beat: a running mascot glances on odd ones.
export type Look = { species?: Species; body?: string; pose?: Pose; frame?: number }

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

// B body, D shade, E eye, A accessory, a accessory dark, '.' empty. Every species keeps its eyes on row 4, where the
// glasses go, and its head under rows 0-2, where the hats go.
const SPECIES: Record<Species, string[]> = {
	pip: ['........', '........', '..BBBB..', '.BBBBBB.', '.BEBBEB.', '.BBBBBB.', '..BBBB..', '.DD..DD.'],
	bolt: ['....D...', '....D...', '.BBBBBB.', '.BBBBBB.', '.BEBBEB.', '.BBBBBB.', '.BDDDDB.', '..D..D..'],
	mochi: ['........', '.B....B.', '.BB..BB.', '.BBBBBB.', '.BEBBEB.', '.BBDDBB.', '.BBBBBB.', '.DD..DD.'],
	wisp: ['........', '........', '..BBBB..', '.BBBBBB.', '.BEBBEB.', '.BBBBBB.', '.BBBBBB.', '.B.BB.B.'],
	sprout: ['....DD..', '...D....', '..BBBB..', '.BBBBBB.', '.BEBBEB.', '.BBBBBB.', '.BBBBBB.', '..D..D..'],
	bloop: ['........', '........', '.BBBBBB.', 'BBBBBBBB', 'DBEBBEBD', '.BBBBBB.', '.BBBBBB.', '.D....D.']
}

// Sub-agents take these in turn, in the slot of their bar colour; Pip comes last, as Main is Pip.
export const SPECIES_ORDER: Species[] = ['bolt', 'mochi', 'wisp', 'sprout', 'bloop', 'pip']

const speciesOf = (look: Look): Species =>
	look.species && Object.prototype.hasOwnProperty.call(SPECIES, look.species) ? look.species : 'pip'

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

// A glance: each eye steps one pixel right, onto body or into its glasses' frame.
const glance = (row: string) => row.replace(/E([BA])/g, '$1E')

export function spriteGrid(role: Role, prefs: MascotPrefs, species: Species = 'pip', look: Look = {}): string[] {
	const overlay = OVERLAYS[accessoryFor(role, prefs)] ?? {}
	const isGlancing = look.pose === 'running' && (look.frame ?? 0) % 2 === 1
	return SPECIES[speciesOf({ species })].map((base, index) => {
		const layer = overlay[index]
		const row = layer ? [...base].map((ch, col) => (layer[col] === '.' ? ch : layer[col])).join('') : base
		return isGlancing ? glance(row) : row
	})
}

const HEX = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/

const hex = (channels: number[]) =>
	'#' + channels.map(value => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0')).join('').toUpperCase()

function channelsOf(colour: string): number[] | null {
	const match = HEX.exec(colour)
	return match ? match.slice(1).map(part => parseInt(part, 16)) : null
}

// The shade under a body colour: feet, antennae, a leaf. Pip's own blue keeps its hand-picked shade.
function shadeOf(body: string): string {
	if (body === PALETTE.body) return PALETTE.shade
	const channels = channelsOf(body)
	return channels ? hex(channels.map(value => value * 0.7)) : PALETTE.shade
}

// A stopped mascot's grey: its own lightness, pulled toward a mid grey so it reads as faded on light and dark alike.
function greyOf(colour: string): string {
	const channels = channelsOf(colour)
	if (!channels) return colour
	const luma = 0.299 * channels[0] + 0.587 * channels[1] + 0.114 * channels[2]
	const grey = luma * 0.5 + 128 * 0.5
	return hex([grey, grey, grey])
}

function colourOf(ch: string, accessory: Accessory, style: MascotStyle, body: string): string | undefined {
	const accent = accessory === 'none' ? undefined : ACCENTS[accessory]
	switch (ch) {
		case 'B':
			return body
		case 'D':
			return shadeOf(body)
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

// `eye` marks the two eye pixels; `under` is the body behind one, for a blink or a lid to show.
export type SpritePixel = { x: number; y: number; fill: string; eye?: 'open' | 'closed'; under?: string }

// Every coloured pixel of the 8×8 sprite: the one source both the half-block cells and the SVG draw from.
export function spritePixels(role: Role, prefs: MascotPrefs, look: Look = {}): SpritePixel[] {
	const style = styleFor(role, prefs)
	const accessory = accessoryFor(role, prefs)
	// A colour set for the role with set_mascot is the person's choice, so it wins over the agent's own.
	const body = style.body ?? look.body ?? PALETTE.body
	const tone = look.pose === 'stopped' ? greyOf : (colour: string) => colour
	const pixels: SpritePixel[] = []
	spriteGrid(role, prefs, speciesOf(look), look).forEach((row, y) => {
		;[...row].forEach((ch, x) => {
			const fill = colourOf(ch, accessory, style, body)
			if (!fill) return
			if (ch !== 'E') return pixels.push({ x, y, fill: tone(fill) })
			// Shut eyes are a lid in the body's shade, open ones the eye colour; both keep the body behind them.
			const isShut = look.pose === 'paused'
			pixels.push({ x, y, fill: tone(isShut ? shadeOf(body) : fill), eye: isShut ? 'closed' : 'open', under: tone(body) })
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

export function spriteCells(role: Role, prefs: MascotPrefs, look: Look = {}): SpriteCell[][] {
	const colours: Array<Array<string | undefined>> = Array.from({ length: 8 }, () => Array(8).fill(undefined))
	for (const { x, y, fill } of spritePixels(role, prefs, look)) colours[y][x] = fill
	const rows: SpriteCell[][] = []
	for (let r = 0; r < 4; r++) {
		const top = colours[r * 2]
		const bottom = colours[r * 2 + 1]
		rows.push(top.map((fill, col) => cell(fill, bottom[col])))
	}
	return rows
}
