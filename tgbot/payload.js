'use strict';

/**
 * Inline deep link payload: short keys (en_t, en_k, scpe, l) to fit Telegram limit.
 * Dictionary: entity_type->en_t, entity_key->en_k, scope->scpe, lang->l.
 */
const EN_T = 'en_t';
const EN_K = 'en_k';
const SCPE = 'scpe';
const L = 'l';

function encodePayload({ entityType, entityKey, scope, lang }) {
    const obj = { [EN_T]: entityType, [EN_K]: entityKey, [SCPE]: scope || 'today', [L]: lang || 'ru' };
    const json = JSON.stringify(obj);
    return Buffer.from(json, 'utf8').toString('base64url');
}

function decodePayload(base64url) {
    try {
        const json = Buffer.from(base64url, 'base64url').toString('utf8');
        const obj = JSON.parse(json);
        return {
            entityType: obj[EN_T] || 'group',
            entityKey: obj[EN_K] || '',
            scope: obj[SCPE] || 'today',
            lang: obj[L] || 'ru'
        };
    } catch (e) {
        return null;
    }
}

module.exports = { encodePayload, decodePayload };
