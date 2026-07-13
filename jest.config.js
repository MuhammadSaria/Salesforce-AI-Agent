const { jestConfig } = require('@salesforce/sfdx-lwc-jest/config');

module.exports = {
    ...jestConfig,
    testMatch: ['<rootDir>/force-app/**/__tests__/**/*.test.js']
};
