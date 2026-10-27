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

// Finished: a chequered goal flag, held in the free column to the right of the sprite. The pole rises from the hand
// into the headroom above, where the cloth flies back over the head; light and dark squares read on either
// background. Still, like the rest of a finished mascot.
const FLAG = { pole: '#9A9AA0', light: '#F4F4F2', dark: '#2C2C2A' }
const POLE = { x: 8.2, width: 0.5, top: -2, bottom: 7.5 }
const CLOTH = { columns: 4, rows: 3, cell: 0.66 }
const HAND_Y = 5

function flagSvg(hand: string, reach: number): string {
	const right = POLE.x
	const left = right - CLOTH.columns * CLOTH.cell
	const squares = Array.from({ length: CLOTH.rows }, (_, row) =>
		Array.from({ length: CLOTH.columns }, (_, column) => {
			const fill = (row + column) % 2 === 0 ? FLAG.dark : FLAG.light
			const x = num(left + column * CLOTH.cell)
			const y = num(POLE.top + row * CLOTH.cell)
			return `<rect x="${x}" y="${y}" width="${CLOTH.cell}" height="${CLOTH.cell}" fill="${fill}"/>`
		}).join('')
	).join('')
	const pole = `<rect x="${POLE.x}" y="${POLE.top}" width="${POLE.width}" height="${num(POLE.bottom - POLE.top)}" fill="${FLAG.pole}"/>`
	// The hand closes round the pole, a pixel of the body's colour across it, with an arm back to the body's edge.
	const gripX = POLE.x - 0.25
	const grip = `<rect x="${num(gripX)}" y="${HAND_Y}" width="1" height="1" fill="${hand}"/>`
	const arm =
		reach < gripX ? `<rect x="${reach}" y="${num(HAND_Y + 0.25)}" width="${num(gripX - reach)}" height="0.5" fill="${hand}"/>` : ''
	return `<g class="flag">${pole}${squares}${arm}${grip}</g>`
}

// Where the body ends on the hand's row: the arm reaches out from there.
const bodyEdge = (pixels: readonly { x: number; y: number }[]) =>
	Math.max(0, ...pixels.filter(pixel => pixel.y === HAND_Y).map(pixel => pixel.x + 1))

// The colour most of the body is drawn in: the flag's hand matches it.
function bodyColour(pixels: readonly { fill: string; eye?: string }[]): string {
	const counts = new Map<string, number>()
	for (const { fill, eye } of pixels) if (!eye) counts.set(fill, (counts.get(fill) ?? 0) + 1)
	return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? FLAG.pole
}

