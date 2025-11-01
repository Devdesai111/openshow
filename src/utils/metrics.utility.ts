// src/utils/metrics.utility.ts
// Prometheus metrics mock/interface implementation for Task 75

/**
 * Mock implementation of Prometheus metrics registry and metric types.
 * In production, this would use the 'prom-client' library.
 */

interface MetricConfig {
  name: string;
  help: string;
  labelNames: string[];
}

/**
 * Counter metric - increments a value
 */
export class Counter {
  private name: string;
  private help: string;
  private labelNames: string[];
  private counts: Map<string, number> = new Map();

  constructor(config: MetricConfig) {
    this.name = config.name;
    this.help = config.help;
    this.labelNames = config.labelNames;
  }

  /**
   * Increment the counter by 1 (or by specified amount)
   */
  inc(labels?: Record<string, string>, amount: number = 1): void {
    const key = this.getLabelKey(labels || {});
    const current = this.counts.get(key) || 0;
    this.counts.set(key, current + amount);
  }

  /**
   * Get the current count for given labels
   */
  get(labels?: Record<string, string>): number {
    const key = this.getLabelKey(labels || {});
    return this.counts.get(key) || 0;
  }

  /**
   * Get all counts as a string for Prometheus format
   */
  serialize(): string {
    let result = `# HELP ${this.name} ${this.help}\n`;
    result += `# TYPE ${this.name} counter\n`;

    if (this.counts.size === 0) {
      result += `${this.name} 0\n`;
      return result;
    }

    for (const [labelKey, count] of this.counts.entries()) {
      if (labelKey) {
        result += `${this.name}{${labelKey}} ${count}\n`;
      } else {
        result += `${this.name} ${count}\n`;
      }
    }

    return result;
  }

  private getLabelKey(labels: Record<string, string>): string {
    if (this.labelNames.length === 0 || Object.keys(labels).length === 0) {
      return '';
    }

    const parts: string[] = [];
    for (const labelName of this.labelNames) {
      const value = labels[labelName] || '';
      parts.push(`${labelName}="${value}"`);
    }
    return parts.join(',');
  }
}

/**
 * Histogram metric - records distribution of values
 */
export class Histogram {
  private name: string;
  private help: string;
  private labelNames: string[];
  private buckets: number[];
  private observations: Map<string, number[]> = new Map();

  constructor(config: MetricConfig & { buckets: number[] }) {
    this.name = config.name;
    this.help = config.help;
    this.labelNames = config.labelNames;
    this.buckets = config.buckets;
  }

  /**
   * Start a timer that returns an end function
   */
  startTimer(labels?: Record<string, string>): (endLabels?: Record<string, string>) => number {
    const startTime = process.hrtime.bigint();
    return (endLabels?: Record<string, string>) => {
      const endTime = process.hrtime.bigint();
      const durationSeconds = Number(endTime - startTime) / 1e9;
      this.observe(endLabels || labels || {}, durationSeconds);
      return durationSeconds;
    };
  }

  /**
   * Observe a value (duration in seconds)
   */
  observe(labels: Record<string, string>, value: number): void {
    const key = this.getLabelKey(labels);
    if (!this.observations.has(key)) {
      this.observations.set(key, []);
    }
    this.observations.get(key)!.push(value);
  }

  /**
   * Get histogram data as a string for Prometheus format
   */
  serialize(): string {
    let result = `# HELP ${this.name} ${this.help}\n`;
    result += `# TYPE ${this.name} histogram\n`;

    for (const [labelKey, values] of this.observations.entries()) {
      const bucketCounts: Map<number, number> = new Map();
      let sum = 0;
      let count = 0;

      // Calculate bucket counts
      for (const bucket of this.buckets) {
        bucketCounts.set(bucket, 0);
      }

      for (const value of values) {
        sum += value;
        count++;
        // Count values into buckets
        for (const bucket of this.buckets) {
          if (value <= bucket) {
            bucketCounts.set(bucket, (bucketCounts.get(bucket) || 0) + 1);
          }
        }
      }

      // Serialize bucket counts
      for (const bucket of this.buckets) {
        const bucketLabelKey = labelKey ? `${labelKey},le="${bucket}"` : `le="${bucket}"`;
        result += `${this.name}_bucket{${bucketLabelKey}} ${bucketCounts.get(bucket) || 0}\n`;
      }

      // Sum and count
      const sumLabelKey = labelKey ? `${labelKey}` : '';
      result += `${this.name}_sum{${sumLabelKey}} ${sum}\n`;
      result += `${this.name}_count{${sumLabelKey}} ${count}\n`;
    }

    // If no observations, return default
    if (this.observations.size === 0) {
      for (const bucket of this.buckets) {
        result += `${this.name}_bucket{le="${bucket}"} 0\n`;
      }
      result += `${this.name}_sum 0\n`;
      result += `${this.name}_count 0\n`;
    }

    return result;
  }

