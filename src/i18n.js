'use strict';
// What the bot says to people other than the owner, in their language.
// For now this covers meetings: the participant's link, the choice of reminders, the reminders themselves.
// To add a language: one more block in S with the same keys, a name in LANGS, month names in MON.
const LANGS = { ru: 'Русский', en: 'English' };
const ORDER = ['ru', 'en'];
const MON = {
  ru: ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};
const pluralRu = (n, a, b, c) => { const m = n % 100, k = n % 10; return m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c; };
const S = {
  ru: {
    meeting: 'Встреча',
    tbd: 'дата уточняется',
    rules: { 5: 'за 5 минут', 15: 'за 15 минут', 60: 'за час', 1440: 'за день' },
    will: (when) => 'Напомню ' + when + '.',
    off: 'Напоминания выключены.',
    link5: 'Ссылку на созвон пришлю за 5 минут до начала.',
    choose: 'Кнопками ниже можно выбрать, когда напоминать.',
    gone: 'Эта ссылка на встречу больше не действует. Попросите у организатора новую.',
    goneShort: 'Эта встреча больше не доступна',
    on: (when) => 'Напомню ' + when,
    removed: 'Напоминание убрано',
    langBtn: '🌐 Язык',
    saved: 'Язык: русский',
    link: 'Ссылка',
    mine: 'Напоминать мне лично',
    before(m) {
      if (m % 1440 === 0) { const d = m / 1440; return 'Через ' + d + ' ' + pluralRu(d, 'день', 'дня', 'дней'); }
      if (m % 60 === 0) { const h = m / 60; return 'Через ' + h + ' ' + pluralRu(h, 'час', 'часа', 'часов'); }
      return 'Через ' + m + ' ' + pluralRu(m, 'минуту', 'минуты', 'минут');
    },
    day: (d) => +d.slice(8, 10) + ' ' + MON.ru[+d.slice(5, 7) - 1],
  },
  en: {
    meeting: 'Meeting',
    tbd: 'date to be confirmed',
    rules: { 5: '5 minutes before', 15: '15 minutes before', 60: '1 hour before', 1440: '1 day before' },
    will: (when) => "I'll remind you " + when + '.',
    off: 'Reminders are off.',
    link5: "I'll send the call link 5 minutes before the start.",
    choose: 'Use the buttons below to choose when to be reminded.',
    gone: 'This meeting link no longer works. Please ask the organizer for a new one.',
    goneShort: 'This meeting is no longer available',
    on: (when) => "I'll remind you " + when,
    removed: 'Reminder removed',
    langBtn: '🌐 Language',
    saved: 'Language: English',
    link: 'Link',
    mine: 'Remind me personally',
    before(m) {
      const one = (n, w) => 'In ' + n + ' ' + w + (n === 1 ? '' : 's');
      if (m % 1440 === 0) return one(m / 1440, 'day');
      if (m % 60 === 0) return one(m / 60, 'hour');
      return one(m, 'minute');
    },
    day: (d) => MON.en[+d.slice(5, 7) - 1] + ' ' + +d.slice(8, 10),
  },
};
const ok = (lang) => Object.prototype.hasOwnProperty.call(LANGS, String(lang || ''));
const of = (lang) => S[ok(lang) ? lang : 'ru'];
// The likely language of a person, from the language of their Telegram app. Only a guess: they can always choose.
const guess = (code) => (/^ru\b/i.test(String(code || '')) ? 'ru' : 'en');
// Languages in the order to offer them: the likely one first.
const offer = (code) => { const g = guess(code); return [g].concat(ORDER.filter((x) => x !== g)); };
const PICK = '🌐 Выберите язык · Choose your language';

module.exports = { LANGS, ORDER, ok, of, guess, offer, PICK };
