const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Chrome descargado localmente dentro del proyecto
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
