import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { connectDatabase } from './config/database';
import { env } from './config/env';
import authRoutes from './routes/auth.routes';
import userProfileRoutes from './routes/userProfile.routes';
import discoveryRoutes from './routes/discovery.routes';
import notificationRoutes from './routes/notification.routes';
import projectRoutes from './routes/project.routes';
import collaborationRoutes from './routes/collaboration.routes';
import assetRoutes from './routes/asset.routes';
import agreementRoutes from './routes/agreement.routes';
import verificationRoutes from './routes/verification.routes';
import revenueRoutes from './routes/revenue.routes';
import utilityRoutes from './routes/utility.routes';

const app: Application = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/auth', authRoutes);
app.use('/users', userProfileRoutes);
app.use('/market', discoveryRoutes); // Marketplace/Discovery routes (Task 10, 16)
app.use('/notifications', notificationRoutes);
app.use('/projects', projectRoutes);
app.use('/projects', collaborationRoutes); // Collaboration routes (Task 17)
app.use('/projects', agreementRoutes); // Agreement routes (Task 21)
app.use('/agreements', agreementRoutes); // Agreement signing routes (Task 26) - shares same router
app.use('/assets', assetRoutes); // Asset upload routes (Task 19)
app.use('/verification', verificationRoutes); // Verification routes (Task 24)
app.use('/revenue', revenueRoutes); // Revenue calculation routes (Task 31)
app.use('/', utilityRoutes); // Health and metrics at root level

// Start server
async function startServer(): Promise<void> {
  try {
    // Connect to database
    await connectDatabase();

    // Start listening
    app.listen(env.PORT, () => {
      console.warn(`🚀 Server running on port ${env.PORT}`);
      console.warn(`🌍 Environment: ${env.NODE_ENV}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

export default app;
