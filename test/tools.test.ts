import { describe, expect, it } from 'vitest'
import { lookupCurriculum } from '../src/tools/curriculum.ts'
import { analyzeQuadratic, calculate, describeStatistics } from '../src/tools/math.ts'

const ctx = { confirm: async () => true }

describe('calculate', () => {
  it('tính tổ hợp, lượng giác theo độ và trả phân số', () => {
    expect(calculate.execute({ expression: 'combinations(10,3)' }, ctx)).toEqual({ expression: 'combinations(10,3)', result: '120' })
    expect(calculate.execute({ expression: 'sin(30 deg)' }, ctx)).toMatchObject({ result: '0.5', fraction: '1/2' })
    expect(calculate.execute({ expression: '1/3 + 1/4' }, ctx)).toMatchObject({ fraction: '7/12' })
  })
})

describe('analyze_quadratic', () => {
  it('Δ > 0 với nghiệm nguyên', () => {
    expect(analyzeQuadratic.execute({ a: 1, b: -5, c: 6 }, ctx)).toMatchObject({
      f: 'x² - 5x + 6',
      delta: '1',
      roots: ['2', '3'],
      vertex: 'I(5/2; -1/4)',
      signTable: 'x ∈ (-∞; 2) ∪ (3; +∞): f(x) +;  x ∈ (2; 3): f(x) -',
    })
  })

  it('nghiệm vô tỉ viết dạng căn rút gọn, a < 0', () => {
    expect(analyzeQuadratic.execute({ a: -2, b: 4, c: 1 }, ctx)).toMatchObject({
      roots: ['(2 - √6)/2', '(2 + √6)/2'],
      vertex: 'I(1; 3)',
    })
    expect(analyzeQuadratic.execute({ a: 1, b: 0, c: -8 }, ctx)).toMatchObject({ roots: ['-2√2', '2√2'] })
  })

  it('Δ < 0 và a = 0', () => {
    expect(analyzeQuadratic.execute({ a: 1, b: 2, c: 5 }, ctx)).toMatchObject({ signTable: 'f(x) luôn dương với mọi x ∈ ℝ' })
    expect(() => analyzeQuadratic.execute({ a: 0, b: 1, c: 1 }, ctx)).toThrow(/a phải khác 0/)
  })
})

describe('describe_statistics', () => {
  it('tứ phân vị theo cách SGK và phát hiện giá trị bất thường', () => {
    expect(describeStatistics.execute({ data: [5, 7, 8, 8, 9, 10, 3, 6, 30] }, ctx)).toMatchObject({
      n: 9,
      median: '8',
      modes: [8],
      quartiles: { Q1: '5.5', Q2: '8', Q3: '9.5' },
      interquartileRange: '4',
      outliers: [30],
    })
  })

  it('phương sai chia cho n', () => {
    expect(describeStatistics.execute({ data: [2, 4, 4, 4, 5, 5, 7, 9] }, ctx)).toMatchObject({
      mean: '5', variance: '4', standardDeviation: '2',
    })
  })
})

describe('lookup_curriculum', () => {
  it('tìm theo từ khoá không dấu, số bài và số chương', () => {
    expect(JSON.stringify(lookupCurriculum.execute({ query: 'vecto' }, ctx))).toContain('Chương IV. Vectơ')
    expect(lookupCurriculum.execute({ query: 'Bài 17' }, ctx)).toMatchObject({
      chapters: [{ lessons: ['Bài 17. Dấu của tam thức bậc hai'] }],
    })
    expect(lookupCurriculum.execute({ query: 'chương VIII' }, ctx)).toMatchObject({
      chapters: [{ chapter: 'Chương VIII. Đại số tổ hợp (Tập 2)' }],
    })
  })
})
