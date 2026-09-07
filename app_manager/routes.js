'use strict';

const path = require('path');
const express = require('express');
const serveIndex = require('serve-index');

const { validateHeaders, verifySignatureFromFile } = require('./auth');
const { ingestZip, streamRequestToFile, removeDir } = require('./ingest');
const { ensureDir, getCurrentBuild } = require('./releases');
const uploadStatus = require('./uploadStatus');

function createRoutes(config) {
    const router = express.Router();
    const maxBytes = config.uploadMaxMb * 1024 * 1024;

    router.get(config.routes.uploadStatus, (req, res) => {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(uploadStatus.getStatus());
    });

    router.get(config.routes.current, async (req, res) => {
        try {
            const build = await getCurrentBuild(config.androidDir);
            if (!build) {
                return res.status(404).type('text/plain').send('no releases');
            }
            res.setHeader('Cache-Control', 'no-cache');
            res.type('text/plain').send(build);
        } catch (e) {
            console.error('[app_manager] current failed:', e);
            res.status(500).type('text/plain').send('error');
        }
    });

    router.post(config.routes.uploadAndroid, async (req, res) => {
        if (!uploadStatus.tryBeginUpload()) {
            return res.status(409).json({ error: 'upload pipeline busy' });
        }

        if (!Object.keys(config.uploadKeys).length) {
            uploadStatus.setError('upload keys not configured');
            return res.status(503).json({ error: 'upload keys not configured' });
        }

        const headerCheck = validateHeaders(req, config);
        if (!headerCheck.ok) {
            uploadStatus.setError(headerCheck.message);
            return res.status(headerCheck.status).json({ error: headerCheck.message });
        }

        uploadStatus.setStatus(headerCheck.statusText);

        const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const workDir = path.join(config.tempDir, uploadId);
        const zipPath = path.join(workDir, 'upload.zip');

        try {
            await streamRequestToFile(req, zipPath, maxBytes);
            uploadStatus.setStatus('Got the ZIP');

            const sigCheck = await verifySignatureFromFile(
                zipPath,
                headerCheck.keyId,
                headerCheck.timestamp,
                headerCheck.signature,
                headerCheck.publicKeyPath
            );
            if (!sigCheck.ok) {
                uploadStatus.setError(sigCheck.message);
                return res.status(403).json({ error: sigCheck.message });
            }
            uploadStatus.setStatus('verified ZIP');

            uploadStatus.setStatus('installing');
            const result = await ingestZip(zipPath, config.androidDir, workDir);

            uploadStatus.setStatus('done');
            return res.json({
                build: result.build,
                version: result.version,
                status: 'done',
                files: {
                    apk: result.apk,
                    changelog: result.changelog,
                },
            });
        } catch (e) {
            console.error('[app_manager] upload failed:', e);
            const message = e.message || 'upload failed';
            uploadStatus.setError(message);
            const statusCode = message.includes('already exists') ? 409 : 400;
            return res.status(statusCode).json({ error: message });
        } finally {
            await removeDir(workDir).catch((e) => {
                console.error('[app_manager] temp cleanup failed:', e.message);
            });
        }
    });

    return router;
}

function mountStaticAndroid(app, config) {
    ensureDir(config.androidDir);

    app.use(
        config.routes.staticAndroid,
        serveIndex(config.androidDir, { icons: false }),
        express.static(config.androidDir, {
            setHeaders: (res, filePath) => {
                if (filePath.endsWith('.apk')) {
                    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
                }
                if (path.basename(filePath).startsWith('latest.')) {
                    res.setHeader('Cache-Control', 'no-cache');
                }
            },
        })
    );
}

module.exports = {
    createRoutes,
    mountStaticAndroid,
};
