import type { Accessory, MascotPrefs, MascotStyle, Role } from '../types'

export const ROLES: Role[] = ['developer', 'designer', 'researcher', 'reviewer', 'plain']
export const ACCESSORIES: Accessory[] = ['headset', 'beret', 'glasses', 'hardhat', 'none']

export const SET_MASCOT_TOOL = 'mcp__crew__set_mascot'

export const SET_MASCOT_SPEC = {
	name: 'set_mascot',
	description:
		"Restyle a Crew agents-panel mascot for one role. Use when the user asks to change how the Crew mascots look (e.g. 'make the designer wear a hard hat', 'make reviewers green'). Changes persist across sessions.",
	inputSchema: {
		type: 'object',
		properties: {
			role: { type: 'string', enum: ROLES, description: 'Which role to restyle' },
			accessory: { type: 'string', enum: ACCESSORIES },
			body: { type: 'string', description: 'Body colour as #RRGGBB' },
			accent: { type: 'string', description: 'Accessory colour as #RRGGBB' },
			reset: { type: 'boolean', description: 'Back to the default look for this role' }
		},
		required: ['role'],
		additionalProperties: false
	}
}

export type MascotChange = { role: Role; reset: true } | { role: Role; style: MascotStyle }

const HEX = /^#[0-9a-fA-F]{6}$/

export function parseMascotInput(input: Record<string, unknown>): MascotChange | { error: string } {
	const role = input.role as Role
	if (!ROLES.includes(role)) return { error: `role must be one of ${ROLES.join(', ')}` }
	if (input.reset === true) return { role, reset: true }
	const style: MascotStyle = {}
	if (input.accessory !== undefined) {
		if (!ACCESSORIES.includes(input.accessory as Accessory)) {
			return { error: `accessory must be one of ${ACCESSORIES.join(', ')}` }
		}
		style.accessory = input.accessory as Accessory
	}
	for (const key of ['body', 'accent'] as const) {
		const value = input[key]
		if (value === undefined) continue
		if (typeof value !== 'string' || !HEX.test(value)) return { error: `${key} must be a hex colour like #7C9CF5` }
		style[key] = value
	}
	if (Object.keys(style).length === 0) return { error: 'give accessory, body, accent or reset' }
	return { role, style }
}

export function applyMascotChange(prefs: MascotPrefs, change: MascotChange): MascotPrefs {
	if ('reset' in change) {
		const { [change.role]: _removed, ...rest } = prefs
		return rest
	}
	return { ...prefs, [change.role]: { ...prefs[change.role], ...change.style } }
}
