import { Request, Response } from 'express';
import { BaseController } from '../controllers/BaseController';
import { ServiceService } from '../services/ServiceService';
import { ServiceConfig } from '../types/service';

export class ServiceController extends BaseController {
  private serviceService: ServiceService;

  constructor(services: ServiceConfig) {
    super();
    this.serviceService = new ServiceService(services);
  }

  async listServices(req: Request, res: Response): Promise<void> {
    try {
      const services = this.serviceService.listServices();
      res.json(services);
    } catch (error) {
      this.handleError(error, res);
    }
  }

  async getServiceLogs(req: Request, res: Response): Promise<void> {
    try {
      const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
      const limit = rawLimit ? parseInt(String(rawLimit), 10) : 100;
      const logs = this.serviceService.getServiceLogs(req.params.id, Number.isFinite(limit) ? limit : 100);
      if (!logs) {
        res.status(404).json({ error: 'Service not found' });
        return;
      }
      res.json(logs);
    } catch (error) {
      this.handleError(error, res);
    }
  }

  async startService(req: Request, res: Response): Promise<void> {
    try {
      const success = await this.serviceService.startService(req.params.id);
      res.json({ 
        success, 
        message: success ? 'Service started' : 'Service already running' 
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  async stopService(req: Request, res: Response): Promise<void> {
    try {
      const success = await this.serviceService.stopService(req.params.id);
      res.json({ 
        success, 
        message: success ? 'Service stopped' : 'Service not running' 
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  async startAllServices(req: Request, res: Response): Promise<void> {
    try {
      const results = await this.serviceService.startAllServices();
      res.json({ success: true, results });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  async stopAllServices(req: Request, res: Response): Promise<void> {
    try {
      const results = await this.serviceService.stopAllServices();
      res.json({ success: true, results });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  async forceCleanup(req: Request, res: Response): Promise<void> {
    try {
      const cleanedPorts = await this.serviceService.forceCleanup();
      res.json({ 
        success: true, 
        message: `Cleaned ${cleanedPorts.length} ports`,
        ports: cleanedPorts 
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  async checkServiceHealth(req: Request, res: Response): Promise<void> {
    try {
      const health = await this.serviceService.checkServiceHealth(req.params.id);
      if (!health) {
        res.status(404).json({ error: 'Service not found' });
        return;
      }
      res.json(health);
    } catch (error) {
      this.handleError(error, res);
    }
  }

  async healthCheck(req: Request, res: Response): Promise<void> {
    try {
      const results = await this.serviceService.healthCheck();
      res.json(results);
    } catch (error) {
      this.handleError(error, res);
    }
  }

  async health(req: Request, res: Response): Promise<void> {
    try {
      const status = this.serviceService.getHealthStatus();
      res.json(status);
    } catch (error) {
      this.handleError(error, res);
    }
  }
}
