// Tool tính toán: LLM hay tính nhầm, nên mọi con số trong đề/đáp án
// phải được agent kiểm tra lại bằng các tool này.

import { create, all, type Fraction } from 'mathjs'
import { defineTool } from '../core/tool.ts'

const math = create(all!, {})
const fmt = (value: unknown) => math.format(value, { precision: 12 })

export const calculate = defineTool<{ expression: string }>({
  name: 'calculate',
  description:
    'Tính giá trị một biểu thức toán (cú pháp mathjs). Hỗ trợ + - * / ^, sqrt, abs, sin/cos/tan '
    + '(radian; dùng "deg" cho độ, vd. sin(30 deg)), pi, log, combinations(n,k) = C(n,k), '
    + 'permutations(n,k) = A(n,k), factorial(n) hoặc n!, fraction(1/3). '
    + 'Luôn dùng tool này để kiểm tra mọi phép tính trước khi ghi vào đề hoặc đáp án.',
  parameters: {
    type: 'object',
    properties: { expression: { type: 'string', description: 'Ví dụ: "combinations(10,3)", "sqrt(3)/2", "sin(60 deg)"' } },
    required: ['expression'],
  },
  execute: ({ expression }) => {
    const value = math.evaluate(expression)
    const result: Record<string, string> = { expression, result: fmt(value) }
    const exact = asSimpleFraction(value)
    if (exact && exact.includes('/')) result.fraction = exact
    return result
  },
})

type QuadraticArgs = { a: number; b: number; c: number }

export const analyzeQuadratic = defineTool<QuadraticArgs>({
  name: 'analyze_quadratic',
  description:
    'Phân tích tam thức bậc hai f(x) = ax² + bx + c (a ≠ 0): biệt thức Δ, nghiệm, '
    + 'đỉnh parabol, trục đối xứng, chiều biến thiên và bảng xét dấu của f(x).',
  parameters: {
    type: 'object',
    properties: {
      a: { type: 'number' },
      b: { type: 'number' },
      c: { type: 'number' },
    },
    required: ['a', 'b', 'c'],
  },
  execute: ({ a, b, c }) => {
    if (a === 0) throw new Error('a phải khác 0 (đây không phải tam thức bậc hai)')
    const delta = b * b - 4 * a * c
    const vertexX = -b / (2 * a)
    const vertexY = -delta / (4 * a)
    const exact = [a, b, c].every(Number.isInteger)

    let roots: string[] = []
    let rootValues: number[] = []
    if (delta === 0) {
      rootValues = [vertexX]
      roots = [exactOrDecimal(vertexX)]
    } else if (delta > 0) {
      const s = Math.sqrt(delta)
      rootValues = [(-b - s) / (2 * a), (-b + s) / (2 * a)].sort((x, y) => x - y)
      roots = exact ? exactQuadraticRoots(a, b, delta) : rootValues.map(v => fmt(v))
    }

    const sign = a > 0 ? '+' : '-'
    const opposite = a > 0 ? '-' : '+'
    let signTable: string
    if (delta < 0) signTable = `f(x) luôn ${a > 0 ? 'dương' : 'âm'} với mọi x ∈ ℝ`
    else if (delta === 0) signTable = `f(x) cùng dấu a (${sign}) với mọi x ≠ ${roots[0]}; f(${roots[0]}) = 0`
    else signTable = `x ∈ (-∞; ${roots[0]}) ∪ (${roots[1]}; +∞): f(x) ${sign};  x ∈ (${roots[0]}; ${roots[1]}): f(x) ${opposite}`

    return {
      f: formatQuadratic(a, b, c),
      delta: fmt(delta),
      roots: roots.length ? roots : 'vô nghiệm (Δ < 0)',
      rootsDecimal: rootValues.map(v => fmt(v)),
      vertex: `I(${exactOrDecimal(vertexX)}; ${exactOrDecimal(vertexY)})`,
      axisOfSymmetry: `x = ${exactOrDecimal(vertexX)}`,
      monotonicity: a > 0
        ? `nghịch biến trên (-∞; ${exactOrDecimal(vertexX)}), đồng biến trên (${exactOrDecimal(vertexX)}; +∞); GTNN = ${exactOrDecimal(vertexY)}`
        : `đồng biến trên (-∞; ${exactOrDecimal(vertexX)}), nghịch biến trên (${exactOrDecimal(vertexX)}; +∞); GTLN = ${exactOrDecimal(vertexY)}`,
      signTable,
    }
  },
})

