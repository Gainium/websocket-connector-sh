/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('path')
const { workerData } = require('worker_threads')

if (workerData.path.indexOf('.ts') !== -1) {
  require('ts-node').register()
}
require(path.resolve(__dirname, workerData.path))
