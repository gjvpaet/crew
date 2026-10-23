const trimZero = (text: string) => text.replace(/\.0$/, '')

export const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

export function fmtTokens(count: number): string {
	if (count < 1000) return String(count)
	if (count < 10_000) return `${trimZero((count / 1000).toFixed(1))}k`
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`
	return `${trimZero((count / 1_000_000).toFixed(1))}M`
}

export function fmtUsd(value: number | null): string {
	if (value === null) return '≈?'
	if (value > 0 && value < 0.01) return '≈<$0.01'
	return `≈$${value.toFixed(2)}`
}

export function fmtDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000))
	const hours = Math.floor(total / 3600)
	const minutes = Math.floor((total % 3600) / 60)
	const seconds = String(total % 60).padStart(2, '0')
	return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

export const fmtPercent = (fraction: number) => `${Math.round(clamp(fraction, 0, 1) * 100)}%`

export function bar(fraction: number, width: number): string {
	const filled = Math.round(clamp(fraction, 0, 1) * width)
	return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function shimmer(width: number, now: number): string {
	const head = (Math.floor(now / 200) % (width + 3)) - 3
	let out = ''
	for (let i = 0; i < width; i++) out += i >= head && i < head + 3 ? '▓' : '░'
	return out
}

export function truncate(text: string, max: number): string {
	if (max <= 1) return '…'
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

const FAMILY = /claude-(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?!\d)/

export function prettyModel(model?: string): string {
	if (!model) return 'model ?'
	const match = FAMILY.exec(model.toLowerCase())
	if (!match) return model
	const name = match[1][0].toUpperCase() + match[1].slice(1)
	const version = match[3] ? `${match[2]}.${match[3]}` : match[2]
	return `${name} ${version}${/\[1m\]/i.test(model) ? ' 1M' : ''}`
}