export const describeStatistics = defineTool<{ data: number[] }>({
  name: 'describe_statistics',
  description:
    'Tính các số đặc trưng của mẫu số liệu không ghép nhóm theo SGK Toán 10: số trung bình, '
    + 'trung vị, mốt, tứ phân vị Q1-Q2-Q3, khoảng biến thiên, khoảng tứ phân vị, '
    + 'phương sai và độ lệch chuẩn (chia cho n), giá trị bất thường.',
  parameters: {
    type: 'object',
    properties: { data: { type: 'array', items: { type: 'number' }, description: 'Mẫu số liệu' } },
    required: ['data'],
  },
  execute: ({ data }) => {
    if (!Array.isArray(data) || data.length === 0) throw new Error('Mẫu số liệu rỗng')
    const sorted = [...data].sort((x, y) => x - y)
    const n = sorted.length
    const mean = sorted.reduce((sum, x) => sum + x, 0) / n
    const variance = sorted.reduce((sum, x) => sum + (x - mean) ** 2, 0) / n

    // Tứ phân vị theo SGK: Q1, Q3 là trung vị của nửa dưới / nửa trên
    // (không tính Q2 vào hai nửa khi n lẻ).
    const half = Math.floor(n / 2)
    const q2 = median(sorted)
    const q1 = n > 1 ? median(sorted.slice(0, half)) : q2
    const q3 = n > 1 ? median(sorted.slice(n - half)) : q2
    const iqr = q3 - q1

    const counts = new Map<number, number>()
    for (const x of sorted) counts.set(x, (counts.get(x) ?? 0) + 1)
    const maxCount = Math.max(...counts.values())
    const modes = maxCount > 1 ? [...counts].filter(([, k]) => k === maxCount).map(([x]) => x) : []

    return {
      n,
      sorted,
      mean: fmt(mean),
      median: fmt(q2),
      modes: modes.length ? modes : 'không có mốt (mọi giá trị xuất hiện 1 lần)',
      quartiles: { Q1: fmt(q1), Q2: fmt(q2), Q3: fmt(q3) },
      range: fmt(sorted[n - 1]! - sorted[0]!),
      interquartileRange: fmt(iqr),
      variance: fmt(variance),
      standardDeviation: fmt(Math.sqrt(variance)),
      outliers: sorted.filter(x => x < q1 - 1.5 * iqr || x > q3 + 1.5 * iqr),
    }
  },
})

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** Nghiệm dạng chính xác (-b ± k√m) / 2a với a, b, c nguyên. */
function exactQuadraticRoots(a: number, b: number, delta: number): string[] {
  const [k, m] = simplifySqrt(delta)
  const denom = 2 * a
  if (m === 1) {
    return [(-b - k) / denom, (-b + k) / denom].sort((x, y) => x - y).map(exactOrDecimal)
  }
  // Rút gọn ước chung của b, k và mẫu.
  // Nếu mẫu âm thì nhân cả tử và mẫu với -1 để mẫu luôn dương.
  const g = gcd(gcd(Math.abs(b), k), Math.abs(denom))
  const B = (denom < 0 ? b : -b) / g
  const K = k / g
  const D = Math.abs(denom) / g
  const radical = `${K === 1 ? '' : K}√${m}`
  const numerator = (op: string) => (B === 0 ? `${op === '-' ? '-' : ''}${radical}` : `${B} ${op} ${radical}`)
  const wrap = (op: string) => (D === 1 ? numerator(op) : `(${numerator(op)})/${D}`)
  return [wrap('-'), wrap('+')]
}

/** √n = k√m với m không còn thừa số chính phương. */
function simplifySqrt(n: number): [number, number] {
  let k = 1
  let m = n
  for (let f = 2; f * f <= m; f++) {
    while (m % (f * f) === 0) {
      m /= f * f
      k *= f
    }
  }
  return [k, m]
}

function gcd(x: number, y: number): number {
  return y === 0 ? x || 1 : gcd(y, x % y)
}

function exactOrDecimal(value: number): string {
  return asSimpleFraction(value) ?? fmt(value)
}

/** Trả về "p/q" nếu value đúng bằng một phân số có mẫu nhỏ, ngược lại undefined. */
function asSimpleFraction(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const f = math.fraction(value) as Fraction
  if (Number(f.d) > 1000 || Math.abs(Number(f.valueOf()) - value) > 1e-12) return undefined
  return Number(f.d) === 1 ? fmt(Number(f.valueOf())) : math.format(f, { fraction: 'ratio' })
}

/** Viết đa thức gọn: 1x² + -5x + 0 → x² - 5x. */
function formatQuadratic(a: number, b: number, c: number): string {
  const terms: string[] = []
  for (const [coef, power] of [[a, 'x²'], [b, 'x'], [c, '']] as const) {
    if (coef === 0) continue
    const abs = Math.abs(coef)
    const body = power && abs === 1 ? power : `${fmt(abs)}${power}`
    if (terms.length === 0) terms.push(coef < 0 ? `-${body}` : body)
    else terms.push(`${coef < 0 ? '-' : '+'} ${body}`)
  }
  return terms.join(' ')
}
