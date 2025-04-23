const playwright = require('playwright');

/**
 * @returns {import('..').Plugin}
 */
module.exports = async function() {
  return {
    async createBrowserContext(browserName, launchOptions) {
      const browser = await playwright[browserName].launch(launchOptions);
      const context = await browser.newContext();
      await context.addInitScript(() => {
        Math.random = () => 42;
      });
      return context;
    },
  };
}
