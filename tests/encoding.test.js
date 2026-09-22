'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { decodeHtmlCharset, hasReplacementChar } = require('../fusionloom/normalize/encoding');

describe('encoding', () => {
    it('decodes utf-8 html without replacement chars', () => {
        const buf = Buffer.from('<html><meta charset="utf-8">119Л/7К</html>', 'utf8');
        const text = decodeHtmlCharset(buf, 'text/html; charset=utf-8');
        assert.ok(text.includes('119Л/7К'));
        assert.equal(hasReplacementChar(text), false);
    });
});
