export interface ConfidenceInterval {
  lower: number;
  point: number;
  upper: number;
}

export interface DistributionSummary {
  count: number;
  mean: number;
  median: number;
  stddev: number;
  min: number;
  max: number;
}

export function wilsonInterval(successes: number, trials: number): ConfidenceInterval {
  if (trials === 0) {
    return { lower: 0, point: 0, upper: 0 };
  }

  const z = 1.96;
  const p = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const center = (p + (z * z) / (2 * trials)) / denominator;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) /
    denominator;

  return {
    lower: Math.max(0, center - margin),
    point: p,
    upper: Math.min(1, center + margin),
  };
}

export function bootstrapMeanInterval(
  values: readonly number[],
  iterations: number = 2000,
): ConfidenceInterval {
  if (values.length === 0) {
    return { lower: 0, point: 0, upper: 0 };
  }

  const point = values.reduce((sum, value) => sum + value, 0) / values.length;
  let seed = 42;

  function nextRandom(): number {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  }

  const means: number[] = [];

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0;

    for (let index = 0; index < values.length; index += 1) {
      sum += values[Math.floor(nextRandom() * values.length)];
    }

    means.push(sum / values.length);
  }

  means.sort((left, right) => left - right);

  return {
    lower: means[Math.floor(0.025 * means.length)],
    point,
    upper: means[Math.floor(0.975 * means.length)],
  };
}

export function describeDistribution(values: readonly number[]): DistributionSummary {
  if (values.length === 0) {
    return {
      count: 0,
      mean: 0,
      median: 0,
      stddev: 0,
      min: 0,
      max: 0,
    };
  }

  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) /
    values.length;
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];

  return {
    count: values.length,
    mean,
    median,
    stddev: Math.sqrt(variance),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}
