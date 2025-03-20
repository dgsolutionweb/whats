module.exports = {
  apps: [{
    name: "whatsapp-youtube-mp3-bot",
    script: "index.js",
    watch: false,
    max_memory_restart: "512M",
    env: {
      NODE_ENV: "production",
    },
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    error_file: "logs/error.log",
    out_file: "logs/out.log",
    merge_logs: true,
    restart_delay: 5000,
    max_restarts: 10
  }]
} 