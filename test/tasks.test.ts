import { expect, test } from 'claude-code/testing'

import { applyTaskCall, taskProgress } from '../hooks/tasks'

const PLAN = 'mcp__ccd_turn__update_plan'
const planItems = {
	items: [
		{ content: 'A', status: 'completed' },
		{ content: 'B', status: 'in_progress' },
		{ content: 'C', status: 'pending' }
	]
}

test('TodoWrite replaces the list', async () => {
	const list = applyTaskCall([], {
		tool: 'TodoWrite',
		input: {
			todos: [
				{ content: 'One', status: 'completed', activeForm: 'Doing one' },
				{ content: 'Two', status: 'in_progress', activeForm: 'Doing two' },
				{ content: 'Three', status: 'pending', activeForm: 'Doing three' }
			]
		}
	})
	expect(list?.map(item => item.id)).toEqual(['0', '1', '2'])
	expect(taskProgress(list ?? [])).toEqual({ done: 1, total: 3, current: 'Two' })
})

test('TaskCreate appends with the id from the result, TaskUpdate changes or deletes', async () => {
	const created = applyTaskCall([], {
		tool: 'TaskCreate',
		input: { subject: 'Write tests', description: 'x' },
		result: { task: { id: '7', subject: 'Write tests' } }
	})
	expect(created).toEqual([{ id: '7', title: 'Write tests', status: 'pending' }])
	const started = applyTaskCall(created ?? [], { tool: 'TaskUpdate', input: { taskId: '7', status: 'in_progress' } })
	expect(started?.[0].status).toBe('in_progress')
	const deleted = applyTaskCall(started ?? [], { tool: 'TaskUpdate', input: { taskId: '7', status: 'deleted' } })
	expect(deleted).toEqual([])
	const unknown = applyTaskCall(started ?? [], { tool: 'TaskUpdate', input: { taskId: '99', status: 'completed' } })
	expect(unknown).toEqual(started)
})

test('the Desktop plan tool sets items, advances, and marks by number', async () => {
	const set = applyTaskCall([], { tool: PLAN, input: planItems })
	expect(set?.map(item => item.id)).toEqual(['1', '2', '3'])
	const advanced = applyTaskCall(set ?? [], { tool: PLAN, input: { advance: true } })
	expect(advanced?.map(item => item.status)).toEqual(['completed', 'completed', 'in_progress'])
	const marked = applyTaskCall(set ?? [], { tool: PLAN, input: { done: [3], start: 1 } })
	expect(marked?.map(item => item.status)).toEqual(['in_progress', 'in_progress', 'completed'])
})

test('other tools are not task calls', async () => {
	expect(applyTaskCall([], { tool: 'Bash', input: { command: 'ls' } })).toBeNull()
})
