import type { Role } from '../types'

const BY_TYPE: Array<[RegExp, Role]> = [
	[/review/, 'reviewer'],
	[/explore|research|guide/, 'researcher'],
	[/plan|design/, 'designer']
]

const BY_DESCRIPTION: Array<[RegExp, Role]> = [
	[/\b(review|audit|verif|check|critique)/, 'reviewer'],
	[/\b(design|ui\b|ux\b|mockup|layout|styl|graphic|visual|brand)/, 'designer'],
	[/\b(research|investigat|explor|search|find|look|read|analy|compar|survey|summar)/, 'researcher'],
	[/\b(build|implement|fix|code|coding|writ|refactor|test|migrat|add|creat|debug|deploy)/, 'developer']
]

export function roleFor({ type, description }: { type: string; description: string }): Role {
	const byType = BY_TYPE.find(([pattern]) => pattern.test(type.toLowerCase()))
	if (byType) return byType[1]
	const byDescription = BY_DESCRIPTION.find(([pattern]) => pattern.test(description.toLowerCase()))
	return byDescription ? byDescription[1] : 'plain'
}
