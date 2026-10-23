import type { MascotPrefs, Role } from '../types'
import { clamp } from './format'
import { spritePixels } from './sprite'

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

// Clear space above a drawing: the same drawing, nested `pad` pixels down in a box that much taller.
export function padTop(svg: string, width: number, height: number, pad: number): string {
	if (pad <= 0) return svg
	return `${svgOpen(width, height + pad)}${svg.replace('<svg ', `<svg y="${num(pad)}" `)}</svg>`
}

// The panel redraws every second; a Pip only changes with its role, its prefs or its size.
const PIP_CACHE = new Map<string, string>()
const PIP_CACHE_LIMIT = 64

export function pipSvg(role: Role, prefs: MascotPrefs, size: number): string {
	const key = `${role}|${size}|${JSON.stringify(prefs[role] ?? {})}`
	const cached = PIP_CACHE.get(key)
	if (cached !== undefined) return cached
	if (PIP_CACHE.size >= PIP_CACHE_LIMIT) PIP_CACHE.clear()
	const svg = drawPip(role, prefs, size)
	PIP_CACHE.set(key, svg)
	return svg
}

function drawPip(role: Role, prefs: MascotPrefs, size: number): string {
	const pixels = spritePixels(role, prefs)
		.map(({ x, y, fill }) => `<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}"/>`)
		.join('')
	return `<svg xmlns="${XMLNS}" viewBox="0 0 8 8" width="${num(size)}" height="${num(size)}" shape-rendering="crispEdges">${pixels}</svg>`
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
