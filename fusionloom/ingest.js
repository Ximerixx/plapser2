'use strict';

const db = require('./fusionloom_db');
const fuse = require('./fuse');

function ingestWeek({ viewType, viewKey, anchorDate, parsedWeek, requestStatsId }) {
    if (!parsedWeek || typeof parsedWeek !== 'object') return null;
    if (!viewType || !viewKey || !anchorDate) return null;

    const batchId = db.insertIngestBatch({
        viewType,
        viewKey,
        anchorDate,
        requestStatsId
    });

    db.runInTransaction(() => {
        for (const dateKey of Object.keys(parsedWeek)) {
            const day = parsedWeek[dateKey];
            const lessons = day?.lessons || [];
            const hasNoLessons = lessons.length === 1 && lessons[0].status === 'Нет пар';
            if (hasNoLessons) {
                db.upsertScheduleMeta(viewType, viewKey, dateKey, true, batchId);
                continue;
            }
            db.upsertScheduleMeta(viewType, viewKey, dateKey, false, batchId);
            for (const lesson of lessons) {
                fuse.mergeLessonObservation(batchId, dateKey, lesson, viewType, viewKey);
            }
        }
    });

    return batchId;
}

module.exports = { ingestWeek };
