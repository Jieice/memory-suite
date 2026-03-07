module.exports = {
  apps: [
    {
      name: 'memory-suite-unified',
      cwd: '.',
      script: 'cmd.exe',
      args: ['/c', 'start-unified.bat'],
      interpreter: 'none',
      env: {
        NODE_ENV: 'production',
        MEMORY_SUITE_URL: process.env.MEMORY_SUITE_URL || 'http://127.0.0.1:8080',
      },
      out_file: './logs/unified-out.log',
      error_file: './logs/unified-error.log',
      autorestart: true,
      max_restarts: 3,
      restart_delay: 3000,
    },
  ],
};
