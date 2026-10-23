import { expect, test } from 'claude-code/testing'

import { applyMascotChange, parseMascotInput } from '../hooks/mascot'

test('a valid change parses', async () => {
	expect(parseMascotInput({ role: 'designer', accessory: 'hardhat', body: '#112233' })).toEqual({
		role: 'designer',
		style: { accessory: 'hardhat', body: '#112233' }
	})
	expect(parseMascotInput({ role: 'plain', reset: true })).toEqual({ role: 'plain', reset: true })
})

test('bad input is refused with a reason', async () => {
	expect(parseMascotInput({ role: 'pilot' })).toEqual({
		error: 'role must be one of developer, designer, researcher, reviewer, plain'
	})
	expect(parseMascotInput({ role: 'plain', accessory: 'cape' })).toEqual({
		error: 'accessory must be one of headset, beret, glasses, hardhat, none'
	})
	expect(parseMascotInput({ role: 'plain', body: 'blue' })).toEqual({ error: 'body must be a hex colour like #7C9CF5' })
	expect(parseMascotInput({ role: 'plain' })).toEqual({ error: 'give accessory, body, accent or reset' })
})

test('changes merge into prefs, reset removes the role', async () => {
	const once = applyMascotChange({}, { role: 'designer', style: { accessory: 'hardhat' } })
	const twice = applyMascotChange(once, { role: 'designer', style: { body: '#112233' } })
	expect(twice).toEqual({ designer: { accessory: 'hardhat', body: '#112233' } })
	expect(applyMascotChange(twice, { role: 'designer', reset: true })).toEqual({})
})
