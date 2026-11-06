'use strict';

// Keep mount and HDD file checks out of the Operator event loop.
const path = require('path');
const { createFiles } = require('./recorded-maintenance-files');

process.once('message', async request => {
  let response;
  try {
    const file = await createFiles(request.root, request.config).file(path.resolve(request.root, request.filename));
    response = { ok: true, file: {
      absolute: file.absolute, real: file.real, fingerprint: file.fingerprint, size: file.size
    } };
  } catch (error) {
    response = { ok: false, message: error.publicMessage || error.message || String(error) };
  }
  process.send(response, () => process.exit(response.ok ? 0 : 1));
});
