import { Request, Response } from 'express';
import mongoose from 'mongoose';

/**
 * Handles system health check. GET /health
 */
export const healthController = async (_req: Request, res: Response): Promise<void> => {
  const startTime = Date.now();
  let dbStatus: 'ok' | 'fail' = 'ok';

  // 1. Check DB Connection State
  try {
    if (mongoose.connection.readyState !== 1) {
      // 1 = connected
      // Attempt to ping if not ready
      if (mongoose.connection.db) {
        await mongoose.connection.db.admin().ping();
      } else {
        throw new Error('Database not initialized');
      }
    }
  } catch (error) {
    dbStatus = 'fail';
    console.error('Health Check: DB connection failed.', error);
  }

  // 2. Compute Latency and Uptime
  const latencyMs = Date.now() - startTime;
  const uptime = process.uptime(); // Node.js process uptime in seconds

  // 3. Success Response (200 OK) or degraded (500)
  const status = dbStatus === 'ok' ? 'ok' : 'degraded';
  const statusCode = dbStatus === 'ok' ? 200 : 500;

  // Clean response structure
  res.status(statusCode).json({
    status: status,
    db: dbStatus,
    service: 'OpenShow Backend',
    uptimeSeconds: Math.floor(uptime),
    responseTimeMs: latencyMs,
    date: new Date().toISOString(),
  });
};

/**
 * Handles Prometheus/Grafana metrics endpoint. GET /metrics
 */
export const metricsController = async (_req: Request, res: Response): Promise<void> => {
  try {
    // Retrieve all metrics data in Prometheus format
    const { getMetricsRegistry, getMetricsContentType } = await import('../utils/metrics.utility');
    const metrics = await getMetricsRegistry();

    // Success (200 OK) with Prometheus content type
    res.setHeader('Content-Type', getMetricsContentType());
    res.status(200).send(metrics);
  } catch (error) {
    // Should not happen, but a safe 500 response
    console.error('Metrics endpoint error:', error);
    res.status(500).json({
      error: {
        code: 'metrics_fail',
        message: 'Failed to retrieve metrics.',
      },
    });
  }
};

