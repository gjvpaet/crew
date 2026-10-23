import type { Usage } from '../types'

export type Price = {
	input: number
	output: number
	cacheRead: number
	cacheWrite: number
	contextWindow: number
}

export const PRICES_AS_OF = '2026-10-06'

const MILLION = 1_000_000
const DEFAULT_CONTEXT = 200_000

const price = (input: number, output: number, cacheRead: number, window = 1_000_000): Price => ({
	input,
	output,
	cacheRead,
	cacheWrite: input * 1.25,
	contextWindow: window
})

const ROWS: Array<[string, Price]> = [
	['claude-fable-5-1', price(10, 50, 0.25)],
	['claude-mythos-5-1', price(10, 50, 0.25)],
	['claude-fable-5', price(10, 50, 1)],
	['claude-opus-5-5', price(4, 20, 0.2)],
	['claude-opus-5', price(5, 25, 0.5)],
	['claude-opus-4-8', price(5, 25, 0.5)],
	['claude-opus-4-7', price(5, 25, 0.5)],
	['claude-opus-4-6', price(5, 25, 0.5)],
	['claude-sonnet-5-5', price(2, 10, 0.2)],
	['claude-sonnet-5', price(2, 10, 0.2)],
	['claude-sonnet-4-6', price(3, 15, 0.3)],
	['claude-haiku-5-5', price(0.1, 0.5, 0.01)],
	['claude-haiku-4-5', price(1, 5, 0.1, 200_000)]
]

const TABLE = [...ROWS].sort((a, b) => b[0].length - a[0].length)

const ALIASES: Record<string, string> = {
	fable: 'claude-fable-5-1',
	opus: 'claude-opus-5-5',
	sonnet: 'claude-sonnet-5-5',
	haiku: 'claude-haiku-5-5'
}

export function priceFor(model: string): Price | undefined {
	const id = model.toLowerCase().replace(/\[1m\]$/, '').trim()
	const resolved = ALIASES[id] ?? id
	return TABLE.find(([prefix]) => resolved.includes(prefix))?.[1]
}

export function estimateUsd(usage: Usage, model: string): number | null {
	const rate = priceFor(model)
	if (!rate) return null
	return (
		(usage.input * rate.input +
			usage.output * rate.output +
			usage.cacheRead * rate.cacheRead +
			usage.cacheWrite * rate.cacheWrite) /
		MILLION
	)
}

export const contextWindow = (model: string) => priceFor(model)?.contextWindow ?? DEFAULT_CONTEXT
