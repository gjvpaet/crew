import { expect, test } from 'claude-code/testing'

import { ACCENTS, PALETTE, spriteCells, spriteGrid } from '../hooks/sprite'

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
