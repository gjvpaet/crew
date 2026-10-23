import { expect, test } from 'claude-code/testing'

import { contextWindow, estimateUsd, priceFor } from '../hooks/pricing'

const ONLY_INPUT = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }
const micro = (value: number | null) => (value === null ? null : Math.round(value * 1_000_000))

test('every token type is priced', async () => {
	const usage = { input: 10_000, output: 2_000, cacheRead: 100_000, cacheWrite: 20_000 }
	expect(micro(estimateUsd(usage, 'claude-opus-5-5'))).toBe(200_000)
})

test('the longest matching model id wins', async () => {
	expect(estimateUsd(ONLY_INPUT, 'claude-opus-5-5')).toBe(4)
	expect(estimateUsd(ONLY_INPUT, 'claude-opus-5')).toBe(5)
	expect(estimateUsd(ONLY_INPUT, 'claude-fable-5-1')).toBe(10)
})

test('suffixes, prefixes and aliases resolve', async () => {
	expect(estimateUsd(ONLY_INPUT, 'claude-opus-5-5[1m]')).toBe(4)
	expect(estimateUsd(ONLY_INPUT, 'us.anthropic.claude-sonnet-4-6')).toBe(3)
	expect(estimateUsd(ONLY_INPUT, 'sonnet')).toBe(2)
	expect(estimateUsd(ONLY_INPUT, 'haiku')).toBe(0.1)
})

test('an unknown model has no price', async () => {
	expect(priceFor('gpt-x')).toBeUndefined()
	expect(estimateUsd(ONLY_INPUT, 'gpt-x')).toBeNull()
})

test('context windows come from the table, 200k when unknown', async () => {
	expect(contextWindow('claude-opus-5-5')).toBe(1_000_000)
	expect(contextWindow('claude-haiku-4-5')).toBe(200_000)
	expect(contextWindow('mystery')).toBe(200_000)
})
