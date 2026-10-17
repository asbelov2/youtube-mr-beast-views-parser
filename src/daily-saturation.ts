// Integral of a decaying, nonnegative rate with a learned 24-hour rhythm.
// x is elapsed time divided by the full history span, including during validation.
export interface DailyParameters {
  intercept: number;
  level: number;
  sine: number;
  cosine: number;
  curvature: number;
  frequency: number;
}

const MAX_AMPLITUDE = 0.95;
type Vector = [number, number, number];

function basis(curvature: number, frequency: number, x: number): Vector {
  const decay = Math.exp(-curvature * x);
  const saturation = -Math.expm1(-curvature * x);
  const angle = frequency * x;
  const sine = Math.sin(angle);
  // This form also avoids subtracting nearly equal numbers near x = 0.
  const remainder = saturation + decay * 2 * Math.sin(angle / 2) ** 2;
  const scale = curvature / (curvature ** 2 + frequency ** 2);
  return [saturation,
    scale * (frequency * remainder - curvature * decay * sine),
    scale * (curvature * remainder + frequency * decay * sine)];
}

function solve(matrix: number[][], target: number[]): Vector | null {
  const rows = matrix.map((row, i) => [...row, target[i]!]);
  const scale = Math.max(...matrix.flat().map(Math.abs));
  for (let column = 0; column < 3; column++) {
    let pivot = column;
    for (let row = column + 1; row < 3; row++) {
      if (Math.abs(rows[row]![column]!) > Math.abs(rows[pivot]![column]!)) pivot = row;
    }
    if (Math.abs(rows[pivot]![column]!) <= scale * 1e-12) return null;
    [rows[column], rows[pivot]] = [rows[pivot]!, rows[column]!];
    const divisor = rows[column]![column]!;
    for (let j = column; j <= 3; j++) rows[column]![j] = rows[column]![j]! / divisor;
    for (let row = 0; row < 3; row++) if (row !== column) {
      const factor = rows[row]![column]!;
      for (let j = column; j <= 3; j++) rows[row]![j] = rows[row]![j]! - factor * rows[column]![j]!;
    }
  }
  return [rows[0]![3]!, rows[1]![3]!, rows[2]![3]!];
}

export function fitDailySaturation(curvature: number, spanHours: number, xs: number[], ys: number[]): DailyParameters {
  const frequency = 2 * Math.PI * spanHours / 24;
  const values = xs.map((x) => basis(curvature, frequency, x));
  const means = [0, 1, 2].map((j) => values.reduce((sum, row) => sum + row[j]!, 0) / xs.length);
  const meanY = ys.reduce((sum, y) => sum + y, 0) / ys.length;
  const matrix = Array.from({ length: 3 }, () => [0, 0, 0]);
  const target = [0, 0, 0];
  for (let i = 0; i < xs.length; i++) {
    const row = values[i]!.map((v, j) => v - means[j]!);
    for (let j = 0; j < 3; j++) {
      target[j] = target[j]! + row[j]! * (ys[i]! - meanY);
      for (let k = 0; k < 3; k++) matrix[j]![k] = matrix[j]![k]! + row[j]! * row[k]!;
    }
  }
  let coefficients = solve(matrix, target);
  if (!coefficients || coefficients[0] < 0 || Math.hypot(coefficients[1], coefficients[2]) > MAX_AMPLITUDE * coefficients[0]) {
    // An unconstrained fit can predict negative growth. The constrained optimum
    // is on the cone boundary (or its zero vertex). Search its phase, fitting
    // the remaining nonnegative scale exactly from sufficient statistics.
    const atPhase = (phase: number) => {
      const direction: Vector = [1, MAX_AMPLITUDE * Math.cos(phase), MAX_AMPLITUDE * Math.sin(phase)];
      const covariance = direction.reduce((sum, v, j) => sum + v * target[j]!, 0);
      const variance = direction.reduce((sum, v, j) => sum + v * matrix[j]!.reduce((s, m, k) => s + m * direction[k]!, 0), 0);
      const level = variance > 1e-14 ? Math.max(0, covariance / variance) : 0;
      return { phase, score: level ** 2 * variance - 2 * level * covariance, coefficients: direction.map((v) => v * level) as Vector };
    };
    let best = atPhase(0);
    let step = 2 * Math.PI / 32;
    for (let i = 1; i < 32; i++) {
      const next = atPhase(i * step);
      if (next.score < best.score) best = next;
    }
    for (let i = 0; i < 20; i++) {
      const left = atPhase(best.phase - step);
      const right = atPhase(best.phase + step);
      if (left.score < best.score) best = left;
      if (right.score < best.score) best = right;
      step /= 2;
    }
    coefficients = best.coefficients;
  }
  return {
    intercept: meanY - coefficients.reduce((sum, v, j) => sum + v * means[j]!, 0),
    level: coefficients[0], sine: coefficients[1], cosine: coefficients[2], curvature, frequency,
  };
}

export function predictDailySaturation(params: DailyParameters, x: number): number {
  const values = basis(params.curvature, params.frequency, x);
  return params.intercept + params.level * values[0] + params.sine * values[1] + params.cosine * values[2];
}
