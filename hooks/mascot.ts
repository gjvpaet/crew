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

const isRole = (value: unknown): value is Role => ROLES.includes(value as Role)
const isAccessory = (value: unknown): value is Accessory => ACCESSORIES.includes(value as Accessory)
const isHex = (value: unknown): value is string => typeof value === 'string' && HEX.test(value)

export function parseMascotInput(input: Record<string, unknown>): MascotChange | { error: string } {
	const role = input.role
	if (!isRole(role)) return { error: `role must be one of ${ROLES.join(', ')}` }
	if (input.reset === true) return { role, reset: true }
	const style: MascotStyle = {}
	if (input.accessory !== undefined) {
		if (!isAccessory(input.accessory)) return { error: `accessory must be one of ${ACCESSORIES.join(', ')}` }
		style.accessory = input.accessory
	}
	for (const key of ['body', 'accent'] as const) {
		const value = input[key]
		if (value === undefined) continue
		if (!isHex(value)) return { error: `${key} must be a hex colour like #7C9CF5` }
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value)

// Prefs read back from the store: keep each role and field that set_mascot would have accepted, drop the rest.
export function sanitizeMascots(value: unknown): MascotPrefs {
	if (!isRecord(value)) return {}
	const prefs: MascotPrefs = {}
	for (const role of ROLES) {
		const saved = value[role]
		if (!isRecord(saved)) continue
		const style: MascotStyle = {
			...(isAccessory(saved.accessory) ? { accessory: saved.accessory } : {}),
			...(isHex(saved.body) ? { body: saved.body } : {}),
			...(isHex(saved.accent) ? { accent: saved.accent } : {})
		}
		if (Object.keys(style).length > 0) prefs[role] = style
	}
	return prefs
}
