'use strict';

let statusText = 'idle';
let idleTimer = null;
let doneTtlMs = 300000;

function clearIdleTimer() {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
}

function scheduleIdle() {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
        statusText = 'idle';
        idleTimer = null;
    }, doneTtlMs);
}

function configure({ statusDoneTtlMs }) {
    if (statusDoneTtlMs) doneTtlMs = statusDoneTtlMs;
}

function getStatus() {
    return statusText;
}

function isIdle() {
    return statusText === 'idle';
}

function setStatus(text) {
    statusText = text;
    if (text === 'done' || text.startsWith('error:')) {
        scheduleIdle();
    } else {
        clearIdleTimer();
    }
}

function tryBeginUpload() {
    if (!isIdle()) return false;
    clearIdleTimer();
    return true;
}

function setError(message) {
    setStatus(`error: ${message}`);
}

module.exports = {
    configure,
    getStatus,
    isIdle,
    setStatus,
    tryBeginUpload,
    setError,
};
