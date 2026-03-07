const axios = require('axios');

async function checkServices() {
  const services = [
    { name: 'Unified Runtime Health', url: 'http://localhost:8080/api/health' },
    { name: 'Runtime Overview', url: 'http://localhost:8080/api/runtime/overview' },
    { name: 'Live2D State', url: 'http://localhost:8080/api/live2d/state' },
    { name: 'Danmaku State', url: 'http://localhost:8080/api/danmaku/state' },
    { name: 'BrainNN', url: 'http://localhost:4007/health' },
  ];

  console.log('Checking unified runtime surfaces and optional Python services...\n');

  for (const service of services) {
    const start = Date.now();
    try {
      const resp = await axios.get(service.url, { timeout: 2000 });
      const elapsed = Date.now() - start;
      console.log(`OK ${service.name}: ${elapsed}ms - ${JSON.stringify(resp.data)}`);
    } catch (error) {
      const elapsed = Date.now() - start;
      console.log(`FAIL ${service.name}: ${elapsed}ms - ${error.message}`);
    }
  }
}

checkServices();
