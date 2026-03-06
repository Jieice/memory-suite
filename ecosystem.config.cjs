module.exports = {
  apps: [
    {
      name: 'memory-universe',
      script: './memory-universe/src/index.ts',
      cwd: './',
      interpreter: 'npx',
      interpreter_args: 'tsx',
      env_file: '.env',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      env: {
        NODE_OPTIONS: '--max-old-space-size=6144',
        USE_LOCAL_LLM: 'false',
        LLM_CLOUD_FIRST: 'true',
        LLM_PREFER_LOCAL: 'false',
        LLM_LOCAL_FALLBACK: 'false'
      }
    }
  ]
};