  private getLabelKey(labels: Record<string, string>): string {
    if (this.labelNames.length === 0 || Object.keys(labels).length === 0) {
      return '';
    }

    const parts: string[] = [];
    for (const labelName of this.labelNames) {
      const value = labels[labelName] || '';
      parts.push(`${labelName}="${value}"`);
    }
    return parts.join(',');
  }
}

/**
 * Gauge metric - can increase or decrease
 */
export class Gauge {
  private name: string;
  private help: string;
  private labelNames: string[];
  private values: Map<string, number> = new Map();

  constructor(config: MetricConfig) {
    this.name = config.name;
    this.help = config.help;
    this.labelNames = config.labelNames;
  }

  /**
   * Set the gauge value
   */
  set(labels: Record<string, string>, value: number): void {
    const key = this.getLabelKey(labels);
    this.values.set(key, value);
  }

  /**
   * Increment the gauge
   */
  inc(labels: Record<string, string>, amount: number = 1): void {
    const key = this.getLabelKey(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current + amount);
  }

  /**
   * Decrement the gauge
   */
  dec(labels: Record<string, string>, amount: number = 1): void {
    const key = this.getLabelKey(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current - amount);
  }

  /**
   * Get gauge data as a string for Prometheus format
   */
  serialize(): string {
    let result = `# HELP ${this.name} ${this.help}\n`;
    result += `# TYPE ${this.name} gauge\n`;

    if (this.values.size === 0) {
      result += `${this.name} 0\n`;
      return result;
    }

    for (const [labelKey, value] of this.values.entries()) {
      if (labelKey) {
        result += `${this.name}{${labelKey}} ${value}\n`;
      } else {
        result += `${this.name} ${value}\n`;
      }
    }

    return result;
  }

  private getLabelKey(labels: Record<string, string>): string {
    if (this.labelNames.length === 0 || Object.keys(labels).length === 0) {
      return '';
    }

    const parts: string[] = [];
    for (const labelName of this.labelNames) {
      const value = labels[labelName] || '';
      parts.push(`${labelName}="${value}"`);
    }
    return parts.join(',');
  }
}

/**
 * Registry to hold all metrics
 */
class Registry {
  private registeredMetrics: Array<Counter | Histogram | Gauge> = [];

  /**
   * Register a metric
   */
  registerMetric(metric: Counter | Histogram | Gauge): void {
    this.registeredMetrics.push(metric);
  }

  /**
   * Get all metrics in Prometheus text format
   */
  async metrics(): Promise<string> {
    let result = '';
    for (const metric of this.registeredMetrics) {
      result += metric.serialize();
      result += '\n';
    }
    return result.trim();
  }

  /**
   * Prometheus content type
   */
  get contentType(): string {
    return 'text/plain; version=0.0.4; charset=utf-8';
  }
}

// Create the main registry instance
const registry = new Registry();

// Define core metrics
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests processed',
  labelNames: ['method', 'path', 'status'],
});
registry.registerMetric(httpRequestsTotal);

export const httpRequestDurationSeconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'path'],
  buckets: [0.003, 0.03, 0.1, 0.3, 1.0, 3.0, 5.0], // Standard fast service buckets
});
registry.registerMetric(httpRequestDurationSeconds);

// Example gauge metric for active jobs
export const activeJobsGauge = new Gauge({
  name: 'app_active_jobs_count',
  help: 'Current number of jobs with status=leased or status=running',
  labelNames: ['type'],
});
registry.registerMetric(activeJobsGauge);

/**
 * Retrieve metrics in Prometheus text format
 */
export async function getMetricsRegistry(): Promise<string> {
  return registry.metrics();
}

/**
 * Get the registry's content type for Prometheus format
 */
export function getMetricsContentType(): string {
  return registry.contentType;
}

