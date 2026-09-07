'use strict';

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const AdmZip = require('adm-zip');

const {
    getApkName,
    getChangelogName,
    releaseExists,
    updateLatestSymlinks,
} = require('./releases');

const REQUIRED_APK = 'app-release.apk';
const REQUIRED_CHANGELOG = 'changelog.md';
const VERSION_MARKER_RE = /^v(\d+)$/;

function isFlatEntryName(name) {
    if (!name || name.includes('/') || name.includes('\\')) return false;
    if (name.includes('..')) return false;
    return true;
}

function findVersionMarker(entries) {
    const markers = entries.filter((name) => VERSION_MARKER_RE.test(name));
    if (markers.length === 0) {
        throw new Error('version marker file missing');
    }
    if (markers.length > 1) {
        throw new Error('multiple version marker files in archive');
    }
    const match = VERSION_MARKER_RE.exec(markers[0]);
    return Number(match[1]);
}

async function removeDir(dir) {
    await fs.promises.rm(dir, { recursive: true, force: true });
}

async function installRelease(extractedDir, androidDir, build) {
    const apkSrc = path.join(extractedDir, REQUIRED_APK);
    const changelogSrc = path.join(extractedDir, REQUIRED_CHANGELOG);

    if (!fs.existsSync(apkSrc)) {
        throw new Error('app-release.apk missing in archive');
    }
    if (!fs.existsSync(changelogSrc)) {
        throw new Error('changelog.md missing in archive');
    }

    if (releaseExists(androidDir, build)) {
        throw new Error(`build v${build} already exists`);
    }

    const apkDest = path.join(androidDir, getApkName(build));
    const changelogDest = path.join(androidDir, getChangelogName(build));

    await fs.promises.rename(apkSrc, apkDest);
    await fs.promises.rename(changelogSrc, changelogDest);
    await updateLatestSymlinks(androidDir, build);

    return {
        build,
        version: `v${build}`,
        apk: getApkName(build),
        changelog: getChangelogName(build),
    };
}

async function ingestZip(zipPath, androidDir, tempRoot) {
    const extractDir = path.join(tempRoot, 'extracted');
    await fs.promises.mkdir(extractDir, { recursive: true });

    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();

    const names = [];
    for (const entry of entries) {
        if (entry.isDirectory) {
            throw new Error('nested directories are not allowed');
        }
        const name = entry.entryName;
        if (!isFlatEntryName(name)) {
            throw new Error('nested paths are not allowed in archive');
        }
        names.push(name);
    }

    if (!names.includes(REQUIRED_APK)) {
        throw new Error('app-release.apk missing in archive');
    }
    if (!names.includes(REQUIRED_CHANGELOG)) {
        throw new Error('changelog.md missing in archive');
    }

    const build = findVersionMarker(names);
    zip.extractAllTo(extractDir, false);

    const markerName = `v${build}`;
    const markerPath = path.join(extractDir, markerName);
    if (fs.existsSync(markerPath)) {
        await fs.promises.unlink(markerPath);
    }

    return installRelease(extractDir, androidDir, build);
}

async function streamRequestToFile(req, destPath, maxBytes) {
    const { Transform } = require('stream');
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

    let written = 0;
    const limiter = new Transform({
        transform(chunk, encoding, callback) {
            written += chunk.length;
            if (written > maxBytes) {
                callback(new Error('upload too large'));
                return;
            }
            callback(null, chunk);
        },
    });
    const out = fs.createWriteStream(destPath);

    try {
        await pipeline(req, limiter, out);
        return written;
    } catch (err) {
        out.destroy();
        try {
            await fs.promises.unlink(destPath);
        } catch (e) {
            if (e.code !== 'ENOENT') {
                console.error('[app_manager] failed to remove partial upload:', e.message);
            }
        }
        throw err;
    }
}

module.exports = {
    ingestZip,
    streamRequestToFile,
    removeDir,
};
