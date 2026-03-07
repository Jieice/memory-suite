import { ServiceService } from './ServiceService';
import { ServiceConfig } from '../types/service';

describe('ServiceService unified runtime cleanup', () => {
  const services: ServiceConfig = {
    live2d: {
      name: 'Live2D',
      port: 8080,
      cwd: '.',
      command: 'cargo',
      args: ['run', '-p', 'daemon'],
      status: 'running',
      logs: [
        {
          type: 'stdout',
          message: 'live2d now runs through unified daemon',
          timestamp: new Date().toISOString(),
        },
      ],
    },
  };

  it('does not include retired standalone live2d or danmaku ports in force cleanup', async () => {
    const service = new ServiceService(services);

    await expect(service.forceCleanup()).resolves.toEqual(
      expect.not.arrayContaining([4002, 4003, 4005]),
    );
  });

  it('falls back to in-memory logs for live2d instead of legacy file paths', () => {
    const service = new ServiceService(services);
    const logs = service.getServiceLogs('live2d');

    expect(logs).toEqual(services.live2d?.logs);
  });
});
