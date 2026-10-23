import { expect, test } from 'claude-code/testing'

import { PALETTE, spriteCells, spriteGrid, spritePixels } from '../hooks/sprite'
import { bandBarSvg, barSvg, escapeXml, pipHeight, pipSvg } from '../hooks/svg'

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
	expect(pixels).toContainEqual({ x: 2, y: 4, fill: PALETTE.eye, eye: 'open', under: PALETTE.body })
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
	// A row of headroom above the sprite, so a bob never clips a hat.
	expect(svg).toContain('viewBox="0 -1 8 9"')
	expect(svg).toContain('width="32"')
	expect(svg).toContain('height="36"')
	expect(pipHeight(32)).toBe(36)
	expect(svg).toContain('shape-rendering="crispEdges"')
	// One rect per pixel, plus the body under each eye.
	const pixels = spritePixels('researcher', {})
	expect(rects(svg)).toHaveLength(pixels.length + pixels.filter(pixel => pixel.eye).length)
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
	expect(attr(part(at(2000), 'shimmer'), 'x')).not.toBe(attr(first, 'x'))
	expect(at(1000)).toBe(at(1000))
})

test('the shimmer only steps right, one tick at a time, then wraps, on narrow and wide bars', async () => {
	for (const width of [120, 320]) {
		const x = (now: number) =>
			Number(attr(part(barSvg({ fraction: 0, width, height: 6, color: '#7F77DD', now, isShimmer: true }), 'shimmer'), 'x'))
		const sweep = [0, 1, 2, 3, 4, 5].map(second => x(10_000 * 6 + second * 1000))
		for (let i = 1; i < sweep.length; i++) expect(sweep[i]).toBeGreaterThan(sweep[i - 1])
		// The next second wraps to the start; a tick anywhere inside a second draws the same place.
		expect(x(66_000)).toBe(sweep[0])
		expect(x(60_999)).toBe(sweep[0])
		expect(sweep[5]).toBe(width)
	}
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
	expect(attr(part(svg, 'pill'), 'fill')).toBe('#534AB7')
	expect(svg).toContain('>A &amp; &lt;B&gt;</text>')
	expect(svg).toContain('font-family="system-ui, sans-serif"')
	expect(svg).toContain('fill="#EEEDFE"')
	expect(svg).not.toContain('<B>')
})

test('the band pill sits away from the fill edge so the progress stays visible', async () => {
	for (const fraction of [0.3, 0.7]) {
		const svg = bandBarSvg({
			fraction,
			width: 200,
			height: 18,
			color: '#7F77DD',
			pill: 'Tasks 2/9',
			pillBg: '#534AB7',
			pillFg: '#EEEDFE'
		})
		const pill = part(svg, 'pill')
		const x = Number(attr(pill, 'x'))
		const width = Number(attr(pill, 'width'))
		const edge = Number(attr(part(svg, 'fill'), 'width'))
		expect(edge).toBe(fraction * 200)
		expect(edge >= x && edge <= x + width).toBe(false)
		// Inset 2px from the end it sits at, and the text stays inside it.
		expect(fraction < 0.5 ? 200 - (x + width) : x).toBe(2)
		const textX = Number(/<text x="([^"]*)"/.exec(svg)?.[1])
		expect(textX).toBeGreaterThan(x)
		expect(textX).toBeLessThan(x + width)
	}
})

test('pipSvg gives the same drawing again and follows a prefs change', async () => {
	const first = pipSvg('designer', {}, 32)
	expect(pipSvg('designer', {}, 32)).toBe(first)
	const hardhat = pipSvg('designer', { designer: { accessory: 'hardhat' } }, 32)
	expect(hardhat).not.toBe(first)
	expect(pipSvg('designer', { designer: { accessory: 'hardhat' } }, 32)).toBe(hardhat)
	expect(pipSvg('designer', {}, 16)).not.toBe(first)
	expect(pipSvg('designer', {}, 32)).toBe(first)
})

test('only a running Pip moves: it bobs and blinks', async () => {
	const look = { species: 'wisp' as const, body: '#D85A30' }
	const running = pipSvg('plain', {}, 32, { ...look, pose: 'running' })
	expect(isWellFormed(running)).toBe(true)
	expect(running).toContain('<animateTransform')
	expect(running).toContain('attributeName="opacity"')
	expect(running).toContain('repeatCount="indefinite"')
	for (const pose of ['still', 'paused', 'stopped'] as const) {
		expect(pipSvg('plain', {}, 32, { ...look, pose })).not.toContain('<animate')
	}
	expect(pipSvg('plain', {}, 32, { ...look, pose: 'stopped' })).toContain('opacity="0.45"')
	// Each look is drawn once and its markup held: the same look gives the same string.
	expect(pipSvg('plain', {}, 32, { ...look, pose: 'running' })).toBe(running)
	expect(pipSvg('plain', {}, 32, { ...look, species: 'bolt', pose: 'running' })).not.toBe(running)
})

test('a paused Pip draws each shut eye as a lid line over the body', async () => {
	const svg = pipSvg('plain', {}, 32, { pose: 'paused', body: '#1D9E75' })
	expect(svg).not.toContain(`fill="${PALETTE.eye}"`)
	expect(rects(svg).filter(rect => rect.includes('height="0.35"'))).toHaveLength(2)
})

test('a running Pip hops a whole pixel and squashes on landing, inside its headroom', async () => {
	const running = pipSvg('plain', {}, 32, { species: 'bolt', body: '#1D9E75', pose: 'running' })
	const hop = /<animateTransform attributeName="transform" type="translate" values="([^"]*)"/.exec(running)?.[1] ?? ''
	const rises = hop.split(';').map(pair => 0 - Number(pair.trim().split(/\s+/)[1]))
	// A whole sprite pixel at the top of the hop (4px at 32px), and never past the one row of headroom.
	expect(Math.max(...rises)).toBe(1)
	expect(Math.min(...rises)).toBe(0)
	// The squash scales about the feet, so they stay planted while the body flattens and stretches.
	expect(running).toContain('<g transform="translate(4 8)">')
	expect(running).toMatch(/<animateTransform attributeName="transform" type="scale" values="[^"]*"/)
	expect(running).toContain('<g transform="translate(-4 -8)">')
	// Hop and squash share one beat, so the landing and the squash always meet.
	const durations = [...running.matchAll(/type="(?:translate|scale)"[^>]*dur="([^"]*)"/g)].map(match => match[1])
	expect(durations).toHaveLength(2)
	expect(new Set(durations).size).toBe(1)
})
