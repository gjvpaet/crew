export type Role = 'developer' | 'designer' | 'researcher' | 'reviewer' | 'plain'

export type Accessory = 'headset' | 'beret' | 'glasses' | 'hardhat' | 'none'

export type MascotStyle = { accessory?: Accessory; body?: string; accent?: string }

export type MascotPrefs = Partial<Record<Role, MascotStyle>>

export type AgentStatusView =
	| 'pending'
	| 'running'
	| 'waiting'
	| 'idle'
	| 'completed'
	| 'failed'
	| 'killed'
	| 'stopped'

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type Steps = { done: number; total: number; current?: string }

export type TaskItem = { id: string; title: string; status: 'pending' | 'in_progress' | 'completed' }

export type AgentRecord = {
	id: string
	description: string
	type: string
	role: Role
	model?: string
	effort?: string
	status: AgentStatusView
	parentId?: string
	spawnedAt: number
	endedAt?: number
	usage: Usage
	lastRequestInput: number
	steps?: Steps
	// Index into the panel's accents, taken once when the agent is first seen and kept for its life.
	colorIndex?: number
}

export type AgentIdentity = {
	description: string
	type: string
	role: Role
	parentId?: string
	model?: string
	colorIndex?: number
}

export type TurnInfo = {
	id: string
	label: string
	startedAt: number
	endedAt?: number
	isAborted: boolean
}

export type CrewState = {
	turn: TurnInfo | null
	agents: Record<string, AgentRecord>
	order: string[]
	tasks: TaskItem[]
	// The list is an unfinished one from an earlier prompt that this prompt has not touched: kept, not shown.
	areTasksCarried?: boolean
	agentTasks: Record<string, TaskItem[]>
	sessionByModel: Record<string, Usage>
	turnByModel: Record<string, Usage>
	known: Record<string, AgentIdentity>
	// The colour index the next new sub-agent takes.
	nextColor: number
}

declare module 'claude-code' {
	interface PluginState {
		crew: {
			model: CrewState
			isBandHidden: boolean
			// Whether a surface draws the Agents pane: the band offers it back while it is not.
			isPaneShown: boolean
			groupOpen: Record<string, boolean>
			mascots: MascotPrefs
			hasAutoOpened: boolean
		}
	}
}
