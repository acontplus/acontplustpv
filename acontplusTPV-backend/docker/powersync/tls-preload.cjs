'use strict';
const fs = require('node:fs');
const tls = require('node:tls');
const insecure = process.env.PS_TLS_INSECURE === '1';
const caPath = process.env.PS_EXTRA_CA_PATH || '';
let extraCa = null;
if (caPath) {
  try {
    extraCa = fs.readFileSync(caPath, 'utf8');
    console.log('[tls-preload] CA cargada desde: ' + caPath);
  } catch (err) {
    console.warn('[tls-preload] Error CA: ' + err.message);
  }
}
const orig = tls.connect.bind(tls);
tls.connect = function() {
  const args = Array.from(arguments);
  let opts = null;
  if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
    opts = args[0];
  } else {
    for (let i = 1; i < args.length; i++) {
      if (typeof args[i] === 'object' && args[i] !== null) { opts = args[i]; break; }
    }
    if (!opts) {
      opts = {};
      const at = typeof args[args.length-1] === 'function' ? args.length-1 : args.length;
      args.splice(at, 0, opts);
    }
  }
  if (extraCa) {
    if (!opts.ca) opts.ca = extraCa;
    else if (Array.isArray(opts.ca)) opts.ca = opts.ca.concat([extraCa]);
    else opts.ca = [opts.ca, extraCa];
  }
  if (insecure) opts.rejectUnauthorized = false;
  return orig.apply(this, args);
};
console.log('[tls-preload] activo insecure=' + (insecure ? 'ON' : 'OFF'));
