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

export type BarSvgInput = { fraction: number; width: number; height: number; color: string; now?: number; isShimmer?: boolean }

const SHIMMER_SHARE = 0.3
// The surface redraws once a second, so the sweep steps: six places, each a fifth of the travel further right.
const SHIMMER_STEPS = 6

// The track and the fill, shared by the agent bar and the band bar.
function trackAndFill(fraction: number, width: number, height: number, color: string) {
	return rect('track', 0, width, 0, height, TRACK) + rect('fill', 0, clamp(fraction, 0, 1) * width, 0, height, color)
}

export function barSvg({ fraction, width, height, color, now = 0, isShimmer = false }: BarSvgInput): string {
	let shimmer = ''
	if (isShimmer) {
		// A segment stepping left to right, from just off the track's start to just past its end; its place is a
		// function of the whole second of `now`, so a narrow bar never seems to run backwards between redraws.
		const segment = width * SHIMMER_SHARE
		const travel = width + segment
		const step = Math.floor(now / 1000) % SHIMMER_STEPS
		const x = (step / (SHIMMER_STEPS - 1)) * travel - segment
		shimmer =
			`<clipPath id="track"><rect x="0" y="0" width="${num(width)}" height="${num(height)}" rx="${num(height / 2)}"/></clipPath>` +
			rect('shimmer', x, segment, 0, height, color, ' fill-opacity="0.55" clip-path="url(#track)"')
	}
	return `${svgOpen(width, height)}${trackAndFill(fraction, width, height, color)}${shimmer}</svg>`
}

export type BandBarSvgInput = {
	fraction: number
	width: number
	height: number
	color: string
	pill: string
	pillBg: string
	pillFg: string
}

const PILL_INSET = 2

export function bandBarSvg({ fraction, width, height, color, pill, pillBg, pillFg }: BandBarSvgInput): string {
	const fontSize = Math.max(8, Math.round(height * 0.58))
	const pillHeight = height - 4
	// No text metrics in a static image: estimate the width from an average glyph of a system sans.
	const pillWidth = Math.min(width - 2 * PILL_INSET, pill.length * fontSize * 0.6 + pillHeight)
	// The pill sits at the end away from the fill's edge, so it never hides how far the bar has come.
	const x = clamp(fraction, 0, 1) < 0.5 ? width - PILL_INSET - pillWidth : PILL_INSET
	const text =
		`<text x="${num(x + pillWidth / 2)}" y="${num(height / 2)}" text-anchor="middle" dominant-baseline="central" ` +
		`font-family="system-ui, sans-serif" font-size="${fontSize}" font-weight="600" fill="${pillFg}">${escapeXml(pill)}</text>`
	return `${svgOpen(width, height)}${trackAndFill(fraction, width, height, color)}${rect('pill', x, pillWidth, 2, pillHeight, pillBg)}${text}</svg>`
}
