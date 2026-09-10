const fs = require('node:fs');

// Installer tests need an owned process independent of CI stdin lifetime.
const stopFile = process.argv[2];
if (!stopFile) throw new Error('An owned stop-file path is required.');
setInterval(() => {
  if (fs.existsSync(stopFile)) process.exit(0);
}, 100);
setTimeout(() => {
  console.error('Owned fixture timed out waiting for its stop file.');
  process.exit(2);
}, 10 * 60 * 1000);
console.log('fixture-ready');
