module.exports = {
  apps: [{
    name: 'carl-superchat',
    cwd: __dirname,
    script: 'server.js',
    interpreter: 'node',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      PORT: 3010,
    },
  }],
};
