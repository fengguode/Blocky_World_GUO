'use strict';
const { start } = require('./server');

start().catch(err => {
  console.error('Could not start Blocky World:', err.message);
  process.exitCode = 1;
});
