'use strict';

const db = require('./fusionloom_db');

module.exports = {
    getTgSubsByChatId: (chatId) => db.getTgSubsByChatId(chatId),
    addTgGroupSub: (...args) => db.addTgGroupSub(...args),
    removeTgGroupSub: (...args) => db.removeTgGroupSub(...args),
    removeTgGroupSubAll: (chatId) => db.removeTgGroupSubAll(chatId),
    getTgUserSubscriptions: (userId) => db.getTgUserSubscriptions(userId),
    addTgSubscription: (...args) => db.addTgSubscription(...args),
    removeTgSubscription: (...args) => db.removeTgSubscription(...args),
    removeTgSubscriptionAll: (userId) => db.removeTgSubscriptionAll(userId),
    getTgSubscriptionsDueForTime: (hhmm) => db.getTgSubscriptionsDueForTime(hhmm),
    getTgUserLang: (userId) => db.getTgUserLang(userId),
    setTgUserLang: (...args) => db.setTgUserLang(...args),
    getTgChatLang: (chatId) => db.getTgChatLang(chatId),
    setTgChatLang: (...args) => db.setTgChatLang(...args),
    updateTgUserSendTime: (...args) => db.updateTgUserSendTime(...args),
    updateTgChatSendTime: (...args) => db.updateTgChatSendTime(...args),
    toggleTgSubscriptionSilent: (...args) => db.toggleTgSubscriptionSilent(...args),
    setTgSubscriptionSilent: (...args) => db.setTgSubscriptionSilent(...args),
    getOrCreateTgInlineLutId: (...args) => db.getOrCreateTgInlineLutId(...args),
    getTgInlineLutByCode: (code) => db.getTgInlineLutByCode(code)
};
