import { expect, test } from 'claude-code/testing'

import { ACCENTS, PALETTE, SPECIES_ORDER, spriteCells, spriteGrid, spritePixels } from '../hooks/sprite'

test('the sprite is 4 text rows of 8 cells', async () => {
	const cells = spriteCells('plain', {})
	expect(cells).toHaveLength(4)
	expect(cells.every(row => row.length === 8)).toBe(true)
})

test('half blocks pack two pixel rows', async () => {
	const cells = spriteCells('plain', {})
	expect(cells[0][0]).toEqual({ ch: ' ' })
	expect(cells[2][2]).toEqual({ ch: '▀', fg: PALETTE.eye, bg: PALETTE.body })
	expect(cells[3][1]).toEqual({ ch: '▄', fg: PALETTE.shade })
})

test('each role wears its accessory', async () => {
	expect(spriteCells('developer', {})[1][0]).toEqual({ ch: '▄', fg: ACCENTS.headset.dark })
	expect(spriteGrid('researcher', {})[4]).toBe('.AEAAEA.')
	expect(spriteGrid('reviewer', {})[2]).toBe('aAAAAAAa')
})

test('prefs override accessory and colours', async () => {
	expect(spriteCells('developer', { developer: { accessory: 'none' } })[1][0]).toEqual({ ch: ' ' })
	const recoloured = spriteCells('plain', { plain: { body: '#112233' } })
	expect(recoloured[2][2]).toEqual({ ch: '▀', fg: PALETTE.eye, bg: '#112233' })
	expect(spriteCells('reviewer', { reviewer: { accent: '#00FF00' } })[1][1].fg).toBe('#00FF00')
})

test('an unknown accessory draws as none', async () => {
	const prefs = { designer: { accessory: 'tophat' as any } }
	expect(spriteGrid('designer', prefs)).toEqual(spriteGrid('plain', {}))
	expect(spriteCells('designer', prefs)).toEqual(spriteCells('plain', {}))
})

const isGrey = (hex: string) => hex.slice(1, 3) === hex.slice(3, 5) && hex.slice(3, 5) === hex.slice(5, 7)

test('six species, each its own 8x8 shape, Pip last', async () => {
	expect(SPECIES_ORDER).toHaveLength(6)
	expect(SPECIES_ORDER[SPECIES_ORDER.length - 1]).toBe('pip')
	const grids = SPECIES_ORDER.map(species => spriteGrid('plain', {}, species))
	for (const grid of grids) {
		expect(grid).toHaveLength(8)
		expect(grid.every(row => row.length === 8)).toBe(true)
		// Eyes on row 4 for every species, where the glasses go.
		expect([...grid[4]].filter(ch => ch === 'E')).toHaveLength(2)
	}
	expect(new Set(grids.map(grid => grid.join('/'))).size).toBe(6)
	expect(spriteGrid('plain', {})).toEqual(spriteGrid('plain', {}, 'pip'))
	// A species this build has never heard of draws as Pip.
	expect(spriteGrid('plain', {}, 'dragon' as never)).toEqual(spriteGrid('plain', {}, 'pip'))
})

test('the role hat goes on every species', async () => {
	for (const species of SPECIES_ORDER) {
		expect(spriteGrid('reviewer', {}, species)[2]).toBe('aAAAAAAa')
		expect(spriteGrid('researcher', {}, species)[4]).toContain('AEAAEA')
	}
})

test('the look paints the body, its shade a darker tone of it; a role pref still wins', async () => {
	const pixels = spritePixels('plain', {}, { species: 'bolt', body: '#1D9E75' })
	expect(pixels).toContainEqual({ x: 1, y: 3, fill: '#1D9E75' })
	const feet = pixels.find(pixel => pixel.x === 2 && pixel.y === 7)
	expect(feet?.fill).toMatch(/^#[0-9A-F]{6}$/)
	expect(feet?.fill).not.toBe('#1D9E75')
	const pref = spritePixels('plain', { plain: { body: '#112233' } }, { species: 'bolt', body: '#1D9E75' })
	expect(pref).toContainEqual({ x: 1, y: 3, fill: '#112233' })
})

test('eyes are marked open, with the body colour under them', async () => {
	const eyes = spritePixels('plain', {}, { body: '#1D9E75' }).filter(pixel => pixel.eye)
	expect(eyes).toHaveLength(2)
	expect(eyes.every(eye => eye.eye === 'open' && eye.fill === PALETTE.eye && eye.under === '#1D9E75')).toBe(true)
})

test('a paused mascot has its eyes shut', async () => {
	const pixels = spritePixels('plain', {}, { pose: 'paused' })
	const eyes = pixels.filter(pixel => pixel.eye)
	expect(eyes).toHaveLength(2)
	expect(eyes.every(eye => eye.eye === 'closed' && eye.fill !== PALETTE.eye)).toBe(true)
	expect(pixels.some(pixel => pixel.fill === PALETTE.eye)).toBe(false)
})

test('a stopped mascot is drawn in greys only', async () => {
	const pixels = spritePixels('designer', {}, { species: 'mochi', body: '#D85A30', pose: 'stopped' })
	expect(pixels.length).toBeGreaterThan(0)
	expect(pixels.every(pixel => isGrey(pixel.fill) && (!pixel.under || isGrey(pixel.under)))).toBe(true)
})

test('on the terminal a running mascot glances on odd frames; any other pose holds still', async () => {
	const eyesAt = (pose: 'running' | 'still', frame: number) =>
		spritePixels('plain', {}, { pose, frame })
			.filter(pixel => pixel.eye)
			.map(pixel => pixel.x)
	expect(eyesAt('running', 0)).toEqual([2, 5])
	expect(eyesAt('running', 1)).toEqual([3, 6])
	expect(eyesAt('still', 1)).toEqual([2, 5])
	expect(spriteCells('plain', {}, { pose: 'running', frame: 1 })).not.toEqual(spriteCells('plain', {}, { pose: 'running', frame: 0 }))
	// Glasses keep their frame: the eyes look right inside them.
	expect(spriteGrid('researcher', {}, 'pip', { pose: 'running', frame: 1 })[4]).toBe('.AAEAAE.')
})
