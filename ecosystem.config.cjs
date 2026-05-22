/**
 * PM2 Ecosystem — CRM-Forsage Production
 * Запуск: pm2 start ecosystem.config.cjs
 */
module.exports = {
  apps: [
    {
      name: 'crm-forsage-api',
      script: './server/dist/index.js',
      cwd: './',
      instances: 1,
      exec_mode: 'fork',
      env_production: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
      watch: false,
      max_memory_restart: '512M',
      error_file: './logs/api-error.log',
      out_file: './logs/api-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      restart_delay: 3000,
      max_restarts: 10,
    },
  ],
}
