const playwright = require('playwright');

/**
 * @returns {import('..').Plugin}
 */
module.exports = async function() {
  return {
    async launchPersistentContext(browserName, userDataDir, launchOptions) {
      const context = await playwright[browserName].launchPersistentContext(userDataDir, launchOptions);
      await context.addInitScript(() => {
        Math.random = () => 42;
      });
      return context;
    },
  };
}
