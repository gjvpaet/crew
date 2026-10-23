import { expect, test } from 'claude-code/testing'

import { PALETTE, spriteCells, spriteGrid, spritePixels } from '../hooks/sprite'
import { BAR_NATIVE_WIDTH, bandBarSvg, barSvg, escapeXml, pipHeight, pipSvg, pipWidth } from '../hooks/svg'

const rects = (svg: string) => svg.match(/<rect\b[^>]*>/g) ?? []
const part = (svg: string, name: string) =>
	rects(svg).find(rect => rect.includes(`class="${name}"`) || rect.includes(`class="${name} `))
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
	// A pixel of room either side and two rows above the 8x8 sprite: a hop never clips a hat, and a sleeper's z's
	// rise clear of its head. `size` stays the sprite's own width, so the sprite is drawn as large as ever.
	expect(svg).toContain('viewBox="-1 -2 10 11"')
	expect(svg).toContain('width="40"')
	expect(svg).toContain('height="44"')
	expect(pipWidth(32)).toBe(40)
	expect(pipHeight(32)).toBe(44)
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

const pct = (value: string | undefined) => parseFloat(String(value))

test('barSvg stretches to its column: lengths in percent, no fixed width', async () => {
	const half = barSvg({ fraction: 0.5, height: 6, color: '#1D9E75' })
	expect(isWellFormed(half)).toBe(true)
	// Drawn at a nominal width the surface scales down to the column it is given.
	expect(half).toContain(`width="${BAR_NATIVE_WIDTH}" height="6"`)
	const track = part(half, 'track')
	expect(attr(track, 'width')).toBe('100%')
	expect(attr(track, 'fill')).toBe('rgba(128,128,128,0.25)')
	const fill = part(half, 'fill')
	expect(attr(fill, 'width')).toBe('50%')
	expect(attr(fill, 'fill')).toBe('#1D9E75')
	expect(attr(part(barSvg({ fraction: 1.7, height: 6, color: '#000000' }), 'fill'), 'width')).toBe('100%')
	expect(attr(part(barSvg({ fraction: -1, height: 6, color: '#000000' }), 'fill'), 'width')).toBe('0%')
	expect(part(half, 'shimmer')).toBeUndefined()
})

test('a stretched bar keeps round ends at any width it is drawn', async () => {
	const svg = barSvg({ fraction: 0.5, height: 6, color: '#1D9E75' })
	// The ends' radius is height / 2 across, scaled back by how far the drawing is squeezed: one rule per 20px of
	// drawn width, from 60px to the nominal width, so a 300px bar's ends are as round as a 1200px bar's.
	expect(svg).toContain('@media (max-width: 300px)')
	expect(svg).toContain('@media (max-width: 1200px)')
	const rule = (px: number) => new RegExp(`@media \\(max-width: ${px}px\\) \\{ \\.end \\{ rx: ([\\d.]+)px; \\} \\}`).exec(svg)?.[1]
	expect(Number(rule(300))).toBe(20)
	expect(Number(rule(1200))).toBe(5)
	// Vertically nothing is squeezed: the attribute radius is the height's half.
	expect(attr(part(svg, 'track'), 'ry')).toBe('3')
	expect(part(svg, 'track')).toContain('class="track end"')
	expect(part(svg, 'fill')).toContain('class="fill end"')
})

test('barSvg shimmer moves with the clock and is the same for the same moment', async () => {
	const at = (now: number) => barSvg({ fraction: 0, height: 6, color: '#7F77DD', now, isShimmer: true })
	const first = part(at(1000), 'shimmer')
	expect(first).toBeDefined()
	expect(attr(part(at(2000), 'shimmer'), 'x')).not.toBe(attr(first, 'x'))
	expect(at(1000)).toBe(at(1000))
})

test('the shimmer only steps right, one tick at a time, then wraps', async () => {
	const x = (now: number) => pct(attr(part(barSvg({ fraction: 0, height: 6, color: '#7F77DD', now, isShimmer: true }), 'shimmer'), 'x'))
	const sweep = [0, 1, 2, 3, 4, 5].map(second => x(10_000 * 6 + second * 1000))
	for (let i = 1; i < sweep.length; i++) expect(sweep[i]).toBeGreaterThan(sweep[i - 1])
	// The next second wraps to the start; a tick anywhere inside a second draws the same place.
	expect(x(66_000)).toBe(sweep[0])
	expect(x(60_999)).toBe(sweep[0])
	expect(sweep[5]).toBe(100)
	expect(sweep[0]).toBe(-30)
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
	for (const pose of ['still', 'stopped'] as const) {
		expect(pipSvg('plain', {}, 32, { ...look, pose })).not.toContain('<animate')
	}
	// A paused one holds its body still: only its zzz moves.
	const paused = pipSvg('plain', {}, 32, { ...look, pose: 'paused' })
	expect(paused).not.toContain('type="scale"')
	expect(paused).not.toContain('values="0 0;0 -1;0 0;0 0"')
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

test('a paused Pip sleeps: three z\'s rise from its head in turn and fade', async () => {
	const svg = pipSvg('plain', {}, 32, { species: 'mochi', body: '#7F77DD', pose: 'paused' })
	expect(isWellFormed(svg)).toBe(true)
	const zs = svg.match(/<g class="z"[^>]*>[\s\S]*?<\/g>/g) ?? []
	expect(zs).toHaveLength(3)
	for (const z of zs) {
		// Hidden until its turn comes, then it floats up and to the right while it fades in and out.
		expect(z).toContain('opacity="0"')
		expect(z).toMatch(/<animate attributeName="opacity"[^>]*repeatCount="indefinite"/)
		expect(z).toMatch(/<animateTransform attributeName="transform" type="translate"[^>]*repeatCount="indefinite"/)
		// Pixel z's, like the sprite: crisp rects, no font.
		expect(z).toContain('<rect')
		expect(z).not.toContain('<text')
	}
	const begins = zs.map(z => /begin="([^"]*)"/.exec(z)?.[1])
	expect(new Set(begins).size).toBe(3)
	// Each z is a size larger than the one before, as a sleeper's z's are drawn.
	const sizes = zs.map(z => Number(/<rect [^>]*width="([^"]*)"/.exec(z)?.[1]))
	expect(sizes[0]).toBeLessThan(sizes[1])
	expect(sizes[1]).toBeLessThan(sizes[2])
	// Every z stays inside the drawing for its whole rise: its rects, moved by the far end of its float.
	for (const z of zs) {
		const [dx, dy] = (/type="translate" values="0 0;([^"]*)"/.exec(z)?.[1] ?? '0 0').split(' ').map(Number)
		for (const rect of z.match(/<rect [^>]*>/g) ?? []) {
			const at = (name: string) => Number(new RegExp(`\\s${name}="([^"]*)"`).exec(rect)?.[1])
			expect(at('x') + at('width') + Math.max(0, dx)).toBeLessThanOrEqual(9)
			expect(at('y') + Math.min(0, dy)).toBeGreaterThanOrEqual(-2)
		}
	}
	// A real Z, diagonal and all, big enough to read at the panel's size: the largest at least 6px tall at 32px.
	expect(sizes[2] * 4).toBeGreaterThanOrEqual(1.5)
	// Still, finished, stopped and running mascots are not asleep.
	for (const pose of ['still', 'stopped', 'running'] as const) {
		expect(pipSvg('plain', {}, 32, { species: 'mochi', body: '#7F77DD', pose })).not.toContain('class="z"')
	}
})
