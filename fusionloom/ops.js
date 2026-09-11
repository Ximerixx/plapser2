'use strict';

const db = require('./fusionloom_db');

module.exports = {
    insertRequestStats: (opts) => db.insertRequestStats(opts),
    getTopRequestedEntities: (sinceDays, limitPerType) => db.getTopRequestedEntities(sinceDays, limitPerType),
    upsertPreloadState: (entities) => db.upsertPreloadState(entities),
    getPreloadStateEntities: () => db.getPreloadStateEntities(),
    updateLastPreloaded: (entityType, entityKey) => db.updateLastPreloaded(entityType, entityKey)
};
