'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const server = require('../server');

assert.equal(typeof server.start, 'function', 'server.js exports its start function for the launcher');

const source = fs.readFileSync(path.join(__dirname, '..', 'serve.js'), 'utf8');
let starts = 0;
let catchHandler;
const logged = [];
const processStub = { exitCode: 0 };
const context = {
  require(id) {
    assert.equal(id, './server');
    return {
      start() {
        starts++;
        return { catch(handler) { catchHandler = handler; } };
      },
    };
  },
  console: { error(...args) { logged.push(args); } },
  process: processStub,
};

vm.runInNewContext(source, context, { filename: 'serve.js' });
assert.equal(starts, 1, 'serve.js invokes the exported server start function once');
assert.equal(typeof catchHandler, 'function', 'serve.js handles startup failures');
const failure = new Error('fixture failure');
catchHandler(failure);
assert.deepEqual(logged, [['Could not start Blocky World:', 'fixture failure']]);
assert.equal(processStub.exitCode, 1);

console.log('Server launcher tests passed (start invocation, startup failure reporting).');
