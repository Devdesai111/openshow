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
export const metricsController = (_req: Request, res: Response): void => {
  // PRODUCTION: This would typically be protected by IP/Internal Auth and served by a library like 'prom-client'.
  // For now, return a simple text-based placeholder (Prometheus format).
  res.setHeader('Content-Type', 'text/plain');

  const simpleMetrics = `# HELP node_uptime_seconds Uptime of the Node.js process.
# TYPE node_uptime_seconds gauge
node_uptime_seconds ${process.uptime()}

# HELP custom_http_requests_total Total number of processed HTTP requests.
# TYPE custom_http_requests_total counter
custom_http_requests_total 1500

# HELP custom_db_connection_status Status of the database connection (1=ok, 0=fail).
# TYPE custom_db_connection_status gauge
custom_db_connection_status ${mongoose.connection.readyState === 1 ? 1 : 0}
`;
  res.status(200).send(simpleMetrics);
};

