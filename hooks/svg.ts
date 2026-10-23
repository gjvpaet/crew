import type { MascotPrefs, Role } from '../types'
import { clamp } from './format'
import { spritePixels, type Look } from './sprite'

const XMLNS = 'http://www.w3.org/2000/svg'

// A neutral grey at low alpha reads as a track on both light and dark backgrounds.
const TRACK = 'rgba(128,128,128,0.25)'

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }

export const escapeXml = (text: string) => text.replace(/[&<>"']/g, ch => XML_ESCAPES[ch])

// Two decimals at most, no trailing zeros: stable markup for a given input.
const num = (value: number) => String(Math.round(value * 100) / 100)

const svgOpen = (width: number, height: number, extra = '') =>
	`<svg xmlns="${XMLNS}" viewBox="0 0 ${num(width)} ${num(height)}" width="${num(width)}" height="${num(height)}"${extra}>`

function rect(name: string, x: number, width: number, y: number, height: number, fill: string, extra = '') {
	return `<rect class="${name}" x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" rx="${num(height / 2)}" fill="${fill}"${extra}/>`
}

// The 8×8 sprite with a pixel of room either side and two rows above it, 10 wide by 11 tall: a hop never clips a
// hat, and a sleeper's z's rise clear of its head. `size` is the sprite's own width, so it is drawn as large as ever.
const VIEW = { x: -1, y: -2, width: 10, height: 11 }
export const pipWidth = (size: number) => Math.round((size * VIEW.width) / 8)
export const pipHeight = (size: number) => Math.round((size * VIEW.height) / 8)

// The panel redraws every second; a Pip only changes with its role, its prefs, its size or its look. Keeping the
// markup identical between redraws also keeps a running Pip's animation where it is.
const PIP_CACHE = new Map<string, string>()
const PIP_CACHE_LIMIT = 128

export function pipSvg(role: Role, prefs: MascotPrefs, size: number, look: Look = {}): string {
	// `frame` is the terminal's beat; the SVG animates itself, so it is left out of the drawing and the key.
	const { frame: _frame, ...drawn } = look
	const key = `${role}|${size}|${JSON.stringify(prefs[role] ?? {})}|${JSON.stringify(drawn)}`
	const cached = PIP_CACHE.get(key)
	if (cached !== undefined) return cached
	if (PIP_CACHE.size >= PIP_CACHE_LIMIT) PIP_CACHE.clear()
	const svg = drawPip(role, prefs, size, drawn)
	PIP_CACHE.set(key, svg)
	return svg
}

const pixelRect = (x: number, y: number, fill: string) => `<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}"/>`

// Running: a hop, one beat on repeat. It rises a whole sprite pixel (the one row of headroom), eases down and rests a
// moment; it stretches a touch on take-off and squashes on landing, about the feet so they stay planted. The eyes
// blink once every few seconds. SMIL, so it plays in the sandboxed frame an interactive Svg is drawn in, with no script.
const BEAT = '0.7s'
const HOP =
	`<animateTransform attributeName="transform" type="translate" values="0 0;0 -1;0 0;0 0" keyTimes="0;0.35;0.7;1" ` +
	`calcMode="spline" keySplines="0.2 0.6 0.4 1;0.6 0 0.8 0.4;0 0 1 1" dur="${BEAT}" repeatCount="indefinite"/>`
const SQUASH =
	`<animateTransform attributeName="transform" type="scale" values="1 1;0.96 1.04;1 1;1 1;1.08 0.86;1 1" ` +
	`keyTimes="0;0.1;0.3;0.7;0.8;1" dur="${BEAT}" repeatCount="indefinite"/>`
const BLINK = '<animate attributeName="opacity" values="1;1;0;1" keyTimes="0;0.92;0.96;1" dur="3s" repeatCount="indefinite"/>'

// Paused: asleep. Three pixel z's, each a size larger, rise from the top of the head up and to the right in turn,
// fading in and out, a third of a cycle apart. A mid blue-grey that reads on light and dark backgrounds alike.
const Z_GLYPH = ['####', '..#.', '.#..', '####']
const Z_FILL = '#7D8AAD'
const Z_CYCLE = 2.4
const Z_SIZES = [0.26, 0.34, 0.42]
const Z_FROM = { x: 6.2, y: 1 }
const Z_FLOAT = '1 -3'

function sleepSvg(): string {
	return Z_SIZES.map((size, index) => {
		const begin = `${num((index * Z_CYCLE) / Z_SIZES.length)}s`
		const repeat = `dur="${Z_CYCLE}s" begin="${begin}" repeatCount="indefinite"`
		const pixels = Z_GLYPH.flatMap((row, y) =>
			[...row].map((ch, x) =>
				ch === '#'
					? `<rect x="${num(Z_FROM.x + x * size)}" y="${num(Z_FROM.y + y * size)}" width="${size}" height="${size}" fill="${Z_FILL}"/>`
					: ''
			)
		).join('')
		return (
			`<g class="z" opacity="0">` +
			`<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.2;0.7;1" ${repeat}/>` +
			`<animateTransform attributeName="transform" type="translate" values="0 0;${Z_FLOAT}" ${repeat}/>` +
			`${pixels}</g>`
		)
	}).join('')
}

function drawPip(role: Role, prefs: MascotPrefs, size: number, look: Look): string {
	let body = ''
	let eyes = ''
	for (const { x, y, fill, eye, under } of spritePixels(role, prefs, look)) {
		if (!eye) {
			body += pixelRect(x, y, fill)
			continue
		}
		body += pixelRect(x, y, under ?? fill)
		// A shut eye is a lid line across the body; an open one a whole pixel of eye colour.
		eyes +=
			eye === 'closed'
				? `<rect x="${x}" y="${num(y + 0.45)}" width="1" height="0.35" fill="${fill}"/>`
				: pixelRect(x, y, fill)
	}
	const isRunning = look.pose === 'running'
	const drawn = `${body}<g>${isRunning ? BLINK : ''}${eyes}</g>`
	// The squash pivots on the feet: move them to the origin, scale, and move them back.
	const sprite = isRunning
		? `<g>${HOP}<g transform="translate(4 8)"><g>${SQUASH}<g transform="translate(-4 -8)">${drawn}</g></g></g></g>`
		: `<g>${drawn}</g>`
	const faded =
		look.pose === 'stopped' ? `<g opacity="0.45">${sprite}</g>` : look.pose === 'paused' ? sprite + sleepSvg() : sprite
	return `<svg xmlns="${XMLNS}" viewBox="${VIEW.x} ${VIEW.y} ${VIEW.width} ${VIEW.height}" width="${num(pipWidth(size))}" height="${num(pipHeight(size))}" shape-rendering="crispEdges">${faded}</svg>`
}

export type BarSvgInput = { fraction: number; height: number; color: string; now?: number; isShimmer?: boolean }

const SHIMMER_SHARE = 0.3
// The surface redraws once a second, so the sweep steps: six places, each a fifth of the travel further right.
const SHIMMER_STEPS = 6

// The band bar's track and fill, in pixels.
// An agent's bar has no width of its own: drawn this wide and stretched (preserveAspectRatio none) to the column the
// surface gives it, its lengths in percent. Stretching squeezes the round ends sideways, so a rule per 20px of drawn
// width sets the horizontal radius back to what reads as height / 2 at that width.
export const BAR_NATIVE_WIDTH = 2000
const END_RULE_STEP = 20
const END_RULE_FROM = 60
// For a surface that ignores the rules: ends sized for a 300px column, the usual pane.
const END_FALLBACK_PX = 300

const endRadius = (height: number, drawnPx: number) => num(((height / 2) * BAR_NATIVE_WIDTH) / drawnPx)

const END_RULES = new Map<number, string>()

// Widest first, so at a given width the narrowest rule that still matches comes last and wins.
function endRules(height: number): string {
	const cached = END_RULES.get(height)
	if (cached !== undefined) return cached
	let rules = ''
	for (let px = BAR_NATIVE_WIDTH; px >= END_RULE_FROM; px -= END_RULE_STEP) {
		rules += `@media (max-width: ${px}px) { .end { rx: ${endRadius(height, px)}px; } }`
	}
	END_RULES.set(height, rules)
	return rules
}

function stretchRect(name: string, xPct: number, widthPct: number, height: number, fill: string, extra = '') {
	return (
		`<rect class="${name} end" x="${num(xPct)}%" y="0" width="${num(widthPct)}%" height="${num(height)}" ` +
		`rx="${endRadius(height, END_FALLBACK_PX)}" ry="${num(height / 2)}" fill="${fill}"${extra}/>`
	)
}

export function barSvg({ fraction, height, color, now = 0, isShimmer = false }: BarSvgInput): string {
	let shimmer = ''
	if (isShimmer) {
		// A segment stepping left to right, from just off the track's start to just past its end; its place is a
		// function of the whole second of `now`, so it never seems to run backwards between redraws.
		const segment = 100 * SHIMMER_SHARE
		const travel = 100 + segment
		const step = Math.floor(now / 1000) % SHIMMER_STEPS
		const x = (step / (SHIMMER_STEPS - 1)) * travel - segment
		shimmer =
			`<clipPath id="track">${stretchRect('clip', 0, 100, height, '#000')}</clipPath>` +
			stretchRect('shimmer', x, segment, height, color, ' fill-opacity="0.55" clip-path="url(#track)"')
	}
	const open =
		`<svg xmlns="${XMLNS}" viewBox="0 0 ${BAR_NATIVE_WIDTH} ${num(height)}" width="${BAR_NATIVE_WIDTH}" ` +
		`height="${num(height)}" preserveAspectRatio="none">`
	const body = stretchRect('track', 0, 100, height, TRACK) + stretchRect('fill', 0, clamp(fraction, 0, 1) * 100, height, color)
	return `${open}<style>${endRules(height)}</style>${body}${shimmer}</svg>`
}

export type BandBarSvgInput = {
	fraction: number
	width: number
	height: number
	color: string
	pill: string
	pillBg: string
	pillFg: string
	// How many steps the bar counts: a tick marks each boundary still ahead of the fill.
	total: number
	// Work is under way: a scanner sweeps the rest of the bar, from the fill's edge to the end.
	isSweeping?: boolean
	// The fraction before the latest change: the pill slides over from there, and the fill grows with it.
	from?: number
}

const PILL_INSET = 2
// A pixel every 3px, drawn 2.2px wide so the gaps between them read as a grid.
const CELL = 3
const DOT = 2.2
const FILL_DENSITY = 0.78
const FILL_OPACITIES = [0.55, 0.78, 1]
const DUST = { density: 0.06, opacity: 0.18 }
// Seconds: the beam crosses whatever is left of the bar in `travel`, rests, and starts again; each column fades
// over `trail` once the beam has passed it.
const BEAM = { density: 0.55, opacity: 0.85, travel: 1.8, rest: 0.6, rise: 0.04, trail: 0.35 }
const TICK = { minGap: 8, inset: 4, fill: '#888780', opacity: 0.6 }
const SLIDE = 'dur="0.7s" keyTimes="0;1" calcMode="spline" keySplines="0.2 0.8 0.3 1" fill="freeze"'

// The same cell always draws the same way, so the dither holds still between redraws.
function cellHash(column: number, row: number, salt: number) {
	let h = (column * 374761393 + row * 668265263 + salt * 982451653) >>> 0
	h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

type Cell = { column: number; row: number; x: number; y: number }

function gridCells(width: number, height: number): Cell[] {
	const columns = Math.floor(width / CELL)
	const rows = Math.floor(height / CELL)
	const left = (width - columns * CELL) / 2 + (CELL - DOT) / 2
	const top = (height - rows * CELL) / 2 + (CELL - DOT) / 2
	const cells: Cell[] = []
	for (let column = 0; column < columns; column++)
		for (let row = 0; row < rows; row++) cells.push({ column, row, x: left + column * CELL, y: top + row * CELL })
	return cells
}

const cellPath = (cells: readonly Cell[]) => cells.map(({ x, y }) => `M${num(x)} ${num(y)}h${DOT}v${DOT}h-${DOT}z`).join('')
const centre = (cell: Cell) => cell.x + DOT / 2

function pillLeft(fraction: number, width: number, pillWidth: number) {
	return num(clamp(clamp(fraction, 0, 1) * width - pillWidth, PILL_INSET, width - PILL_INSET - pillWidth))
}

export function bandBarSvg(input: BandBarSvgInput): string {
	const { width, height, color, pill, pillBg, pillFg, total, isSweeping = false, from } = input
	const head = clamp(input.fraction, 0, 1) * width
	const cells = gridCells(width, height)
	const filled = cells.filter(cell => centre(cell) < head && cellHash(cell.column, cell.row, 1) < FILL_DENSITY)
	const ahead = cells.filter(cell => centre(cell) >= head)

	// The fill: a dither at three strengths. On a rise it is uncovered left to right in step with the pill.
	const done = FILL_OPACITIES.map((opacity, level) => {
		const mine = filled.filter(cell => Math.floor(cellHash(cell.column, cell.row, 2) * FILL_OPACITIES.length) === level)
		return mine.length ? `<path class="done" d="${cellPath(mine)}" fill="${color}" fill-opacity="${opacity}"/>` : ''
	}).join('')
	const isRising = from !== undefined && clamp(from, 0, 1) * width < head
	const reveal = isRising
		? `<clipPath id="filled"><rect x="0" y="0" width="${num(head)}" height="${num(height)}">` +
			`<animate attributeName="width" values="${num(clamp(from, 0, 1) * width)};${num(head)}" ${SLIDE}/></rect></clipPath>`
		: ''
	const fill = done && isRising ? `<g clip-path="url(#filled)">${done}</g>` : done

	const dustCells = ahead.filter(cell => cellHash(cell.column, cell.row, 3) < DUST.density)
	const dust = dustCells.length
		? `<path class="dust" d="${cellPath(dustCells)}" fill="${color}" fill-opacity="${DUST.opacity}"/>`
		: ''

	// The scanner: one path per column past the fill, lit as the beam reaches it and faded behind it, every column
	// on the same cycle, so the markup (and the sweep) carry on unchanged from one redraw to the next.
	let sweep = ''
	if (isSweeping && ahead.length) {
		const cycle = BEAM.travel + BEAM.rest
		const span = Math.max(1, width - head)
		const columns = [...new Set(ahead.map(cell => cell.column))]
		sweep = columns
			.map(column => {
				const lit = ahead.filter(cell => cell.column === column && cellHash(column, cell.row, 4) < BEAM.density)
				const [first] = lit
				if (!first) return ''
				const at = ((centre(first) - head) / span) * BEAM.travel
				const times = [0, at, at + BEAM.rise, at + BEAM.trail, cycle].map(time => num(time / cycle)).join(';')
				return (
					`<path class="beam" d="${cellPath(lit)}" fill="${color}" fill-opacity="${BEAM.opacity}" opacity="0">` +
					`<animate attributeName="opacity" values="0;0;1;0;0" keyTimes="${times}" dur="${num(cycle)}s" ` +
					`repeatCount="indefinite"/></path>`
				)
			})
			.join('')
	}

	const gap = total > 0 ? width / total : 0
	const ticks =
		gap >= TICK.minGap
			? Array.from({ length: total - 1 }, (_, index) => (index + 1) * gap)
					.filter(x => x > head + 0.5)
					.map(
						x =>
							`<rect class="tick" x="${num(x)}" y="${TICK.inset}" width="1" height="${num(height - 2 * TICK.inset)}" ` +
							`fill="${TICK.fill}" fill-opacity="${TICK.opacity}"/>`
					)
					.join('')
			: ''

	// The pill rides the fill's edge, its right end on it, kept inside the bar at either end.
	const fontSize = Math.max(8, Math.round(height * 0.58))
	const pillHeight = height - 4
	// No text metrics in a static image: estimate the width from an average glyph of a system sans.
	const pillWidth = Math.min(width - 2 * PILL_INSET, pill.length * fontSize * 0.6 + pillHeight)
	const x = pillLeft(input.fraction, width, pillWidth)
	const was = from === undefined ? x : pillLeft(from, width, pillWidth)
	const slide =
		was === x ? '' : `<animateTransform attributeName="transform" type="translate" values="${was} 0;${x} 0" ${SLIDE}/>`
	const text =
		`<text x="${num(pillWidth / 2)}" y="${num(height / 2)}" text-anchor="middle" dominant-baseline="central" ` +
		`font-family="system-ui, sans-serif" font-size="${fontSize}" font-weight="600" fill="${pillFg}">${escapeXml(pill)}</text>`
	const pillGroup =
		`<g class="pill-at" transform="translate(${x} 0)">${slide}${rect('pill', 0, pillWidth, 2, pillHeight, pillBg)}${text}</g>`

	const track = rect('track', 0, width, 0, height, TRACK)
	const clip = `<clipPath id="track">${rect('clip', 0, width, 0, height, '#000')}</clipPath>${reveal}`
	return `${svgOpen(width, height)}<defs>${clip}</defs>${track}<g clip-path="url(#track)">${fill}${dust}${sweep}</g>${ticks}${pillGroup}</svg>`
}
