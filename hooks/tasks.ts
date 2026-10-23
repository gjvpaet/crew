import type { Steps, TaskItem } from '../types'

export type TaskToolCall = { tool: string; input: Record<string, unknown>; result?: unknown }

export const PLAN_TOOL = 'mcp__ccd_turn__update_plan'

// The Desktop turn's closing call: the app checks off every step of the plan as it draws the wrap-up.
export const WRAP_UP_TOOL = 'mcp__ccd_turn__wrap_up'

export const TASK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', PLAN_TOOL, WRAP_UP_TOOL])

type Status = TaskItem['status']

const asStatus = (value: unknown): Status =>
	value === 'completed' || value === 'in_progress' ? value : 'pending'

const asText = (value: unknown) => (typeof value === 'string' ? value : '')

const asList = (value: unknown): Array<Record<string, unknown>> =>
	Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : []

function fromTodoWrite(input: Record<string, unknown>): TaskItem[] {
	return asList(input.todos).map((todo, index) => ({
		id: String(index),
		title: asText(todo.content),
		status: asStatus(todo.status)
	}))
}

function fromTaskCreate(list: readonly TaskItem[], call: TaskToolCall): TaskItem[] {
	const result = call.result as { task?: { id?: unknown } } | undefined
	const id = typeof result?.task?.id === 'string' ? result.task.id : `new-${list.length}`
	return [...list, { id, title: asText(call.input.subject), status: 'pending' }]
}

function fromTaskUpdate(list: readonly TaskItem[], input: Record<string, unknown>): TaskItem[] {
	const id = asText(input.taskId)
	if (input.status === 'deleted') return list.filter(item => item.id !== id)
	return list.map(item =>
		item.id !== id
			? item
			: {
					...item,
					title: typeof input.subject === 'string' ? input.subject : item.title,
					status: input.status === undefined ? item.status : asStatus(input.status)
				}
	)
}

function advance(list: readonly TaskItem[]): TaskItem[] {
	const current = list.findIndex(item => item.status === 'in_progress')
	const marked = list.map((item, index) => (index === current ? { ...item, status: 'completed' as const } : item))
	const nextIndex = marked.findIndex((item, index) => index > current && item.status === 'pending')
	const fallback = nextIndex === -1 ? marked.findIndex(item => item.status === 'pending') : nextIndex
	return marked.map((item, index) => (index === fallback ? { ...item, status: 'in_progress' as const } : item))
}

function fromPlan(list: readonly TaskItem[], input: Record<string, unknown>): TaskItem[] {
	if (Array.isArray(input.items)) {
		return asList(input.items).map((item, index) => ({
			id: String(index + 1),
			title: asText(item.content),
			status: asStatus(item.status)
		}))
	}
	if (input.advance === true) return advance(list)
	const done = new Set(Array.isArray(input.done) ? input.done.filter(n => typeof n === 'number') : [])
	const start = typeof input.start === 'number' ? input.start : -1
	return list.map((item, index) => {
		if (done.has(index + 1)) return { ...item, status: 'completed' as const }
		if (start === index + 1) return { ...item, status: 'in_progress' as const }
		return item
	})
}

export function applyTaskCall(list: readonly TaskItem[], call: TaskToolCall): TaskItem[] | null {
	switch (call.tool) {
		case 'TodoWrite':
			return fromTodoWrite(call.input)
		case 'TaskCreate':
			return fromTaskCreate(list, call)
		case 'TaskUpdate':
			return fromTaskUpdate(list, call.input)
		case PLAN_TOOL:
			return fromPlan(list, call.input)
		case WRAP_UP_TOOL:
			return list.map(item => ({ ...item, status: 'completed' as const }))
		default:
			return null
	}
}

export function taskProgress(list: readonly TaskItem[]): Steps {
	const current = list.find(item => item.status === 'in_progress')
	return {
		done: list.filter(item => item.status === 'completed').length,
		total: list.length,
		...(current ? { current: current.title } : {})
	}
}
