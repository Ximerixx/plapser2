'use strict';

const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function getApkName(build) {
    return `v${build}.apk`;
}

function getChangelogName(build) {
    return `v${build}.changelog.md`;
}

function releaseApkPath(androidDir, build) {
    return path.join(androidDir, getApkName(build));
}

function releaseExists(androidDir, build) {
    return fs.existsSync(releaseApkPath(androidDir, build));
}

async function updateSymlink(androidDir, linkName, targetName) {
    const linkPath = path.join(androidDir, linkName);
    try {
        await fs.promises.unlink(linkPath);
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
    }
    await fs.promises.symlink(targetName, linkPath);
}

async function updateLatestSymlinks(androidDir, build) {
    await updateSymlink(androidDir, 'latest.apk', getApkName(build));
    await updateSymlink(androidDir, 'latest.changelog.md', getChangelogName(build));
}

async function getCurrentBuild(androidDir) {
    const linkPath = path.join(androidDir, 'latest.apk');
    try {
        const target = await fs.promises.readlink(linkPath);
        const match = /^v(\d+)\.apk$/.exec(target);
        if (match) return `v${match[1]}`;
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
    }
    return null;
}

module.exports = {
    ensureDir,
    getApkName,
    getChangelogName,
    releaseApkPath,
    releaseExists,
    updateLatestSymlinks,
    getCurrentBuild,
};
