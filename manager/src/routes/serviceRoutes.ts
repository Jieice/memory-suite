import { Router } from 'express';
import { ServiceController } from '../controllers/ServiceController';
import { services } from '../config/services';

const router = Router();
const controller = new ServiceController(services);

// Service management routes
router.get('/api/services', (req, res) => controller.listServices(req, res));
router.get('/api/services/:id/logs', (req, res) => controller.getServiceLogs(req, res));
router.post('/api/services/:id/start', (req, res) => controller.startService(req, res));
router.post('/api/services/:id/stop', (req, res) => controller.stopService(req, res));
router.post('/api/services/start-all', (req, res) => controller.startAllServices(req, res));
router.post('/api/services/stop-all', (req, res) => controller.stopAllServices(req, res));
router.post('/api/services/force-cleanup', (req, res) => controller.forceCleanup(req, res));

// Health check routes
router.get('/api/services/:id/health', (req, res) => controller.checkServiceHealth(req, res));
router.get('/api/health-check', (req, res) => controller.healthCheck(req, res));
router.get('/health', (req, res) => controller.health(req, res));

export default router;