function drawPip(role: Role, prefs: MascotPrefs, size: number, look: Look): string {
	let body = ''
	let eyes = ''
	const pixels = spritePixels(role, prefs, look)
	for (const { x, y, fill, eye, under } of pixels) {
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
		look.pose === 'stopped'
			? `<g opacity="0.45">${sprite}</g>`
			: look.pose === 'paused'
				? sprite + sleepSvg()
				: look.pose === 'still'
					? sprite + flagSvg(bodyColour(pixels), bodyEdge(pixels))
					: sprite
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

// The band's bar has no width of its own: it fills whatever room the band leaves it. Scaling a drawing to that room
// would squash its pixels, so it is never scaled. The viewBox is a square the height of the bar, met at the left, so
// one unit is one CSS pixel at any width, and the layout is CSS against `100vw`, the width the bar is drawn at (as
// an image or in its frame alike). The pixels are patterns in those same units: square, on one grid, at any width.
export const BAND_NATIVE_WIDTH = 4000
const PILL_INSET = 2
// A pixel every 3px, drawn 2.2px wide so the gaps between them read as a grid; a tile of 32 columns repeats.
const CELL = 3
const DOT = 2.2
const TILE_COLUMNS = 32
const FILL_DENSITY = 0.78
const FILL_OPACITIES = [0.55, 0.78, 1]
const DUST = { density: 0.06, opacity: 0.18 }
// The beam: a window the pixels show through, brightest at its leading edge, crossing what is left of the bar in
// `travel` seconds and resting for `rest`.
const BEAM = { density: 0.55, opacity: 0.85, travel: 1.8, rest: 0.6, bands: [{ width: 8, opacity: 1 }, { width: 9, opacity: 0.55 }, { width: 9, opacity: 0.25 }] }
const TICK = { minGap: 8, inset: 4, fill: '#888780', opacity: 0.6 }
const SLIDE = '0.7s cubic-bezier(0.2, 0.8, 0.3, 1) both'

// The same cell always draws the same way, so the dither holds still between redraws.
function cellHash(column: number, row: number, salt: number) {
	let h = (column * 374761393 + row * 668265263 + salt * 982451653) >>> 0
	h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

// One tile of pixels, those whose hash falls under `density`, grouped by strength.
function pixelPattern(id: string, height: number, color: string, salt: number, density: number, opacities: readonly number[]) {
	const rows = Math.floor(height / CELL)
	const top = (height - rows * CELL) / 2 + (CELL - DOT) / 2
	const left = (CELL - DOT) / 2
	const levels = opacities.map(() => [] as string[])
	for (let column = 0; column < TILE_COLUMNS; column++)
		for (let row = 0; row < rows; row++) {
			if (cellHash(column, row, salt) >= density) continue
			const level = Math.floor(cellHash(column, row, salt + 1) * opacities.length)
			levels[level]?.push(`M${num(left + column * CELL)} ${num(top + row * CELL)}h${DOT}v${DOT}h-${DOT}z`)
		}
	const paths = levels
		.map((cells, level) => (cells.length ? `<path d="${cells.join('')}" fill="${color}" fill-opacity="${opacities[level]}"/>` : ''))
		.join('')
	return `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${TILE_COLUMNS * CELL}" height="${num(height)}">${paths}</pattern>`
}

// A length along the bar: `share` of the width it is drawn at, less `minus` pixels.
const along = (share: number, minus = 0) => `calc(100vw * ${num(share)}${minus ? ` - ${num(minus)}px` : ''})`

export function bandBarSvg(input: BandBarSvgInput): string {
	const { height, color, pill, pillBg, pillFg, total, isSweeping = false, from } = input
	const fraction = clamp(input.fraction, 0, 1)
	const fontSize = Math.max(8, Math.round(height * 0.58))
	const pillHeight = height - 4
	// No text metrics in a static image: estimate the width from an average glyph of a system sans.
	const pillWidth = pill.length * fontSize * 0.6 + pillHeight
	// The pill rides the fill's edge, its right end on it, kept inside the bar at either end.
	const pillAt = (share: number) =>
		`translateX(clamp(${PILL_INSET}px, ${along(share, pillWidth)}, calc(100vw - ${num(pillWidth + PILL_INSET)}px)))`

	const rules = [
		'.w{width:100vw}',
		`.fill{width:${along(fraction)}}`,
		`.ahead{x:${along(fraction)};width:100vw}`,
		`.pill{transform:${pillAt(fraction)}}`
	]
	// A change of progress: the pill slides over from where it was, and a rise uncovers the fill in step with it.
	if (from !== undefined && clamp(from, 0, 1) !== fraction) {
		rules.push(`.pill{animation:slide ${SLIDE}}@keyframes slide{from{transform:${pillAt(clamp(from, 0, 1))}}}`)
		if (clamp(from, 0, 1) < fraction) rules.push(`.fill{animation:grow ${SLIDE}}@keyframes grow{from{width:${along(clamp(from, 0, 1))}}}`)
	}

	// Ticks at the step boundaries still ahead of the fill, hidden once the bar is too narrow to tell steps apart.
	const boundaries = total > 1 ? Array.from({ length: total - 1 }, (_, index) => (index + 1) / total).filter(share => share > fraction) : []
	boundaries.forEach((share, index) => rules.push(`.k${index}{x:${along(share)}}`))
	if (boundaries.length) rules.push(`@media (max-width:${total * TICK.minGap}px){.tick{display:none}}`)
	const ticks = boundaries
		.map(
			(_, index) =>
				`<rect class="tick k${index}" y="${TICK.inset}" width="1" height="${num(height - 2 * TICK.inset)}" ` +
				`fill="${TICK.fill}" fill-opacity="${TICK.opacity}"/>`
		)
		.join('')

	// The scanner: a window over a second, denser pixel pattern, moving from the fill's edge past the end, so the
	// grid's pixels light up as it passes and fade behind it.
	let sweep = ''
	if (isSweeping && fraction < 1) {
		const cycle = BEAM.travel + BEAM.rest
		const reach = BEAM.bands.reduce((sum, band) => sum + band.width, 0)
		const stop = num((BEAM.travel / cycle) * 100)
		rules.push(
			`.beam{animation:sweep ${num(cycle)}s linear infinite}` +
				`@keyframes sweep{0%{transform:translateX(${along(fraction)})}${stop}%,100%{transform:translateX(calc(100vw + ${reach}px))}}`
		)
		let edge = 0
		const bands = BEAM.bands
			.map(band => {
				edge -= band.width
				return `<rect x="${edge}" y="0" width="${band.width}" height="${num(height)}" fill="url(#beam)" opacity="${band.opacity}"/>`
			})
			.join('')
		sweep = `<g clip-path="url(#ahead)"><g class="beam">${bands}</g></g>`
	}

	const radius = num(height / 2)
	const defs =
		`<clipPath id="track"><rect class="w" x="0" y="0" height="${num(height)}" rx="${radius}"/></clipPath>` +
		`<clipPath id="ahead"><rect class="ahead" y="0" height="${num(height)}"/></clipPath>` +
		pixelPattern('done', height, color, 1, FILL_DENSITY, FILL_OPACITIES) +
		pixelPattern('dust', height, color, 3, DUST.density, [DUST.opacity]) +
		(sweep ? pixelPattern('beam', height, color, 5, BEAM.density, [BEAM.opacity]) : '')
	const text =
		`<text x="${num(pillWidth / 2)}" y="${num(height / 2)}" text-anchor="middle" dominant-baseline="central" ` +
		`font-family="system-ui, sans-serif" font-size="${fontSize}" font-weight="600" fill="${pillFg}">${escapeXml(pill)}</text>`
	const pillGroup = `<g class="pill">${rect('pill-body', 0, pillWidth, 2, pillHeight, pillBg)}${text}</g>`
	const open =
		`<svg xmlns="${XMLNS}" width="${BAND_NATIVE_WIDTH}" height="${num(height)}" viewBox="0 0 ${num(height)} ${num(height)}" ` +
		'preserveAspectRatio="xMinYMid meet">'
	return (
		`${open}<style>${rules.join('')}</style><defs>${defs}</defs>` +
		`<rect class="track w" x="0" y="0" height="${num(height)}" rx="${radius}" fill="${TRACK}"/>` +
		`<g clip-path="url(#track)"><rect class="fill" x="0" y="0" height="${num(height)}" fill="url(#done)"/>` +
		`<rect class="ahead" y="0" height="${num(height)}" fill="url(#dust)"/>${sweep}</g>${ticks}${pillGroup}</svg>`
	)
}
