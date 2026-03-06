const axios = require('axios');

async function checkServices() {
    const services = [
        { name: 'Agent Core', url: 'http://localhost:4008/health' },
        { name: 'Memory System', url: 'http://localhost:4009/health' },
        { name: 'Neuro-Symbolic', url: 'http://localhost:4010/health' },
        { name: 'Reflection Engine', url: 'http://localhost:4011/health' },
        { name: 'Prediction Engine', url: 'http://localhost:4012/health' },
        { name: 'BrainNN', url: 'http://localhost:4007/health' },
        { name: 'Memory Universe', url: 'http://localhost:4005/health' },
    ];
    
    console.log('检查 BrainNN 依赖服务状态:\n');
    
    for (const service of services) {
        const start = Date.now();
        try {
            const resp = await axios.get(service.url, { timeout: 2000 });
            const elapsed = Date.now() - start;
            console.log(`✅ ${service.name}: ${elapsed}ms - ${JSON.stringify(resp.data)}`);
        } catch (error) {
            const elapsed = Date.now() - start;
            console.log(`❌ ${service.name}: ${elapsed}ms - ${error.message}`);
        }
    }
}

checkServices();
