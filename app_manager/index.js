'use strict';

const fs = require('fs');
const { loadAppManagerConfig } = require('./config.loader');
const { ensureDir } = require('./releases');
const uploadStatus = require('./uploadStatus');
const { createRoutes, mountStaticAndroid } = require('./routes');

function mountAppManager(app) {
    const config = loadAppManagerConfig();

    ensureDir(config.tempDir);
    ensureDir(config.androidDir);

    uploadStatus.configure({ statusDoneTtlMs: config.statusDoneTtlMs });

    const hasKeys = Object.keys(config.uploadKeys).length > 0;
    if (!hasKeys) {
        console.warn('[app_manager] no upload keys configured; POST upload will return 503');
    } else {
        console.log(`[app_manager] upload keys: ${Object.keys(config.uploadKeys).join(', ')}`);
    }

    app.use(createRoutes(config));
    mountStaticAndroid(app, config);

    console.log('[app_manager] mounted routes:', config.routes);
}

module.exports = {
    mountAppManager,
    loadAppManagerConfig,
};
