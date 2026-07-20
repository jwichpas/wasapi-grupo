const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Reutiliza el chrome ya descargado en el proyecto sistema-erp-nodejs
  cacheDirectory: join(__dirname, '..', 'sistema-erp-nodejs', '.cache', 'puppeteer'),
};
