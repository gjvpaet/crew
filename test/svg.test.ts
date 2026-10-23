import { expect, test } from 'claude-code/testing'

import { PALETTE, spriteCells, spriteGrid, spritePixels } from '../hooks/sprite'
import { bandBarSvg, barSvg, escapeXml, pipSvg } from '../hooks/svg'

const rects = (svg: string) => svg.match(/<rect\b[^>]*>/g) ?? []
const part = (svg: string, name: string) => rects(svg).find(rect => rect.includes(`class="${name}"`))
const attr = (tag: string | undefined, name: string) => {
	const match = tag ? new RegExp(`\\s${name}="([^"]*)"`).exec(tag) : null
	return match ? match[1] : undefined
}
const isWellFormed = (svg: string) => svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') && svg.endsWith('</svg>')

test('escapeXml escapes the five markup characters', async () => {
	expect(escapeXml(`A & <B> "c" 'd'`)).toBe('A &amp; &lt;B&gt; &quot;c&quot; &apos;d&apos;')
	expect(escapeXml('plain')).toBe('plain')
})

test('spritePixels lists every non-empty pixel with its colour', async () => {
	const grid = spriteGrid('developer', {})
	const filled = grid.join('').replace(/\./g, '').length
	const pixels = spritePixels('developer', {})
	expect(pixels).toHaveLength(filled)
	expect(pixels).toContainEqual({ x: 2, y: 4, fill: PALETTE.eye })
	expect(pixels.every(pixel => /^#[0-9A-Fa-f]{6}$/.test(pixel.fill))).toBe(true)
	// The half-block sprite is drawn from the same pixels.
	const cells = spriteCells('developer', {})
	const top = pixels.find(pixel => pixel.x === 2 && pixel.y === 4)
	const bottom = pixels.find(pixel => pixel.x === 2 && pixel.y === 5)
	expect(cells[2][2]).toEqual({ ch: '▀', fg: top?.fill, bg: bottom?.fill })
})

test('pipSvg draws one crisp rect per pixel', async () => {
	const svg = pipSvg('researcher', {}, 32)
	expect(isWellFormed(svg)).toBe(true)
	expect(svg).toContain('viewBox="0 0 8 8"')
	expect(svg).toContain('width="32"')
	expect(svg).toContain('height="32"')
	expect(svg).toContain('shape-rendering="crispEdges"')
	expect(rects(svg)).toHaveLength(spritePixels('researcher', {}).length)
	expect(rects(svg).every(rect => rect.includes('width="1"') && rect.includes('height="1"'))).toBe(true)
	expect(svg).toContain(`fill="${PALETTE.eye}"`)
})

test('pipSvg follows the mascot prefs', async () => {
	const svg = pipSvg('plain', { plain: { body: '#112233' } }, 16)
	expect(svg).toContain('fill="#112233"')
	expect(svg).not.toContain(`fill="${PALETTE.body}"`)
})

test('barSvg fills in proportion to the fraction, clamped', async () => {
	const half = barSvg({ fraction: 0.5, width: 200, height: 6, color: '#1D9E75' })
	expect(isWellFormed(half)).toBe(true)
	const track = part(half, 'track')
	expect(attr(track, 'width')).toBe('200')
	expect(attr(track, 'rx')).toBe('3')
	expect(attr(track, 'fill')).toBe('rgba(128,128,128,0.25)')
	const fill = part(half, 'fill')
	expect(attr(fill, 'width')).toBe('100')
	expect(attr(fill, 'rx')).toBe('3')
	expect(attr(fill, 'fill')).toBe('#1D9E75')
	expect(attr(part(barSvg({ fraction: 1.7, width: 200, height: 6, color: '#000000' }), 'fill'), 'width')).toBe('200')
	expect(attr(part(barSvg({ fraction: -1, width: 200, height: 6, color: '#000000' }), 'fill'), 'width')).toBe('0')
	expect(part(half, 'shimmer')).toBeUndefined()
})

test('barSvg shimmer moves with the clock and is the same for the same moment', async () => {
	const at = (now: number) => barSvg({ fraction: 0, width: 200, height: 6, color: '#7F77DD', now, isShimmer: true })
	const first = part(at(1000), 'shimmer')
	expect(first).toBeDefined()
	expect(attr(at(1000).match(/<rect\b[^>]*class="shimmer"[^>]*>/)?.[0], 'x')).toBe(attr(first, 'x'))
	expect(attr(part(at(1600), 'shimmer'), 'x')).not.toBe(attr(first, 'x'))
	expect(at(1000)).toBe(at(1000))
})

test('bandBarSvg draws the pill centred inside the bar, its text escaped', async () => {
	const svg = bandBarSvg({
		fraction: 0.25,
		width: 160,
		height: 18,
		color: '#AFA9EC',
		pill: 'A & <B>',
		pillBg: '#534AB7',
		pillFg: '#EEEDFE'
	})
	expect(isWellFormed(svg)).toBe(true)
	expect(attr(part(svg, 'fill'), 'width')).toBe('40')
	const pill = part(svg, 'pill')
	expect(attr(pill, 'fill')).toBe('#534AB7')
	const x = Number(attr(pill, 'x'))
	const width = Number(attr(pill, 'width'))
	expect(Math.abs(x + width / 2 - 80)).toBeLessThan(0.01)
	expect(svg).toContain('>A &amp; &lt;B&gt;</text>')
	expect(svg).toContain('font-family="system-ui, sans-serif"')
	expect(svg).toContain('fill="#EEEDFE"')
	expect(svg).not.toContain('<B>')
})
