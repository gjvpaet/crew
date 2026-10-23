import { expect, test } from 'claude-code/testing'

import { roleFor } from '../hooks/roles'

const general = (description: string) => roleFor({ type: 'general-purpose', description })

test('the agent type wins over the description', async () => {
	expect(roleFor({ type: 'Explore', description: 'Build the thing' })).toBe('researcher')
	expect(roleFor({ type: 'code-reviewer', description: 'Build stuff' })).toBe('reviewer')
	expect(roleFor({ type: 'Plan', description: 'Fix the bug' })).toBe('designer')
})

test('description keywords pick a role', async () => {
	expect(general('Review the whole kit')).toBe('reviewer')
	expect(general('Design the launch graphics')).toBe('designer')
	expect(general('Research competitor launches')).toBe('researcher')
	expect(general('Summarise the notes')).toBe('researcher')
	expect(general('Build the landing page')).toBe('developer')
})

test('nothing recognisable is plain', async () => {
	expect(general('Do the thing')).toBe('plain')
	expect(roleFor({ type: '', description: '' })).toBe('plain')
})
