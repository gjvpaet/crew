import { expect, test } from 'claude-code/testing'

import {
	bar,
	fmtDuration,
	fmtPercent,
	fmtTokens,
	fmtUsd,
	prettyModel,
	shimmer,
	truncate
} from '../hooks/format'

test('fmtTokens rounds to k and M', async () => {
	expect(fmtTokens(950)).toBe('950')
	expect(fmtTokens(1000)).toBe('1k')
	expect(fmtTokens(1500)).toBe('1.5k')
	expect(fmtTokens(13_500)).toBe('14k')
	expect(fmtTokens(254_000)).toBe('254k')
	expect(fmtTokens(2_100_000)).toBe('2.1M')
})

test('fmtUsd always reads as an estimate', async () => {
	expect(fmtUsd(null)).toBe('≈?')
	expect(fmtUsd(0)).toBe('≈$0.00')
	expect(fmtUsd(0.004)).toBe('≈<$0.01')
	expect(fmtUsd(0.0812)).toBe('≈$0.08')
	expect(fmtUsd(1.5)).toBe('≈$1.50')
})

test('fmtDuration is m:ss, or h:mm:ss past an hour', async () => {
	expect(fmtDuration(41_000)).toBe('0:41')
	expect(fmtDuration(61_000)).toBe('1:01')
	expect(fmtDuration(3_725_000)).toBe('1:02:05')
	expect(fmtDuration(-5)).toBe('0:00')
})

test('fmtPercent clamps and rounds', async () => {
	expect(fmtPercent(0.5)).toBe('50%')
	expect(fmtPercent(0.666)).toBe('67%')
	expect(fmtPercent(1.4)).toBe('100%')
})

test('bar fills by fraction and clamps', async () => {
	expect(bar(0.5, 10)).toBe('█████░░░░░')
	expect(bar(1.2, 4)).toBe('████')
	expect(bar(-1, 3)).toBe('░░░')
})

test('shimmer moves a three-cell highlight with time', async () => {
	expect(shimmer(5, 0)).toBe('░░░░░')
	expect(shimmer(5, 600)).toBe('▓▓▓░░')
})

test('truncate ends with an ellipsis', async () => {
	expect(truncate('abcdefgh', 5)).toBe('abcd…')
	expect(truncate('abc', 5)).toBe('abc')
	expect(truncate('abc', 1)).toBe('…')
})

test('prettyModel names the family and version', async () => {
	expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
	expect(prettyModel('claude-sonnet-4-6[1m]')).toBe('Sonnet 4.6 1M')
	expect(prettyModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
	expect(prettyModel('claude-opus-5')).toBe('Opus 5')
	expect(prettyModel('gpt-4o')).toBe('gpt-4o')
	expect(prettyModel(undefined)).toBe('model ?')
})
