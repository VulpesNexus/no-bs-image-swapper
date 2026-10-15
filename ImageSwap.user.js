// ==UserScript==
// @name         Image Swap
// @namespace    https://example.invalid/image-swap
// @version      1.5.1
// @description  Persistent image replacement with named rules, reusable settings, overlap warnings, and live previews.
// @author       Local
// @match        *://*/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_addValueChangeListener
// ==/UserScript==

(() => {
  'use strict';

  // Settings stay on the v1 key so existing rules survive upgrades.
  // Uploaded image bytes live in separate script-manager storage keys, not site storage.
  const STORAGE_KEY = 'image-swap-settings-v1';
  const ASSET_PREFIX = 'image-swap-upload-v1:';
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // Per upload (10 MiB).
  const MAX_TOTAL_BYTES = 48 * 1024 * 1024; // All uploads (48 MiB).
  const MIME_BY_EXTENSION = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
    svg: 'image/svg+xml', ico: 'image/x-icon'
  };
  const ALLOWED_IMAGE_TYPES = new Set(Object.values(MIME_BY_EXTENSION));

  function storedAssetId(value) {
    const match = /^asset:([a-zA-Z0-9_-]+)$/.exec(value || '');
    return match ? match[1] : null;
  }

  function bytesText(bytes) {
    if (!bytes) return '0 KiB';
    return bytes >= 1024 * 1024
      ? (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '') + ' MiB'
      : Math.max(1, Math.round(bytes / 1024)) + ' KiB';
  }

  const XLINK_NS = 'http://www.w3.org/1999/xlink';
  const IMAGE_SELECTOR = 'img, input[type="image"], svg image';
  const IMAGE_ATTRS = ['src', 'srcset', 'data-src', 'data-srcset', 'data-original', 'data-lazy-src'];
  const BG_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi;
  const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const FIT_MODES = ['original', 'contain', 'cover', 'fill', 'scale-down', 'none'];
  const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
    'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion',
    'hue', 'saturation', 'color', 'luminosity'];
  const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
  const defaults = { enabled: true, showButton: false, buttonCorner: 'bottom-right',
    uiPreferencesVersion: 2, theme: 'auto', rules: [], assets: [] };

  const plural = (count, word) => count + ' ' + word + (count === 1 ? '' : 's');

  function ruleLabel(rule) {
    return typeof rule.name === 'string' && rule.name.trim()
      ? rule.name.trim() : (rule.mode === 'selector' ? rule.selector : rule.pattern);
  }

  function embeddedImageText(value) {
    const mime = /^data:([^;,]*)/i.exec(value)?.[1];
    return 'Embedded image' + (mime ? ' (' + mime + ')' : '');
  }

  // Visible saved-rule title. An unnamed URL rule shows the file name instead of
  // its full matching URL, which stays available from the hostname hint.
  function ruleTitle(rule) {
    if (rule.name?.trim() || rule.mode !== 'url') return ruleLabel(rule);
    const pattern = rule.pattern.trim();
    if (/^data:/i.test(pattern)) return embeddedImageText(pattern);
    const path = pattern.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').split(/[?#]/)[0];
    const file = path.split('/').filter(Boolean).pop();
    if (!file) return 'Image';
    try { return decodeURIComponent(file); } catch { return file; }
  }

  function numericSetting(value, fallback, min, max) {
    if (value === '' || value === null || value === undefined) return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }

  function normalizeAppearance(value) {
    const a = value && typeof value === 'object' ? value : {};
    return {
      fit: FIT_MODES.includes(a.fit) ? a.fit : 'original',
      x: numericSetting(a.x, 50, 0, 100),
      y: numericSetting(a.y, 50, 0, 100),
      blend: BLEND_MODES.includes(a.blend) ? a.blend : 'normal',
      opacity: numericSetting(a.opacity, 100, 0, 100),
      width: numericSetting(a.width, 0, 0, 10000),
      height: numericSetting(a.height, 0, 0, 10000),
      maxWidth: numericSetting(a.maxWidth, 0, 0, 10000),
      maxHeight: numericSetting(a.maxHeight, 0, 0, 10000)
    };
  }

  function validClock(value) {
    return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  }

  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value)) return false;
    const [y, m, d] = value.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  }

  function normalizeSchedule(value) {
    const c = value && typeof value === 'object' ? value : {};
    return {
      enabled: c.enabled === true,
      start: validClock(c.start) ? c.start : '09:00',
      end: validClock(c.end) ? c.end : '17:00',
      timezone: c.timezone === 'utc' ? 'utc' : 'local',
      days: Array.isArray(c.days) ? ALL_WEEKDAYS.filter(day => c.days.includes(day)) : [...ALL_WEEKDAYS],
      from: validDate(c.from) ? c.from : '',
      until: validDate(c.until) ? c.until : ''
    };
  }

  function timeInMinutes(value) {
    const [hour, minute] = value.split(':').map(Number);
    return 60 * hour + minute;
  }

  function scheduleMatches(rawSchedule, now = new Date()) {
    const schedule = normalizeSchedule(rawSchedule);
    if (!schedule.enabled) return true;
    if (!schedule.days.length) return false;
    const utc = schedule.timezone === 'utc';
    const minutes = 60 * (utc ? now.getUTCHours() : now.getHours()) +
      (utc ? now.getUTCMinutes() : now.getMinutes());
    const start = timeInMinutes(schedule.start);
    const end = timeInMinutes(schedule.end);
    // End is exclusive. Equal endpoints mean an all-day window.
    // For overnight windows, early-morning time belongs to the previous start day.
    let previousDay = false;
    if (start < end) {
      if (minutes < start || minutes >= end) return false;
    } else if (start > end) {
      if (minutes >= start) previousDay = false;
      else if (minutes < end) previousDay = true;
      else return false;
    }
    const y = utc ? now.getUTCFullYear() : now.getFullYear();
    const m = utc ? now.getUTCMonth() : now.getMonth();
    const d = utc ? now.getUTCDate() : now.getDate();
    const dayDate = previousDay ? (utc ? new Date(Date.UTC(y, m, d - 1)) : new Date(y, m, d - 1)) : now;
    const weekday = utc ? dayDate.getUTCDay() : dayDate.getDay();
    if (!schedule.days.includes(weekday)) return false;
    const year = utc ? dayDate.getUTCFullYear() : dayDate.getFullYear();
    const month = (utc ? dayDate.getUTCMonth() : dayDate.getMonth()) + 1;
    const date = utc ? dayDate.getUTCDate() : dayDate.getDate();
    const dayKey = String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') +
      '-' + String(date).padStart(2, '0');
    return (!schedule.from || dayKey >= schedule.from) && (!schedule.until || dayKey <= schedule.until);
  }

  // Saved-rule summaries use 12-hour clock text with AM/PM; stored values stay HH:MM.
  function clockText(value) {
    const [hour, minute] = value.split(':').map(Number);
    return (hour % 12 || 12) + ':' + String(minute).padStart(2, '0') + ' ' + (hour < 12 ? 'AM' : 'PM');
  }

  const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function scheduleText(rawSchedule) {
    const c = normalizeSchedule(rawSchedule);
    const hours = c.start === c.end ? 'All day' : clockText(c.start) + '–' + clockText(c.end);
    const parts = [hours + ' (' + (c.timezone === 'utc' ? 'UTC' : 'local time') + ')'];
    if (c.days.length < 7) {
      // Weeks read Monday first, matching the editor's checkboxes.
      parts.push(c.days.length ? [1, 2, 3, 4, 5, 6, 0].filter(day => c.days.includes(day))
        .map(day => WEEKDAY_NAMES[day]).join(', ') : 'No days');
    }
    if (c.from && c.until) parts.push(c.from === c.until ? 'On ' + c.from : c.from + ' to ' + c.until);
    else if (c.from) parts.push('From ' + c.from);
    else if (c.until) parts.push('Until ' + c.until);
    return parts.join(' · ');
  }

  // This is deliberately conservative: the intent is to warn about likely
  // shadowed rules, not to prohibit legitimately layered replacements.
  // Two globs with compatible fixed prefixes and suffixes may intersect; we
  // report these as possible rather than claiming an exact match.
  function globsMayIntersect(a, b, ignoreCase = false) {
    if (ignoreCase) { a = a.toLowerCase(); b = b.toLowerCase(); }
    if (a === b) return { overlaps: true, certain: true };
    if (!a.includes('*') || !b.includes('*')) {
      const fixed = a.includes('*') ? b : a;
      const pattern = a.includes('*') ? a : b;
      return { overlaps: globRegex(pattern).test(fixed), certain: true };
    }
    const startA = a.split('*')[0], startB = b.split('*')[0];
    const endA = a.slice(a.lastIndexOf('*') + 1);
    const endB = b.slice(b.lastIndexOf('*') + 1);
    const compatible = (x, y) => x.startsWith(y) || y.startsWith(x);
    return { overlaps: compatible(startA, startB) && compatible(endA, endB), certain: false };
  }

  function scheduleMayIntersect(aRaw, bRaw) {
    const a = normalizeSchedule(aRaw), b = normalizeSchedule(bRaw);
    if ((a.enabled && !a.days.length) || (b.enabled && !b.days.length))
      return { overlaps: false, certain: true };
    if (!a.enabled || !b.enabled) return { overlaps: true, certain: true };
    const ordinal = key => key ? Math.floor(Date.parse(key + 'T00:00:00Z') / 86400000) : null;
    const from = Math.max(ordinal(a.from) ?? -Infinity, ordinal(b.from) ?? -Infinity);
    const until = Math.min(ordinal(a.until) ?? Infinity, ordinal(b.until) ?? Infinity);
    // An overnight interval can start on one day and end on the next.
    if (until < from - 1) return { overlaps: false, certain: true };
    if (a.timezone !== b.timezone) {
      // Different time zones, including DST changes, prevent a simple reliable
      // clock comparison. This is a possible overlap, not a definite one.
      return { overlaps: true, certain: false };
    }
    // The two schedules share a civil clock. Examine at least two weeks of
    // possible occurrences; weekly patterns repeat after seven days.
    const anchor = Number.isFinite(from) ? from - 2 :
      Number.isFinite(until) ? until - 15 : Math.floor(Date.parse('2026-01-05T00:00:00Z') / 86400000);
    const endDay = Number.isFinite(until) ? Math.min(anchor + 19, until + 2) : anchor + 19;
    function intervals(c) {
      const result = [];
      const earliest = ordinal(c.from) ?? -Infinity;
      const latest = ordinal(c.until) ?? Infinity;
      let start = timeInMinutes(c.start), end = timeInMinutes(c.end);
      if (end <= start) end += 1440; // Equal endpoints represent all day.
      for (let day = anchor; day <= endDay; day++) {
        if (day < earliest || day > latest) continue;
        const weekday = new Date(day * 86400000).getUTCDay();
        if (c.days.includes(weekday)) result.push([day * 1440 + start, day * 1440 + end]);
      }
      return result;
    }
    const aa = intervals(a), bb = intervals(b);
    return { overlaps: aa.some(([s, e]) => bb.some(([t, u]) => s < u && t < e)), certain: true };
  }

  function targetsMayIntersect(a, b) {
    if (a.mode === 'url' && b.mode === 'url') {
      return globsMayIntersect(normalizedPattern(a.pattern), normalizedPattern(b.pattern));
    }
    if (a.mode === 'selector' && b.mode === 'selector') {
      if (a.selector.trim() === b.selector.trim()) return { overlaps: true, certain: true };
      // Distinct selectors can target the same element. Check the current page,
      // but do not warn about hypothetical matches without supporting evidence.
      try {
        const sa = pseudoSelectorInfo(a.selector), sb = pseudoSelectorInfo(b.selector);
        if ((sa?.pseudo || '') !== (sb?.pseudo || '')) return { overlaps: false, certain: true };
        const nodes = document.querySelectorAll(sa ? sa.base : a.selector);
        const found = [...nodes].some(node => node.matches(sb ? sb.base : b.selector));
        return { overlaps: found, certain: false };
      } catch { return { overlaps: false, certain: false }; }
    }
    // A selector can match a resource matched by a URL rule. Warn if an
    // intersection is actually visible on this page, rather than for all mixed
    // rules on the same website.
    const selectorRule = a.mode === 'selector' ? a : b;
    const urlRule = a.mode === 'url' ? a : b;
    try {
      const info = pseudoSelectorInfo(selectorRule.selector);
      if (info) return { overlaps: false, certain: false };
      const pattern = globRegex(normalizedPattern(urlRule.pattern));
      for (const element of document.querySelectorAll(selectorRule.selector)) {
        const entry = overrides.get(element);
        const originalURLs = entry?.kind === 'attribute'
          ? [entry.source, ...entry.records.map(rec => rec.original)].filter(Boolean)
          : imageURLs(element);
        const background = entry?.kind === 'background' ? entry.originalComputed :
          getComputedStyle(element).backgroundImage;
        if (originalURLs.some(url => pattern.test(normalizedURL(url))) ||
            urlsInBackground(background).some(url => pattern.test(normalizedURL(url)))) {
          return { overlaps: true, certain: false };
        }
      }
    } catch { /* An invalid or unmatched selector is not a conflict. */ }
    return { overlaps: false, certain: false };
  }

  function findRuleConflicts(candidate) {
    if (candidate.enabled === false) return [];
    const results = [];
    for (let index = 0; index < settings.rules.length; index++) {
      const other = settings.rules[index];
      if (other.id === candidate.id || other.enabled === false) continue;
      const scope = globsMayIntersect(candidate.scope, other.scope, true);
      if (!scope.overlaps) continue;
      const target = targetsMayIntersect(candidate, other);
      if (!target.overlaps) continue;
      const schedule = scheduleMayIntersect(candidate.schedule, other.schedule);
      if (!schedule.overlaps) continue;
      results.push({ rule: other, index, certain: scope.certain && target.certain && schedule.certain });
    }
    return results;
  }

  function scheduleSignature(now = new Date()) {
    return settings.rules.filter(r => r.schedule?.enabled).map(r =>
      r.id + ':' + Number(r.enabled !== false && scheduleMatches(r.schedule, now))).join('|');
  }

  let settings = loadSettings();
  let activeRules = [];
  let uploadBusy = false;
  const overrides = new Map();                  // DOM element → currently applied override
  const pictureOwners = new WeakMap();           // <source> → overridden <img>
  const pendingRoots = new Set();
  let fullScanNeeded = true;
  let scanRequested = false;
  let pickerActive = false;
  let hoveredTarget = null;
  let editingId = null;
  let panelReturnFocus = null;
  let observer;
  let svgHrefObserver;
  const svgImages = new Set();
  let scheduleTimer = null;
  let previousScheduleSignature = '';
  let draftPreview = null;              // Transient rule, never written to GM storage.
  let storedActiveCount = 0;
  let previewTimer = null;
  let pagePreviewMode = false;
  const colorSchemeQuery = matchMedia('(prefers-color-scheme: dark)');

  function loadSettings() {
    try {
      const raw = GM_getValue(STORAGE_KEY, null);
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!parsed || typeof parsed !== 'object') return { ...defaults, rules: [], assets: [] };
      return {
        enabled: parsed.enabled !== false,
        // v1.1's default was visible, so hide once on upgrading rather than
        // treating its old default as an explicit opt-in.
        showButton: parsed.uiPreferencesVersion >= 2 && parsed.showButton === true,
        buttonCorner: CORNERS.includes(parsed.buttonCorner) ? parsed.buttonCorner : defaults.buttonCorner,
        uiPreferencesVersion: 2,
        theme: ['auto', 'light', 'dark'].includes(parsed.theme) ? parsed.theme : 'auto',
        rules: Array.isArray(parsed.rules) ? parsed.rules.filter(r =>
          r && typeof r === 'object' && typeof r.id === 'string' &&
          ['url', 'selector'].includes(r.mode) && typeof r.scope === 'string' &&
          typeof r.pattern === 'string' && typeof r.selector === 'string' &&
          typeof r.replacement === 'string'
        ).map(r => ({ ...r, name: typeof r.name === 'string' ? r.name.slice(0, 120) : '' })) : [],
        assets: Array.isArray(parsed.assets) ? parsed.assets.filter(a =>
          a && typeof a === 'object' && typeof a.id === 'string' &&
          /^[a-zA-Z0-9_-]+$/.test(a.id) && typeof a.name === 'string' &&
          Number.isFinite(a.bytes) && a.bytes > 0
        ) : []
      };
    } catch (err) {
      console.warn('[Image Swap] Could not load saved rules:', err);
      return { ...defaults, rules: [], assets: [] };
    }
  }

  function saveSettings() {
    try {
      GM_setValue(STORAGE_KEY, JSON.stringify(settings));
    } catch (err) {
      alert('Image Swap could not save its configuration: ' + err.message);
      settings = loadSettings();
      refreshRules();
      requestFullScan();
      render();
      return false;
    }
    refreshRules();
    armScheduleTimer();
    requestFullScan();
    render();
    return true;
  }

  function newId() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  // * is the only wildcard. All other characters are literal.
  function globRegex(glob) {
    return new RegExp('^' + glob.split('*').map(s =>
      s.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    ).join('.*') + '$');
  }

  function normalizedURL(value) {
    try { return new URL(value.trim(), document.baseURI).href; }
    catch { return value.trim(); }
  }

  function normalizedPattern(pattern) {
    // The wildcard is preserved while relative URLs are resolved.
    // Lowercase, because URL parsing lowercases a wildcard in the hostname.
    const marker = '__image_swap_wildcard_45d65__';
    return normalizedURL(pattern.trim().replace(/\*/g, marker)).replaceAll(marker, '*');
  }

  // querySelector() does not accept pseudo-elements; validate their parent selector.
  function pseudoSelectorInfo(selector) {
    const match = /::?(before|after)\s*$/i.exec(selector);
    if (!match) return null;
    const base = selector.slice(0, match.index).trim();
    if (!base) throw new Error('A pseudo-element requires an element selector.');
    return { base, pseudo: '::' + match[1].toLowerCase() };
  }

  function validateSelector(selector) {
    const pseudo = pseudoSelectorInfo(selector);
    document.querySelector(pseudo ? pseudo.base : selector);
    return pseudo;
  }

  function resolveReplacement(rule, cache) {
    const assetId = storedAssetId(rule.replacement);
    if (!assetId) return rule.replacement;
    // A missing/deleted asset must not silently overwrite the original.
    if (!settings.assets.some(asset => asset.id === assetId)) return null;
    if (!cache.has(assetId)) {
      try {
        const data = GM_getValue(ASSET_PREFIX + assetId, null);
        cache.set(assetId, typeof data === 'string' &&
          /^data:image\/(?:png|jpeg|gif|webp|avif|bmp|svg\+xml|x-icon);base64,/.test(data)
          ? data : null);
      } catch (err) {
        console.warn('[Image Swap] Uploaded image cannot be read:', assetId, err);
        cache.set(assetId, null);
      }
    }
    return cache.get(assetId);
  }

  function fileMimeType(file) {
    const extension = file.name.split('.').pop().toLowerCase();
    const byName = MIME_BY_EXTENSION[extension];
    const rawBrowser = file.type.toLowerCase();
    const byBrowser = rawBrowser === 'image/vnd.microsoft.icon' ? 'image/x-icon' : rawBrowser;
    // An unrecognized MIME is allowed only when its extension is recognized.
    // Reject contradictory MIME and extension rather than inventing a type.
    if (byBrowser && !ALLOWED_IMAGE_TYPES.has(byBrowser)) return null;
    if (byBrowser && byName && byBrowser !== byName) return null;
    return byBrowser || byName || null;
  }

  function readImageAsDataURL(file, mime) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('File could not be read.'));
      reader.onabort = () => reject(new Error('File reading was canceled.'));
      reader.readAsDataURL(file.type === mime ? file : new Blob([file], { type: mime }));
    });
  }

  async function importLocalImage(file, fromLibrary = false) {
    if (!file || uploadBusy) return;
    const uploadError = message => {
      if (fromLibrary) $('assetLibraryStatus').textContent = message;
      else validationError(message);
    };
    const mime = fileMimeType(file);
    if (!mime) return uploadError('Choose a supported image (PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, or SVG).');
    if (!file.size || file.size > MAX_IMAGE_BYTES) {
      return uploadError('The image must be between 1 byte and ' + bytesText(MAX_IMAGE_BYTES) + '.');
    }
    const total = settings.assets.reduce((sum, asset) => sum + asset.bytes, 0);
    if (total + file.size > MAX_TOTAL_BYTES) {
      return uploadError('Stored images would exceed ' + bytesText(MAX_TOTAL_BYTES) +
        '. Delete unused uploads or use an image URL instead.');
    }
    uploadBusy = true;
    $('uploadInput').disabled = true;
    $('assetLibraryUpload').disabled = true;
    $('uploadStatus').textContent = fromLibrary ? '' : 'Importing ' + file.name + '…';
    $('assetLibraryStatus').textContent = fromLibrary ? 'Importing ' + file.name + '…' : '';
    $('feedback').hidden = true;
    try {
      const encoded = await readImageAsDataURL(file, mime);
      if (typeof encoded !== 'string' || !encoded.startsWith('data:' + mime + ';base64,')) {
        throw new Error('The file did not produce an image data URL.');
      }
      const id = newId();
      const meta = { id, name: file.name.slice(0, 160), mime, bytes: file.size, addedAt: Date.now() };
      // Keep actual bytes separate from settings, avoiding huge cross-tab settings copies.
      GM_setValue(ASSET_PREFIX + id, encoded);
      settings.assets.push(meta);
      try {
        GM_setValue(STORAGE_KEY, JSON.stringify(settings));
      } catch (err) {
        settings.assets.pop();
        GM_deleteValue(ASSET_PREFIX + id);
        throw err;
      }
      refreshRules();
      requestFullScan();
      render();
      if (!fromLibrary) {
        $('replacementType').value = 'local';
        setReplacementMode();
        $('assetChoice').value = id;
        showAssetPreview();
        scheduleDraftPreview();
      }
      const success = 'Saved ' + file.name + ' in userscript storage.';
      if (fromLibrary) $('assetLibraryStatus').textContent = success;
      else $('uploadStatus').textContent = success;
    } catch (err) {
      console.error('[Image Swap] Local upload failed:', err);
      uploadError('Could not store this image: ' + err.message +
        '. Try a smaller file; available browser storage varies.');
      if (!fromLibrary) $('uploadStatus').textContent = '';
    } finally {
      uploadBusy = false;
      $('uploadInput').disabled = false;
      $('assetLibraryUpload').disabled = false;
      $('uploadInput').value = '';
      $('assetLibraryUpload').value = '';
    }
  }

  function compileRule(rule, cache) {
    if (!rule.replacement) return null;
    if (!globRegex(rule.scope.toLowerCase()).test(location.hostname.toLowerCase())) return null;
    const resolvedReplacement = resolveReplacement(rule, cache);
    if (!resolvedReplacement) return null;
    const appearance = normalizeAppearance(rule.appearance);
    if (rule.mode === 'selector') {
      return { ...rule, appearance, resolvedReplacement, pseudo: validateSelector(rule.selector) };
    }
    return { ...rule, appearance, resolvedReplacement,
      sourceRegex: globRegex(normalizedPattern(rule.pattern)) };
  }

  function refreshRules() {
    const now = new Date();
    previousScheduleSignature = scheduleSignature(now);
    activeRules = [];
    storedActiveCount = 0;
    const assetCache = new Map();
    // In-page live editing temporarily takes precedence, even if its schedule is
    // currently inactive. The draft does not alter any stored rule or its enabled state.
    if (draftPreview) {
      try {
        const compiled = compileRule(draftPreview, assetCache);
        if (compiled) activeRules.push(compiled);
      } catch (err) { console.warn('[Image Swap] Invalid live preview:', err); }
    }
    for (const rule of settings.rules) {
      if (rule.enabled === false || !scheduleMatches(rule.schedule, now)) continue;
      try {
        const compiled = compileRule(rule, assetCache);
        if (compiled) {
          storedActiveCount++;
          if (!draftPreview || rule.id !== editingId) activeRules.push(compiled);
        }
      } catch (err) {
        console.warn('[Image Swap] Ignoring invalid rule:', rule.id, err);
      }
    }
  }

  function checkScheduledRules() {
    const signature = scheduleSignature();
    if (signature === previousScheduleSignature) return;
    refreshRules();
    requestFullScan();
    if ($('veil') && !$('veil').hidden) render();
  }

  function armScheduleTimer() {
    if (scheduleTimer !== null) clearTimeout(scheduleTimer);
    scheduleTimer = null;
    if (!settings.rules.some(rule => rule.schedule?.enabled)) return;
    const now = new Date();
    // Check on each minute boundary; browser throttling is additionally handled
    // by visibility/focus events. No polling when schedules are unused.
    const untilNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 75;
    scheduleTimer = setTimeout(() => {
      checkScheduledRules();
      armScheduleTimer();
    }, Math.max(1000, untilNextMinute));
  }

  function urlMatches(rule, url) {
    return !!url && rule.sourceRegex.test(normalizedURL(url));
  }

  function candidatesFromSrcset(value) {
    if (!value) return [];
    const urls = [];
    const whitespace = /[\t\n\f\r ]/;
    let index = 0;
    while (index < value.length) {
      while (index < value.length && (value[index] === ',' || whitespace.test(value[index]))) index++;
      const start = index;
      // A comma can be part of the URL (notably CDN transforms and data URLs).
      while (index < value.length && !whitespace.test(value[index])) index++;
      let url = value.slice(start, index);
      if (!url) break;
      if (url.endsWith(',')) {
        url = url.replace(/,+$/, '');
        if (url) urls.push(url);
        continue;
      }
      // A comma after a descriptor separates candidates; parentheses can contain
      // commas, so skip their contents while looking for the next candidate.
      let inParens = false;
      while (index < value.length) {
        const ch = value[index++];
        if (ch === '(') inParens = true;
        else if (ch === ')') inParens = false;
        else if (ch === ',' && !inParens) break;
      }
      urls.push(url);
    }
    return urls;
  }

  function imageURLs(el) {
    const results = [];
    if (el.localName === 'image' && el.namespaceURI === 'http://www.w3.org/2000/svg') {
      results.push(el.getAttribute('href'), el.getAttributeNS(XLINK_NS, 'href'));
    } else {
      results.push(el.getAttribute('src'));
      if (el.localName === 'img') {
        results.push(el.currentSrc);
        results.push(...candidatesFromSrcset(el.getAttribute('srcset')));
        for (const attr of ['data-src', 'data-original', 'data-lazy-src']) {
          results.push(el.getAttribute(attr));
        }
        results.push(...candidatesFromSrcset(el.getAttribute('data-srcset')));
        const picture = el.parentElement?.localName === 'picture' ? el.parentElement : null;
        if (picture) {
          for (const source of picture.querySelectorAll(':scope > source')) {
            results.push(...candidatesFromSrcset(source.getAttribute('srcset')));
          }
        }
      }
    }
    return results.filter(Boolean);
  }

  function isImageNode(el) {
    return el.matches?.(IMAGE_SELECTOR) || false;
  }

  function selectMatchesImage(selector, el) {
    return el.matches(selector) ||
      (el.localName === 'img' && el.parentElement?.localName === 'picture' &&
       el.parentElement.matches(selector));
  }

  function findImageRule(el) {
    const urls = imageURLs(el);
    for (const rule of activeRules) {
      if (rule.mode === 'selector') {
        if (!rule.pseudo && selectMatchesImage(rule.selector, el)) return { rule, source: urls[0] || '' };
      } else {
        const source = urls.find(url => urlMatches(rule, url));
        if (source) return { rule, source };
      }
    }
    return null;
  }

  function recordAttribute(entry, node, name, applied, namespace = null) {
    const local = namespace ? name.split(':').pop() : name;
    const original = namespace ? node.getAttributeNS(namespace, local) : node.getAttribute(name);
    entry.records.push({ node, name, namespace, local, original, applied });
    if (namespace) node.setAttributeNS(namespace, name, applied);
    else node.setAttribute(name, applied);
  }

  function recordStyle(entry, node, property, applied) {
    if (!entry.styleRecords) entry.styleRecords = [];
    const style = node.style;
    entry.styleRecords.push({ node, property,
      original: style.getPropertyValue(property),
      originalPriority: style.getPropertyPriority(property), applied });
    style.setProperty(property, applied, 'important');
  }

  function restoreStyleRecords(entry) {
    for (const rec of entry.styleRecords || []) {
      const style = rec.node.style;
      // Preserve any new inline style that the website applied after our rule.
      if (style.getPropertyValue(rec.property) !== rec.applied ||
          style.getPropertyPriority(rec.property) !== 'important') continue;
      if (rec.original) style.setProperty(rec.property, rec.original, rec.originalPriority);
      else style.removeProperty(rec.property);
    }
  }

  function backgroundSize(fit) {
    if (fit === 'fill') return '100% 100%';
    if (fit === 'contain' || fit === 'cover') return fit;
    // CSS backgrounds don't have an equivalent to object-fit: scale-down.
    if (fit === 'scale-down') return 'contain';
    return 'auto';
  }

  function applyElementAppearance(entry, element, a) {
    if (element.localName === 'image' && element.namespaceURI === 'http://www.w3.org/2000/svg') {
      if (a.fit !== 'original') {
        const pos = axis => axis < 34 ? 'Min' : axis > 66 ? 'Max' : 'Mid';
        const align = 'x' + pos(a.x) + 'Y' + pos(a.y);
        const preserve = a.fit === 'fill' ? 'none' : align + ' ' + (a.fit === 'cover' ? 'slice' : 'meet');
        recordAttribute(entry, element, 'preserveAspectRatio', preserve);
      }
    } else {
      if (a.fit !== 'original') recordStyle(entry, element, 'object-fit', a.fit);
      if (a.fit !== 'original' || a.x !== 50 || a.y !== 50) {
        recordStyle(entry, element, 'object-position', a.x + '% ' + a.y + '%');
      }
    }
    if (a.blend !== 'normal') recordStyle(entry, element, 'mix-blend-mode', a.blend);
    if (a.opacity !== 100) recordStyle(entry, element, 'opacity', a.opacity / 100 + '');
    if (a.width > 0) recordStyle(entry, element, 'width', a.width + 'px');
    if (a.height > 0) recordStyle(entry, element, 'height', a.height + 'px');
    if (a.maxWidth > 0) recordStyle(entry, element, 'max-width', a.maxWidth + 'px');
    if (a.maxHeight > 0) recordStyle(entry, element, 'max-height', a.maxHeight + 'px');
  }

  function applyBackgroundAppearance(entry, element, a) {
    if (a.fit !== 'original') {
      recordStyle(entry, element, 'background-size', backgroundSize(a.fit));
      recordStyle(entry, element, 'background-repeat', 'no-repeat');
    }
    if (a.fit !== 'original' || a.x !== 50 || a.y !== 50) {
      recordStyle(entry, element, 'background-position', a.x + '% ' + a.y + '%');
    }
    if (a.blend !== 'normal') recordStyle(entry, element, 'background-blend-mode', a.blend);
    // Setting opacity on the element would also fade its children and text;
    // intentionally do not change it for CSS backgrounds.
  }

  function restoreOverride(entry) {
    if (entry.kind === 'attribute') {
      for (const rec of entry.records) {
        const actual = rec.namespace
          ? rec.node.getAttributeNS(rec.namespace, rec.local)
          : rec.node.getAttribute(rec.name);
        // If the website has changed this attribute, retain its new value.
        if (rec.node.localName === 'source') pictureOwners.delete(rec.node);
        if (actual !== rec.applied) continue;
        if (rec.namespace) {
          if (rec.original === null) rec.node.removeAttributeNS(rec.namespace, rec.local);
          else rec.node.setAttributeNS(rec.namespace, rec.name, rec.original);
        } else if (rec.original === null) {
          rec.node.removeAttribute(rec.name);
        } else {
          rec.node.setAttribute(rec.name, rec.original);
        }
      }
    } else if (entry.kind === 'background') {
      const style = entry.element.style;
      if (style.getPropertyValue('background-image') === entry.applied &&
          style.getPropertyPriority('background-image') === 'important') {
        if (entry.originalInline) {
          style.setProperty('background-image', entry.originalInline, entry.originalPriority);
        } else {
          style.removeProperty('background-image');
        }
      }
    }
    restoreStyleRecords(entry);
    overrides.delete(entry.element);
  }

  function applyImageRule(el, match) {
    const { rule, source } = match;
    const entry = { kind: 'attribute', element: el, ruleId: rule.id, source, records: [] };
    if (el.localName === 'image' && el.namespaceURI === 'http://www.w3.org/2000/svg') {
      recordAttribute(entry, el, 'href', rule.resolvedReplacement);
      if (el.hasAttributeNS(XLINK_NS, 'href')) {
        recordAttribute(entry, el, 'xlink:href', rule.resolvedReplacement, XLINK_NS);
      }
    } else {
      recordAttribute(entry, el, 'src', rule.resolvedReplacement);
      if (el.localName === 'img') {
        recordAttribute(entry, el, 'srcset', ''); // Forces src to win over responsive srcset.
        for (const attr of IMAGE_ATTRS.slice(2)) {
          if (el.hasAttribute(attr)) {
            recordAttribute(entry, el, attr, attr.endsWith('srcset') ? '' : rule.resolvedReplacement);
          }
        }
        const picture = el.parentElement?.localName === 'picture' ? el.parentElement : null;
        if (picture) {
          for (const sourceNode of picture.querySelectorAll(':scope > source')) {
            if (sourceNode.hasAttribute('srcset')) {
              recordAttribute(entry, sourceNode, 'srcset', '');
              pictureOwners.set(sourceNode, el);
            }
          }
        }
      }
    }
    applyElementAppearance(entry, el, rule.appearance);
    overrides.set(el, entry);
  }

  function processImage(el) {
    if (!el.isConnected) return;
    const previous = overrides.get(el);
    if (previous) restoreOverride(previous);
    const match = findImageRule(el);
    if (match) applyImageRule(el, match);
  }

  function urlsInBackground(cssValue) {
    const found = [];
    for (const match of cssValue.matchAll(new RegExp(BG_URL.source, 'gi'))) {
      found.push(match[1] ?? match[2] ?? match[3]);
    }
    return found;
  }

  function cssURL(url) {
    return 'url("' + url.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      .replace(/[\r\n]/g, '') + '")';
  }

  function findBackgroundRule(el, background) {
    const urls = urlsInBackground(background);
    for (const rule of activeRules) {
      if (rule.mode === 'selector') {
        if (!rule.pseudo && el.matches(rule.selector)) return rule;
      } else if (urls.some(url => urlMatches(rule, url))) {
        return rule;
      }
    }
    return null;
  }

  function replaceBackground(background, rule) {
    let changed = false;
    const replaced = background.replace(new RegExp(BG_URL.source, 'gi'), (whole, dquote, squote, plain) => {
      const source = dquote ?? squote ?? plain;
      if (rule.mode === 'url' ? urlMatches(rule, source) : !changed) {
        changed = true;
        return cssURL(rule.resolvedReplacement);
      }
      return whole;
    });
    return changed ? replaced : rule.mode === 'selector' ? cssURL(rule.resolvedReplacement) : null;
  }

  function processBackground(el) {
    if (!el.isConnected || isImageNode(el) || el === widgetHost) return;
    const previous = overrides.get(el);
    if (previous) restoreOverride(previous);
    const background = getComputedStyle(el).backgroundImage;
    const rule = findBackgroundRule(el, background);
    if (!rule) return;
    const newBackground = replaceBackground(background, rule);
    if (!newBackground) return;
    const style = el.style;
    const entry = {
      kind: 'background', element: el, ruleId: rule.id,
      originalInline: style.getPropertyValue('background-image'),
      originalPriority: style.getPropertyPriority('background-image'),
      originalComputed: background,
      applied: newBackground
    };
    style.setProperty('background-image', newBackground, 'important');
    applyBackgroundAppearance(entry, el, rule.appearance);
    overrides.set(el, entry);
  }

  const pseudoSheet = document.createElement('style');
  pseudoSheet.setAttribute('data-image-swap-pseudo-rules', '');

  function synchronizePseudoRules() {
    // CSS rules also apply to pseudo-elements created after this script runs.
    // Reverse order so the earliest configured rule wins specificity ties.
    const css = (settings.enabled ? activeRules : [])
      .filter(r => r.mode === 'selector' && r.pseudo)
      .reverse()
      .map(r => {
        const { base, pseudo } = r.pseudo;
        let property = 'background-image';
        try {
          const el = document.querySelector(base);
          if (el) {
            const computed = getComputedStyle(el, pseudo);
            if (urlsInBackground(computed.content).length &&
                !urlsInBackground(computed.backgroundImage).length) {
              property = 'content';
            }
          }
        } catch { /* If the element is not present, default to background-image. */ }
        const a = r.appearance;
        const extra = [];
        if (property === 'background-image') {
          if (a.fit !== 'original') {
            extra.push('background-size: ' + backgroundSize(a.fit) + ' !important');
            extra.push('background-repeat: no-repeat !important');
          }
          if (a.fit !== 'original' || a.x !== 50 || a.y !== 50)
            extra.push('background-position: ' + a.x + '% ' + a.y + '% !important');
          if (a.blend !== 'normal') extra.push('background-blend-mode: ' + a.blend + ' !important');
        } else if (a.fit !== 'original') {
          extra.push('object-fit: ' + a.fit + ' !important');
        }
        if (a.opacity !== 100) extra.push('opacity: ' + a.opacity / 100 + ' !important');
        return base + pseudo + ' { ' + property + ': ' + cssURL(r.resolvedReplacement) +
          ' !important; ' + extra.join('; ') + '; }';
      }).join('\n');
    if (pseudoSheet.textContent !== css) pseudoSheet.textContent = css;
    if (css && !pseudoSheet.isConnected) document.documentElement.appendChild(pseudoSheet);
    else if (!css && pseudoSheet.isConnected) pseudoSheet.remove();
  }

  function restoreEverything() {
    for (const entry of [...overrides.values()]) restoreOverride(entry);
  }

  function addRoot(root) {
    if (root?.nodeType === Node.ELEMENT_NODE && root !== widgetHost && !widgetHost.contains(root)) {
      pendingRoots.add(root);
    }
  }

  function requestFullScan() {
    fullScanNeeded = true;
    requestScan();
  }

  function requestScan() {
    if (scanRequested) return;
    scanRequested = true;
    requestAnimationFrame(flushScan);
  }

  function gatherFromRoot(root, imageTargets, backgroundTargets, scanAllBackgrounds, selectorRules) {
    if (!root.isConnected || root === widgetHost || widgetHost.contains(root)) return;
    const addImage = node => {
      if (!isImageNode(node)) return;
      imageTargets.add(node);
      if (node.localName === 'image' && node.namespaceURI === 'http://www.w3.org/2000/svg') {
        svgImages.add(node);
      }
    };
    addImage(root);
    root.querySelectorAll(IMAGE_SELECTOR).forEach(addImage);

    if (scanAllBackgrounds) {
      backgroundTargets.add(root);
      root.querySelectorAll('*').forEach(node => backgroundTargets.add(node));
    } else {
      for (const rule of selectorRules) {
        if (root.matches(rule.selector)) backgroundTargets.add(root);
        root.querySelectorAll(rule.selector).forEach(node => backgroundTargets.add(node));
      }
    }
    // A <picture> or <source> mutation must re-evaluate its rendered image.
    const picture = root.closest('picture');
    if (picture) picture.querySelectorAll(':scope > img').forEach(node => imageTargets.add(node));
  }

  function flushScan() {
    scanRequested = false;
    observer.disconnect(); // Our attribute edits must not trigger a replacement feedback loop.
    svgHrefObserver.disconnect();
    try {
      synchronizePseudoRules();
      if (!settings.enabled || !activeRules.length) {
        restoreEverything();
        svgImages.clear();
        pendingRoots.clear();
        fullScanNeeded = false;
        return;
      }
      const imageTargets = new Set();
      const backgroundTargets = new Set();
      const selectorRules = activeRules.filter(r => r.mode === 'selector' && !r.pseudo);
      const scanAllBackgrounds = activeRules.some(r => r.mode === 'url');

      if (fullScanNeeded) {
        restoreEverything();
        svgImages.clear();
        gatherFromRoot(document.documentElement, imageTargets, backgroundTargets,
          scanAllBackgrounds, selectorRules);
      } else {
        for (const root of pendingRoots) {
          gatherFromRoot(root, imageTargets, backgroundTargets,
            scanAllBackgrounds, selectorRules);
        }
      }
      for (const el of imageTargets) processImage(el);
      for (const el of backgroundTargets) processBackground(el);
      // Disconnected nodes should not be kept alive by our Map.
      for (const [el, entry] of overrides) {
        if (!el.isConnected) restoreOverride(entry);
      }
    } catch (err) {
      console.error('[Image Swap] Failed to apply a replacement:', err);
    } finally {
      fullScanNeeded = false;
      pendingRoots.clear();
      if (settings.enabled && activeRules.length && document.documentElement) {
        observer.observe(document.documentElement, {
          subtree: true, childList: true, attributes: true,
          attributeFilter: ['src', 'srcset', 'href', 'data-src',
            'data-srcset', 'data-original', 'data-lazy-src', 'style', 'class', 'id']
        });
        // MutationObserver ignores namespaced attributes when attributeFilter is
        // set. Observe only SVG image nodes without a filter for xlink:href.
        for (const element of svgImages) {
          if (element.isConnected) svgHrefObserver.observe(element, { attributes: true });
          else svgImages.delete(element);
        }
      }
    }
  }

  function onMutations(mutations) {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        addRoot(pictureOwners.get(mutation.target) || mutation.target);
        // A changed ancestor class can affect descendant CSS backgrounds.
        // addRoot scans the complete subtree of the changed element.
      } else {
        for (const node of mutation.addedNodes) addRoot(node);
        if (mutation.target.nodeType === Node.ELEMENT_NODE &&
            mutation.target.localName === 'picture') addRoot(mutation.target);
      }
    }
    if (pendingRoots.size || mutations.some(m => m.removedNodes?.length)) requestScan();
  }

  // Keep rule details in a closed shadow root. Leave its host detached until a
  // visible control is needed, so unrelated pages get no script-owned UI node.
  const widgetHost = document.createElement('div');
  widgetHost.id = 'image-swap-widget-host';
  widgetHost.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const ui = widgetHost.attachShadow({ mode: 'closed' });
  ui.innerHTML = `
    <style>
      :host {
        all: initial; font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        --surface: #18212d; --surface-raised: #202c3b; --surface-input: #101925;
        --text: #ecf1f8; --muted: #b4c1d1; --faint: #aab8cc;
        --border: #526075; --border-subtle: #3b485a; --control: #29394c;
        --control-text: #f3f6fa; --focus: #86b7ff; --veil-color: #000a;
        --primary: #3469af; --primary-border: #5585c6; --error: #ffc8a6;
        --shadow-color: #000b; --preview-base: #8ba7c6;
        color: var(--text); color-scheme: dark;
      }
      :host([data-theme="light"]) {
        --surface: #f8fafc; --surface-raised: #eef2f7; --surface-input: #fff;
        --text: #172338; --muted: #52647b; --faint: #62718a;
        --border: #acbacb; --border-subtle: #d5dde7; --control: #e4ecf5;
        --control-text: #172338; --focus: #235fac; --veil-color: #0d183766;
        --primary: #2664ad; --primary-border: #3d77bb; --error: #8b3816;
        --shadow-color: #14253b55; --preview-base: #c7daf3;
        color-scheme: light;
      }
      *, *::before, *::after { box-sizing: border-box; }
      [hidden] { display: none !important; }
      button, input, select { font: inherit; }
      button { cursor: pointer; }
      button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
      #launcher { position: fixed; pointer-events: auto; display: flex; touch-action: none; user-select: none; }
      #launcher[data-corner="bottom-right"] { right: 15px; bottom: 15px; }
      #launcher[data-corner="bottom-left"] { left: 15px; bottom: 15px; }
      #launcher[data-corner="top-right"] { right: 15px; top: 15px; }
      #launcher[data-corner="top-left"] { left: 15px; top: 15px; }
      #launcher.dragging { cursor: grabbing; }
      #launcher.dragging button { cursor: grabbing; }
      #launcher button { border: 1px solid #556477; background: #1d2734; color: #f4f6fa;
        border-radius: 25px; padding: 9px 13px; font-size: 12px; box-shadow: 0 4px 20px #0007; }
      #launcher #grip { border-radius: 22px 0 0 22px; padding: 9px 9px; cursor: grab; color: #b0c5db; }
      #launcher #open { border-radius: 0; margin-left: -1px; font-weight: 650; letter-spacing: .06em; }
      #launcher #quickToggle { position: relative; isolation: isolate; display: inline-grid;
        place-items: center; border-radius: 0 22px 22px 0; margin-left: -1px;
        min-width: 55px; min-height: 36px; color: #a9d3ff;
        box-shadow: inset 0 0 10px #6495f844, 0 4px 20px #0007;
        transition: color .15s, box-shadow .15s; }
      #launcher #quickToggle svg { display: block; width: 19px; height: 19px;
        stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round;
        filter: drop-shadow(0 0 4px #75adff99); }
      #launcher #quickToggle.off { color: #89939e; box-shadow: 0 4px 20px #0007; }
      #launcher #quickToggle.off svg { filter: none; }
      #launcher #quickToggle:not(.off):hover { color: #d7e9ff; box-shadow: inset 0 0 14px #78a8ff6e, 0 4px 20px #0007; }
      #launcher #quickToggle.off:hover { color: #c2c7ce; }
      #veil { position: fixed; inset: 0; background: var(--veil-color); display: flex;
        align-items: center; justify-content: center; padding: 15px; pointer-events: auto; }
      #panel { width: min(590px, 100%); max-height: min(86vh, 850px); overflow: auto; overscroll-behavior: contain;
        background: var(--surface); border: 1px solid var(--border); color: var(--text);
        border-radius: 14px; box-shadow: 0 18px 70px var(--shadow-color); font: 13px/1.45 system-ui, sans-serif; }
      .inner { padding: 17px 19px; }
      .heading { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
      .heading.wrap { flex-wrap: wrap; row-gap: 2px; }
      .heading.wrap h3 { white-space: nowrap; }
      h2 { font-size: 19px; margin: 0; }
      h3 { font-size: 15px; margin: 0 0 8px; }
      p { margin: 6px 0 12px; }
      .muted { color: var(--muted); }
      .tiny { color: var(--faint); font-size: 11px; }
      .controls { display: flex; flex-wrap: wrap; gap: 10px 16px; margin: 12px 0; align-items: center; }
      .toggle { display: inline-flex; align-items: center; gap: 7px; cursor: pointer; }
      input[type="checkbox"] { accent-color: var(--primary); }
      .actions, .buttons { display: flex; flex-wrap: wrap; gap: 7px; }
      .button { border: 1px solid var(--border); color: var(--control-text); background: var(--control);
        border-radius: 7px; padding: 7px 11px; font-size: 12px; }
      .button.primary { color: #fff; background: var(--primary); border-color: var(--primary-border); }
      .button.danger { color: var(--error); }
      .button:hover { filter: brightness(1.16); }
      .button:disabled { opacity: .35; cursor: default; }
      .small { padding: 4px 7px; }
      .icon { background: transparent; border: 0; color: var(--text); font-size: 20px; padding: 0 5px; font-style: normal; }
      hr { border: 0; border-top: 1px solid var(--border-subtle); margin: 14px 0; }
      .entry { border: 1px solid var(--border); border-radius: 9px; background: var(--surface-raised);
        padding: 9px 10px; margin: 8px 0; }
      .entry.disabled { opacity: .63; }
      .entry-top { display: flex; flex-direction: row; gap: 7px; align-items: flex-start; list-style: none;
        cursor: pointer; min-width: 0; line-height: 19px; }
      .entry-top::-webkit-details-marker { display: none; }
      .entry-top::marker { content: ''; }
      .entry-top::before { content: '▸'; color: var(--muted); font-size: 13px; width: 13px; flex: none;
        text-align: center; }
      .entry[open] > .entry-top::before { content: '▾'; }
      .entry-summary { flex: 1 1 auto; min-width: 0; }
      .entry-body { padding: 6px 0 1px 20px; min-width: 0; }
      .entry-title { display: block; font-weight: 650; min-width: 0; overflow-wrap: anywhere; }
      .entry-info, .entry-details { color: var(--muted); font-size: 11px; overflow-wrap: anywhere; margin: 4px 0 0; }
      .entry-details { color: var(--faint); }
      .entry-domain-wrap { position: relative; display: inline-block; max-width: 100%; vertical-align: top; }
      .entry-domain { color: var(--text); text-decoration: underline dotted; text-underline-offset: 2px;
        cursor: help; border-radius: 3px; }
      .entry-domain:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
      .entry-hint { display: none; position: absolute; left: 0; top: 100%; z-index: 5;
        width: max-content; max-width: min(430px, calc(100vw - 80px)); padding: 6px 8px;
        background: var(--surface-input); color: var(--text); border: 1px solid var(--border);
        border-radius: 6px; box-shadow: 0 5px 18px var(--shadow-color); font-size: 11px;
        line-height: 1.45; overflow-wrap: anywhere; cursor: text; }
      .entry-domain-wrap:hover .entry-hint, .entry-domain:focus ~ .entry-hint { display: block; }
      .entry-domain-wrap[data-dismissed] .entry-hint { display: none; }
      .entry-actions { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; margin-top: 8px; }
      .entry-actions .action-button, .entry-toggle { display: inline-grid; place-items: center; flex: none;
        width: 30px; height: 30px; padding: 0; border-radius: 7px; }
      .entry-toggle { border: 1px solid var(--border-subtle); cursor: pointer; }
      .entry-toggle input { margin: 0; width: 15px; height: 15px; cursor: pointer; }
      .action-button svg { display: block; width: 16px; height: 16px; fill: none; stroke: currentColor;
        stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
      .field { margin: 11px 0; }
      .field label { display: block; margin-bottom: 4px; font-weight: 600; }
      .field input:not([type="file"]), .field select { width: 100%; background: var(--surface-input); border: 1px solid var(--border);
        border-radius: 6px; color: var(--text); padding: 9px; font-size: 12px; }
      .upload-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; margin-top: 8px; }
      .upload-controls input[type="file"] { width: min(100%, 310px); font-size: 12px; }
      .preview { display: block; max-height: 110px; max-width: 240px; margin-top: 8px;
        background: repeating-conic-gradient(#eee 0% 25%, #bbb 0% 50%) 50% / 16px 16px;
        border: 1px solid var(--border); object-fit: contain; }
      .library-entry { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
        gap: 6px; border-top: 1px solid var(--border-subtle); padding: 8px 0; }
      .library-entry-name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
      .field small { display: block; color: var(--muted); margin-top: 4px; }
      .field > label { display: inline-block; vertical-align: middle; }
      .help-heading { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
      .help-heading > h3 { margin: 0; }
      .help-tip { display: inline-flex; align-items: center; flex: none; vertical-align: middle; margin-left: 3px; }
      .help-trigger { position: relative; display: inline-grid; place-items: center; width: 15px; height: 15px;
        padding: 0; border: 1px solid var(--border); border-radius: 50%;
        background: var(--surface-raised); color: var(--muted); cursor: help;
        font: 700 9.5px/1 system-ui, sans-serif; }
      .help-trigger::after { content: ''; position: absolute; inset: -5px; border-radius: 50%; }
      .help-trigger:hover { color: var(--text); }
      .help-trigger:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
      .help-trigger[aria-expanded="true"] { border-color: var(--focus); }
      .help-popover { position: fixed; z-index: 20; pointer-events: auto; box-sizing: border-box;
        max-width: min(300px, calc(100vw - 24px)); padding: 9px 11px; background: var(--surface-input);
        color: var(--text); border: 1px solid var(--border); border-radius: 8px;
        box-shadow: 0 7px 24px var(--shadow-color); font-size: 12px; font-weight: 400; line-height: 1.5; }
      .reuse-settings { padding: 10px 12px; margin: 10px 0 15px; border: 1px solid var(--border-subtle);
        border-radius: 9px; background: var(--surface-raised); }
      .reuse-settings .field { margin: 9px 0; }
      #copyStatus { margin-left: 8px; }
      #conflictNotice { background: var(--surface-raised); border: 1px solid var(--border);
        border-left: 3px solid #e1a252; padding: 9px 11px; border-radius: 5px;
        margin: 13px 0; overflow-wrap: anywhere; }
      #conflictNotice strong { color: var(--text); }
      #conflictNotice .tiny { display: block; margin-top: 3px; }
      summary { cursor: pointer; }
      .field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
      .field-grid > div { min-width: 0; }
      .field-grid > div > label { display: inline-block; vertical-align: middle; }
      .weekday-options { display: flex; flex-wrap: wrap; gap: 7px 12px; }
      .weekday-options label { display: inline-flex; align-items: center; gap: 3px; font-weight: 400; cursor: pointer; }
      #editor { border-top: 1px solid var(--border-subtle); margin-top: 14px; padding-top: 13px; }
      #feedback { color: var(--error); margin-top: 9px; white-space: pre-wrap; }
      .theme-control { display: inline-flex; gap: 7px; align-items: center; }
      .theme-control label { color: var(--muted); }
      .theme-control select { font: inherit; color: var(--text); background: var(--surface-input);
        border: 1px solid var(--border); padding: 5px 8px; border-radius: 6px; }
      .live-preview-area { margin: 10px 0 14px; padding: 11px; border: 1px solid var(--border);
        background: var(--surface-raised); border-radius: 9px; }
      .live-preview-heading { display: flex; gap: 10px; justify-content: space-between;
        align-items: baseline; flex-wrap: wrap; margin-bottom: 8px; }
      #previewFrame { display: grid; place-items: center; position: relative; overflow: hidden;
        width: min(100%, 310px); height: 170px; margin: 8px auto; border: 1px solid var(--border);
        border-radius: 6px; background-color: var(--preview-base);
        background-image: linear-gradient(45deg, #ffffff66 25%, transparent 25%),
          linear-gradient(-45deg, #ffffff66 25%, transparent 25%),
          linear-gradient(45deg, transparent 75%, #ffffff66 75%),
          linear-gradient(-45deg, transparent 75%, #ffffff66 75%);
        background-size: 24px 24px; background-position: 0 0, 0 12px, 12px -12px, -12px 0; }
      #previewImage { display: block; width: 100%; height: 100%; max-width: none; max-height: none;
        object-fit: contain; object-position: center; }
      #previewPlaceholder { padding: 12px; font-size: 12px; text-align: center; color: #203147;
        background: #ffffffa6; border-radius: 6px; max-width: 85%; }
      #previewView { margin-top: 4px; }
      #previewDock { position: fixed; pointer-events: auto; top: 15px; right: 15px;
        background: #18212d; color: #ecf1f8; border: 1px solid #526075;
        border-radius: 9px; padding: 9px; box-shadow: 0 4px 20px #0008; }
      #previewDock button { font: 13px system-ui,sans-serif; }
      #previewDock .hint { font: 11px system-ui,sans-serif; color: #b4c1d1; margin-top: 5px; }
      #pickOutline { position: fixed; pointer-events: none; border: 3px solid #72b9ff;
        background: #5aa7ff27; z-index: 2; border-radius: 3px; }
      #pickHint { position: fixed; top: 13px; left: 50%; transform: translateX(-50%);
        background: #18212d; border: 1px solid #72b9ff; color: #fff; border-radius: 9px;
        padding: 10px 15px; max-width: calc(100vw - 20px); text-align: center;
        pointer-events: none; box-shadow: 0 5px 22px #000a; font-size: 13px; }
      @media (max-width: 520px) { .inner { padding: 12px; } }
      @media (max-width: 400px) { .entry { padding: 8px; } .entry-body { padding-left: 0; } }
    </style>
    <div id="launcher" data-corner="bottom-right"><button type="button" id="grip" title="Drag to move; snaps to a corner" aria-label="Drag No-BS Image Swapper floating button">⠿</button><button type="button" id="open" title="No-BS Image Swapper: manage image replacements" aria-label="NBSIS: open No-BS Image Swapper">NBSIS</button><button type="button" id="quickToggle" title="Disable image replacements" aria-label="Disable image replacements" aria-pressed="true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5v9"/><path d="M7.4 5.8a8 8 0 1 0 9.2 0"/></svg></button></div>
    <div id="veil" hidden>
      <section id="panel" role="dialog" aria-modal="true" aria-label="No-BS Image Swapper settings" tabindex="-1">
        <div class="inner">
          <div class="heading"><h2>No-BS Image Swapper</h2><button type="button" class="icon" id="close" aria-label="Close">×</button></div>
          <p class="muted">Persistent image replacements for this browser.</p>
          <div class="controls">
            <label class="toggle"><input id="enabled" type="checkbox"> Replacements enabled</label>
            <label class="toggle"><input id="showButton" type="checkbox"> Show floating button</label>
            <div class="theme-control"><label for="themeMode">Theme</label><select id="themeMode">
              <option value="auto">Automatic</option><option value="light">Light</option><option value="dark">Dark</option>
            </select></div>
          </div>
          <div class="actions">
            <button type="button" class="button primary" id="add">+ Add manual rule</button>
            <button type="button" class="button" id="pick">◎ Pick from page</button>
          </div>
          <hr>
          <div class="heading wrap"><h3>Saved rules</h3><span id="count" class="tiny"></span></div>
          <p id="savedRulesHelp" hidden>Earlier rules take priority. Images added by scripts are watched automatically. CSS pseudo-elements require manual selectors. Some websites block data: image URLs through their security policies; on those sites, try a hosted image URL. Canvas pixels and cross-origin iframes are not rewritten.</p>
          <div id="ruleList"></div>
          <details id="uploadsSection" style="margin-top:12px">
            <summary style="cursor:pointer"><strong>Stored images</strong> <span id="assetsCount" class="tiny"></span></summary>
            <p id="storedImagesHelp" hidden>Each upload may be up to ${bytesText(MAX_IMAGE_BYTES)}, and all uploads together up to ${bytesText(MAX_TOTAL_BYTES)}. These are script caps; the repository records no storage measurement or rationale for the values. Base64 encoding makes a full ${bytesText(MAX_TOTAL_BYTES)} about ${bytesText(Math.ceil(MAX_TOTAL_BYTES * 4 / 3))} before other overhead. Actual capacity depends on the browser, userscript manager, and free disk space, so a save can fail below these caps. Uploads stay in userscript manager storage. Applied images become visible to scripts on that page, so avoid confidential files. Deleting browser or userscript storage also deletes the images.</p>
            <div class="upload-controls"><label for="assetLibraryUpload">Upload local image</label>
              <input id="assetLibraryUpload" type="file" accept=".png,.jpg,.jpeg,.gif,.webp,.avif,.bmp,.ico,.svg,image/*"></div>
            <div id="assetLibraryStatus" class="tiny" aria-live="polite"></div>
            <div id="assetList" style="margin-top:6px"></div>
          </details>
          <form id="editor" hidden>
            <h3 id="editorHeading">Add a rule</h3>
            <div class="field"><label for="ruleName">Display name (optional)</label>
              <input id="ruleName" type="text" maxlength="120" placeholder="e.g., Facebook Homepage Logo">
              <small>Give this rule a recognizable name. Leave blank to show its original URL or CSS selector instead.</small></div>
            <div class="field"><label for="scope">Website hostname</label>
              <input id="scope" type="text" required spellcheck="false" placeholder="example.com or *">
              <small>Defaults to this website. Use * for all sites or *.example.com for subdomains.</small></div>
            <div class="field"><label for="mode">How to find the original image</label>
              <select id="mode"><option value="url">Original resource URL</option><option value="selector">CSS selector</option></select></div>
            <div class="field" id="patternField"><label for="pattern">Original resource URL or pattern</label>
              <input id="pattern" type="text" spellcheck="false" placeholder="https://site.example/logo.png">
              <small>Paste its address directly. An asterisk (*) matches any sequence, including changing query strings.</small></div>
            <div class="field" id="selectorField" hidden><label for="selector">CSS selector of the image or background element</label>
              <input id="selector" type="text" spellcheck="false" placeholder="#logo, .hero-image, img[alt='Logo']">
              <small>Works on img, picture, SVG images, and CSS backgrounds. End with ::before or ::after to target a pseudo-element.</small></div>
            <div class="field"><label for="replacementType">Replacement source</label>
              <select id="replacementType"><option value="url">Image URL</option><option value="local">Stored local image</option></select></div>
            <div class="field" id="replacementURLField"><label for="replacement">Replacement image URL</label>
              <input id="replacement" type="text" spellcheck="false" placeholder="https://site.example/my-version.png">
              <small>Use an HTTP(S) image URL or data:image URL.</small></div>
            <div class="field" id="localImageField" hidden>
              <label for="assetChoice">Stored image to use</label>
              <select id="assetChoice"><option value="">Choose an uploaded image…</option></select>
              <div class="upload-controls"><label for="uploadInput">Upload a new image</label>
                <input id="uploadInput" type="file" accept=".png,.jpg,.jpeg,.gif,.webp,.avif,.bmp,.ico,.svg,image/*"></div>
              <small>PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, or SVG · Maximum ${bytesText(MAX_IMAGE_BYTES)} per image, ${bytesText(MAX_TOTAL_BYTES)} total; browser storage may allow less. Image bytes remain in browser userscript storage.</small>
              <img id="assetPreview" class="preview" alt="Selected stored image preview" hidden>
              <div id="uploadStatus" class="tiny" aria-live="polite"></div>
            </div>
            <section id="appearanceOptions" aria-labelledby="appearanceHeading">
              <h3 id="appearanceHeading" style="margin-top:14px">Appearance</h3>
              <section class="live-preview-area" aria-label="Replacement appearance preview">
                <div class="live-preview-heading"><strong>Live preview</strong><span id="previewStatus" class="tiny" aria-live="polite">Select a replacement image</span></div>
                <div id="previewFrame"><img id="previewImage" alt="Live replacement preview" hidden>
                  <span id="previewPlaceholder">Add a replacement image to see it here.</span></div>
                <label class="toggle"><input type="checkbox" id="previewOnPage" checked> Preview changes on this page</label>
                <div class="buttons"><button type="button" class="button small" id="previewView">View page preview</button></div>
                <small class="tiny">The thumbnail shows the entire replacement image. The page preview applies fit and sizing to the real page without saving; Cancel restores the saved rule.</small>
              </section>
              <div class="field field-grid">
                <div><label for="positionX">Horizontal alignment (%)</label><input type="number" id="positionX" min="0" max="100" step="1" value="50"></div>
                <div><label for="positionY">Vertical alignment (%)</label><input type="number" id="positionY" min="0" max="100" step="1" value="50"></div>
              </div>
              <div class="field"><label for="blend">Blend mode</label>
                <select id="blend"><option value="normal">Normal</option><option value="multiply">Multiply</option>
                  <option value="screen">Screen</option><option value="overlay">Overlay</option>
                  <option value="darken">Darken</option><option value="lighten">Lighten</option>
                  <option value="color-dodge">Color dodge</option><option value="color-burn">Color burn</option>
                  <option value="hard-light">Hard light</option><option value="soft-light">Soft light</option>
                  <option value="difference">Difference</option><option value="exclusion">Exclusion</option>
                  <option value="hue">Hue</option><option value="saturation">Saturation</option>
                  <option value="color">Color</option><option value="luminosity">Luminosity</option>
                </select><small>Images blend against surrounding content; CSS backgrounds blend with background layers/color, not surrounding text.</small></div>
              <div class="field field-grid">
                <div><label for="opacity">Image opacity (%)</label><input type="number" id="opacity" min="0" max="100" step="1" value="100"></div>
                <div></div>
                <div><label for="targetWidth">Display width (px)</label><input type="number" id="targetWidth" min="0" max="10000" step="1" value="0"></div>
                <div><label for="targetHeight">Display height (px)</label><input type="number" id="targetHeight" min="0" max="10000" step="1" value="0"></div>
                <div><label for="maxWidth">Maximum width (px)</label><input type="number" id="maxWidth" min="0" max="10000" step="1" value="0"></div>
                <div><label for="maxHeight">Maximum height (px)</label><input type="number" id="maxHeight" min="0" max="10000" step="1" value="0"></div>
              </div>
              <p class="tiny">Zero means keep the website’s dimensions (or no maximum). Display width/height establish a box for Contain, Cover, and Stretch when the page doesn’t provide one. These size and opacity settings apply to image elements, not CSS backgrounds; fading a background’s parent would fade its text too.</p>
            </section>
            <details id="advancedOptions" style="margin:12px 0 15px">
              <summary style="cursor:pointer;font-weight:650">Advanced options — fit, reuse, and conditions</summary>
              <div class="field"><label for="fit">How the replacement fits</label>
                <select id="fit">
                  <option value="original">Keep website styling</option>
                  <option value="contain">Contain — fit whole image</option>
                  <option value="cover">Cover — fill area, crop overflow</option>
                  <option value="fill">Stretch — fill area, distort if needed</option>
                  <option value="scale-down">Scale down — never enlarge</option>
                  <option value="none">Natural size — no scaling</option>
                </select>
                <small>Uses object-fit for images and background-size for CSS backgrounds. Contain/cover need a defined image box to crop or letterbox.</small></div>
              <section id="reuseSettings" class="reuse-settings" hidden>
                <h3>Reuse settings</h3>
                <div class="field"><label for="copySource">Copy from rule</label>
                  <select id="copySource"><option value="">Select an existing rule…</option></select></div>
                <div class="field"><label for="copyParts">What to copy</label>
                  <select id="copyParts"><option value="both">Appearance and conditions</option>
                    <option value="appearance">Appearance only</option>
                    <option value="schedule">Conditions only</option></select></div>
                <button type="button" class="button" id="copySettings">Copy settings</button>
                <span id="copyStatus" class="tiny" role="status" aria-live="polite"></span>
                <p class="tiny">Copies only the selected settings. The rule’s name, matching criteria, and replacement image stay unchanged until you edit them.</p>
              </section>
              <h3>Conditions</h3>
              <div class="field"><label for="conditionMode">When should this rule apply?</label>
                <select id="conditionMode"><option value="always">Always</option><option value="scheduled">On a schedule</option></select></div>
              <div id="scheduleFields" hidden>
                <div class="field field-grid">
                  <div><label for="scheduleStart">From (inclusive)</label><input type="time" id="scheduleStart" value="09:00"></div>
                  <div><label for="scheduleEnd">Until (exclusive)</label><input type="time" id="scheduleEnd" value="17:00"></div>
                </div>
                <div class="field"><label>Days of the week</label><div id="weekdayOptions" class="weekday-options">
                  <label><input type="checkbox" data-weekday="1" checked>Mon</label>
                  <label><input type="checkbox" data-weekday="2" checked>Tue</label>
                  <label><input type="checkbox" data-weekday="3" checked>Wed</label>
                  <label><input type="checkbox" data-weekday="4" checked>Thu</label>
                  <label><input type="checkbox" data-weekday="5" checked>Fri</label>
                  <label><input type="checkbox" data-weekday="6" checked>Sat</label>
                  <label><input type="checkbox" data-weekday="0" checked>Sun</label>
                </div></div>
                <div class="field"><label for="scheduleTimezone">Time zone</label>
                  <select id="scheduleTimezone"><option value="local">Browser’s local time</option><option value="utc">UTC</option></select></div>
                <div class="field field-grid">
                  <div><label for="scheduleFrom">First date (optional)</label><input type="date" id="scheduleFrom"></div>
                  <div><label for="scheduleUntil">Last date (optional)</label><input type="date" id="scheduleUntil"></div>
                </div>
                <p class="tiny">Choose matching weekdays and hours; equal times mean all day. Overnight windows continue into the next day, but count toward the selected starting weekday/date. Date limits are inclusive. The page updates when the clock changes, without a reload.</p>
              </div>
            </details>
            <div id="conflictNotice" role="status" aria-live="polite" hidden></div>
            <div id="feedback" role="alert" hidden></div>
            <div class="buttons"><button type="submit" class="button primary">Save rule</button>
              <button type="button" id="cancel" class="button">Cancel</button></div>
          </form>
        </div>
      </section>
    </div>
    <div id="previewDock" hidden><button type="button" class="button primary" id="previewReturn">Return to editor</button>
      <div class="hint">Unsaved image preview · press Esc to return</div></div>
    <div id="pickOutline" hidden></div>
    <div id="pickHint" hidden>Click an image or CSS background to create a rule. Press Esc to cancel.</div>
  `;
  const $ = id => ui.getElementById(id);
  let activeHelp = null;

  function closeHelp() {
    if (!activeHelp) return;
    activeHelp.popover.hidden = true;
    activeHelp.button.setAttribute('aria-expanded', 'false');
    activeHelp = null;
  }

  function addContextualHelp(after, text, label) {
    const help = document.createElement('span');
    help.className = 'help-tip';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'help-trigger';
    button.textContent = '?';
    button.title = 'Help: ' + label;
    button.setAttribute('aria-label', 'Help: ' + label);
    button.setAttribute('aria-expanded', 'false');
    const popover = document.createElement('div');
    popover.className = 'help-popover';
    popover.id = 'help-' + ui.querySelectorAll('.help-popover').length;
    popover.hidden = true;
    popover.textContent = text;
    button.setAttribute('aria-controls', popover.id);
    help.append(button);
    if (after.matches('h3, .live-preview-heading strong')) {
      const wrapper = document.createElement(after.matches('h3') ? 'div' : 'span');
      wrapper.className = 'help-heading';
      after.replaceWith(wrapper);
      wrapper.append(after, help);
    } else after.after(help);
    ui.append(popover);
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (activeHelp?.button === button) { closeHelp(); return; }
      closeHelp();
      popover.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      const rect = button.getBoundingClientRect();
      const width = Math.min(300, innerWidth - 24);
      popover.style.width = width + 'px';
      popover.style.left = Math.max(12, Math.min(rect.left, innerWidth - width - 12)) + 'px';
      const below = rect.bottom + 6;
      popover.style.top = (below + popover.offsetHeight <= innerHeight - 12
        ? below : Math.max(12, rect.top - popover.offsetHeight - 6)) + 'px';
      activeHelp = { button, popover };
    });
  }

  function installContextualHelp() {
    for (const id of ['ruleName', 'scope', 'pattern', 'selector', 'replacement',
      'assetChoice', 'fit', 'blend']) {
      const field = $(id).closest('.field');
      const label = field.querySelector('label[for="' + id + '"]');
      const description = field.querySelector('small');
      if (!label || !description) continue;
      addContextualHelp(label, description.textContent, label.textContent);
      description.remove();
    }
    // Advanced explanations stay available without taking up permanent space.
    for (const [note, trigger, label] of [
      ['.live-preview-area > small.tiny', '.live-preview-heading strong', 'Live preview'],
      ['#reuseSettings > p.tiny', '#reuseSettings > h3', 'Copying settings'],
      ['#appearanceOptions > p.tiny', 'label[for="targetWidth"]', 'Image sizing'],
      ['#scheduleFields > p.tiny', 'label[for="conditionMode"]', 'Schedule behavior'],
      ['#savedRulesHelp', '.heading > h3', 'Saved rules'],
      ['#storedImagesHelp', '#uploadsSection > summary strong', 'Stored images']
    ]) {
      const description = ui.querySelector(note);
      const anchor = ui.querySelector(trigger);
      if (!description || !anchor) continue;
      addContextualHelp(anchor, description.textContent, label);
      description.remove();
    }
  }
  installContextualHelp();
  ui.addEventListener('click', event => {
    if (!event.target.closest('.help-tip, .help-popover')) closeHelp();
  });
  $('panel').addEventListener('scroll', closeHelp);
  window.addEventListener('resize', closeHelp);

  function applyTheme() {
    const theme = settings.theme === 'auto' ? (colorSchemeQuery.matches ? 'dark' : 'light') : settings.theme;
    ui.host.dataset.theme = theme;
    $('themeMode').value = settings.theme;
  }

  // Static, decorative SVG markup (no user data) for the saved-rule action buttons.
  const ACTION_ICONS = Object.fromEntries(Object.entries({
    up: '<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/>',
    down: '<path d="M12 5v14"/><path d="m6 13 6 6 6-6"/>',
    edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
    duplicate: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    delete: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/>'
  }).map(([name, paths]) => [name, '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + paths + '</svg>']));

  function syncWidgetMount() {
    const shown = !$('launcher').hidden || !$('veil').hidden ||
      !$('pickHint').hidden || !$('previewDock').hidden;
    if (shown && !widgetHost.isConnected) document.documentElement.appendChild(widgetHost);
    else if (!shown && widgetHost.isConnected) widgetHost.remove();
  }

  function render() {
    applyTheme();
    $('enabled').checked = settings.enabled;
    $('showButton').checked = settings.showButton;
    $('launcher').hidden = !settings.showButton || pickerActive || pagePreviewMode;
    $('launcher').dataset.corner = settings.buttonCorner;
    $('quickToggle').classList.toggle('off', !settings.enabled);
    $('quickToggle').setAttribute('aria-pressed', String(settings.enabled));
    $('quickToggle').setAttribute('aria-label', settings.enabled ? 'Disable image replacements' : 'Enable image replacements');
    $('quickToggle').title = settings.enabled ? 'Disable image replacements' : 'Enable image replacements';
    syncWidgetMount();
    if ($('veil').hidden) return;
    $('count').textContent = plural(settings.rules.length, 'rule') + ' total · ' +
      plural(settings.enabled ? storedActiveCount : 0, 'rule') + ' active here';
    renderAssets();
    const list = $('ruleList');
    const expanded = new Set([...list.querySelectorAll('.entry[open]')].map(item => item.dataset.id));
    list.replaceChildren();
    if (!settings.rules.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No rules yet. Add one manually or pick an image.';
      list.append(empty);
    }
    settings.rules.forEach((rule, index) => {
      const item = document.createElement('details');
      item.className = 'entry' + (rule.enabled === false ? ' disabled' : '');
      item.dataset.id = rule.id;
      item.open = expanded.has(rule.id);
      const top = document.createElement('summary');
      top.className = 'entry-top';
      const summaryText = document.createElement('span');
      summaryText.className = 'entry-summary';
      const label = document.createElement('span');
      label.className = 'entry-title';
      label.textContent = ruleTitle(rule);
      summaryText.append(label);
      const body = document.createElement('div');
      body.className = 'entry-body';

      // Hostname, with the full matching URL or selector in a hover/focus hint.
      const info = document.createElement('div');
      info.className = 'entry-info';
      const domainWrap = document.createElement('span');
      domainWrap.className = 'entry-domain-wrap';
      const domain = document.createElement('span');
      domain.className = 'entry-domain';
      domain.tabIndex = 0;
      domain.textContent = rule.scope === '*' ? 'All websites' : rule.scope;
      const hint = document.createElement('span');
      hint.className = 'entry-hint';
      hint.id = 'entry-hint-' + index;
      hint.setAttribute('role', 'tooltip');
      hint.textContent = rule.mode === 'url' ? 'Matching URL: ' + rule.pattern : 'Matching selector: ' + rule.selector;
      domain.setAttribute('aria-describedby', hint.id);
      domainWrap.append(domain, hint);
      const assetId = storedAssetId(rule.replacement);
      const asset = assetId ? settings.assets.find(a => a.id === assetId) : null;
      info.append(domainWrap, ' → ' + (assetId ? (asset ? 'Stored: ' + asset.name : 'Missing stored image') :
        /^data:/i.test(rule.replacement) ? embeddedImageText(rule.replacement) : rule.replacement));
      body.append(info);

      const a = normalizeAppearance(rule.appearance);
      const c = normalizeSchedule(rule.schedule);
      const extras = [];
      if (a.fit !== 'original') extras.push('Fit: ' + a.fit);
      if (a.blend !== 'normal') extras.push('Blend: ' + a.blend);
      if (c.enabled) extras.push(scheduleText(c));
      if (extras.length) {
        const details = document.createElement('div');
        details.className = 'entry-details';
        details.textContent = extras.join(' · ');
        body.append(details);
      }

      const actions = document.createElement('div');
      actions.className = 'entry-actions';
      const toggleBox = document.createElement('label');
      toggleBox.className = 'entry-toggle';
      toggleBox.title = 'Enable or disable this rule';
      const toggle = document.createElement('input');
      toggle.type = 'checkbox'; toggle.checked = rule.enabled !== false;
      toggle.dataset.action = 'toggle';
      toggle.setAttribute('aria-label', 'Enable or disable rule');
      toggleBox.append(toggle);
      actions.append(toggleBox);
      for (const [action, title] of [
        ['up', 'Move rule up'], ['down', 'Move rule down'], ['edit', 'Edit rule'],
        ['duplicate', 'Duplicate rule'], ['delete', 'Delete rule']
      ]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'button action-button' + (action === 'delete' ? ' danger' : '');
        button.dataset.action = action; button.title = title;
        button.setAttribute('aria-label', title);
        button.innerHTML = ACTION_ICONS[action];
        if (action === 'up' && index === 0) button.disabled = true;
        if (action === 'down' && index === settings.rules.length - 1) button.disabled = true;
        actions.append(button);
      }
      top.append(summaryText); body.append(actions); item.append(top, body); list.append(item);
    });
  }

  function renderAssetChoices(preferred = $('assetChoice').value) {
    const select = $('assetChoice');
    select.replaceChildren(new Option('Choose an uploaded image…', ''));
    for (const asset of settings.assets) {
      select.add(new Option(asset.name + ' (' + bytesText(asset.bytes) + ')', asset.id));
    }
    select.value = settings.assets.some(a => a.id === preferred) ? preferred : '';
    showAssetPreview();
  }

  function showAssetPreview() {
    const id = $('assetChoice').value;
    const preview = $('assetPreview');
    preview.hidden = true;
    preview.removeAttribute('src');
    if (!id || !settings.assets.some(a => a.id === id)) return;
    const stored = GM_getValue(ASSET_PREFIX + id, null);
    if (typeof stored === 'string' && stored.startsWith('data:image/')) {
      preview.src = stored;
      preview.hidden = false;
    }
  }

  function renderAssets() {
    $('assetsCount').textContent = '(' + plural(settings.assets.length, 'image') + ' · ' +
      bytesText(settings.assets.reduce((total, a) => total + a.bytes, 0)) + ')';
    const list = $('assetList');
    list.replaceChildren();
    for (const asset of settings.assets) {
      const row = document.createElement('div');
      row.className = 'library-entry';
      const name = document.createElement('div');
      name.className = 'library-entry-name';
      const uses = settings.rules.filter(r => storedAssetId(r.replacement) === asset.id).length;
      name.textContent = asset.name + ' · ' + bytesText(asset.bytes) + ' · ' +
        uses + (uses === 1 ? ' rule' : ' rules');
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'button small danger';
      button.textContent = 'Delete'; button.dataset.assetId = asset.id;
      button.disabled = uses > 0;
      button.title = uses ? 'Remove rules using this image before deleting it.' : 'Delete stored image';
      row.append(name, button);
      list.append(row);
    }
    if (!settings.assets.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No local uploads. Upload an image from a rule editor.';
      list.append(empty);
    }
    renderAssetChoices();
  }

  function onDeleteAsset(event) {
    const button = event.target.closest('button[data-asset-id]');
    if (!button || button.disabled) return;
    const id = button.dataset.assetId;
    if (settings.rules.some(rule => storedAssetId(rule.replacement) === id)) return;
    const asset = settings.assets.find(a => a.id === id);
    if (!asset || !confirm('Permanently delete stored image "' + asset.name + '"?')) return;
    const key = ASSET_PREFIX + id;
    let savedData;
    try { savedData = GM_getValue(key, null); }
    catch (err) { validationError('Could not read image before deletion: ' + err.message); return; }
    const before = settings.assets;
    let bytesDeleted = false;
    try {
      // Delete the bytes first so a failed deletion leaves the saved list intact.
      GM_deleteValue(key);
      bytesDeleted = true;
      settings.assets = before.filter(a => a.id !== id);
      GM_setValue(STORAGE_KEY, JSON.stringify(settings));
    } catch (err) {
      settings.assets = before;
      let restoreError = null;
      if (bytesDeleted && savedData !== null) {
        try { GM_setValue(key, savedData); }
        catch (restoreErr) {
          restoreError = restoreErr;
          console.error('[Image Swap] Could not restore image data:', restoreErr);
        }
      }
      settings = loadSettings();
      refreshRules(); requestFullScan(); render();
      validationError('Could not delete image: ' + err.message +
        (restoreError ? '. Its data could not be restored; re-upload it before using it.' : ''));
      return;
    }
    refreshRules(); requestFullScan(); render();
  }

  function openPanel() {
    if (pickerActive) stopPicker();
    if ($('veil').hidden && !pagePreviewMode) {
      panelReturnFocus = ui.activeElement || document.activeElement;
    }
    returnToEditor(false);
    $('veil').hidden = false;
    render();
    $('close').focus();
  }

  function closePanel(restoreFocus = true) {
    $('veil').hidden = true;
    closeHelp();
    hideEditor();
    if (restoreFocus !== false && panelReturnFocus?.isConnected) {
      panelReturnFocus.focus({ preventScroll: true });
    }
    panelReturnFocus = null;
    // A page that intercepted attachShadow before this script ran may still
    // hold the root. Do not leave rule details there after the panel closes.
    $('ruleList').replaceChildren();
    $('assetList').replaceChildren();
    $('copySource').replaceChildren();
    $('assetChoice').replaceChildren();
    $('conflictNotice').replaceChildren();
    for (const id of ['count', 'assetsCount', 'copyStatus', 'uploadStatus',
      'assetLibraryStatus', 'feedback']) {
      $(id).textContent = '';
    }
    for (const id of ['ruleName', 'scope', 'pattern', 'selector', 'replacement']) $(id).value = '';
    $('uploadInput').value = '';
    $('assetLibraryUpload').value = '';
    for (const id of ['assetPreview', 'previewImage']) {
      $(id).removeAttribute('src');
      $(id).hidden = true;
    }
    syncWidgetMount();
  }

  function panelFocusable() {
    const panel = $('panel');
    return [...panel.querySelectorAll('a[href], summary, button:not([disabled]), input:not([disabled]), ' +
      'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter(element => {
        if (!element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') return false;
        for (let ancestor = element.parentElement; ancestor && ancestor !== panel;
          ancestor = ancestor.parentElement) {
          if (ancestor.localName === 'details' && !ancestor.open &&
              !ancestor.querySelector(':scope > summary')?.contains(element)) return false;
        }
        return true;
      });
  }

  function keepPanelFocus(event) {
    if (event.key !== 'Tab' || $('veil').hidden) return;
    const focusable = panelFocusable();
    if (!focusable.length) { event.preventDefault(); $('panel').focus(); return; }
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && ui.activeElement === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && ui.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  }

  function returnToEditor(focus = true) {
    if (!pagePreviewMode) return;
    pagePreviewMode = false;
    $('previewDock').hidden = true;
    $('veil').hidden = false;
    render();
    if (focus) $('previewView').focus();
  }

  function loadAppearanceFields(value) {
    const a = normalizeAppearance(value);
    $('fit').value = a.fit;
    $('positionX').value = a.x;
    $('positionY').value = a.y;
    $('blend').value = a.blend;
    $('opacity').value = a.opacity;
    $('targetWidth').value = a.width;
    $('targetHeight').value = a.height;
    $('maxWidth').value = a.maxWidth;
    $('maxHeight').value = a.maxHeight;
  }

  function loadScheduleFields(value) {
    const c = normalizeSchedule(value);
    $('conditionMode').value = c.enabled ? 'scheduled' : 'always';
    $('scheduleStart').value = c.start;
    $('scheduleEnd').value = c.end;
    $('scheduleTimezone').value = c.timezone;
    $('scheduleFrom').value = c.from;
    $('scheduleUntil').value = c.until;
    ui.querySelectorAll('[data-weekday]').forEach(el => {
      el.checked = c.days.includes(Number(el.dataset.weekday));
    });
    setConditionMode();
  }

  function renderCopySources() {
    const select = $('copySource');
    select.replaceChildren(new Option('Select an existing rule…', ''));
    const sources = settings.rules.filter(r => r.id !== editingId);
    for (const rule of sources) select.add(new Option(ruleLabel(rule), rule.id));
    $('reuseSettings').hidden = sources.length === 0;
    $('copyParts').value = 'both';
    $('copyStatus').textContent = '';
  }

  function copySettingsFromRule() {
    const source = settings.rules.find(rule => rule.id === $('copySource').value);
    if (!source || source.id === editingId) {
      $('copyStatus').textContent = 'Choose a rule first.';
      return;
    }
    const parts = $('copyParts').value;
    if (parts === 'appearance' || parts === 'both') loadAppearanceFields(source.appearance);
    if (parts === 'schedule' || parts === 'both') loadScheduleFields(source.schedule);
    $('copyStatus').textContent = 'Copied ' +
      (parts === 'both' ? 'appearance and conditions' : parts === 'schedule' ? 'conditions' : 'appearance') +
      ' from “' + ruleLabel(source) + '”. Save to keep the changes.';
    updateDraftPreview();
  }

  function showEditor(rule = null, suggested = null) {
    clearTimeout(previewTimer);
    draftPreview = null;
    returnToEditor(false);
    closeHelp();
    editingId = rule?.id ?? null;
    const draft = rule || suggested || {};
    $('ruleName').value = typeof draft.name === 'string' ? draft.name : '';
    $('scope').value = draft.scope || location.hostname;
    $('mode').value = draft.mode || 'url';
    $('pattern').value = draft.pattern || '';
    $('selector').value = draft.selector || '';
    const assetId = storedAssetId(draft.replacement);
    $('replacementType').value = assetId ? 'local' : 'url';
    $('replacement').value = assetId ? '' : (draft.replacement || '');
    const a = normalizeAppearance(draft.appearance);
    const c = normalizeSchedule(draft.schedule);
    loadAppearanceFields(a);
    loadScheduleFields(c);
    $('advancedOptions').open = c.enabled || a.fit !== 'original';
    $('editorHeading').textContent = editingId ? 'Edit rule' :
      suggested?.duplicateOf ? 'Duplicate rule' : 'Add a rule';
    $('editor').hidden = false;
    setEditorMode();
    setReplacementMode();
    renderAssetChoices(assetId);
    renderCopySources();
    $('uploadStatus').textContent = '';
    $('feedback').hidden = true;
    $('conflictNotice').hidden = true;
    $('previewOnPage').checked = true;
    updateDraftPreview();
    (suggested?.duplicateOf ? $('ruleName') : assetId ? $('assetChoice') : $('replacement'))
      .focus({ preventScroll: true });
    revealEditorHeading();
  }

  // Scrolls the panel so the editor heading is fully visible, below any sticky
  // element that would otherwise cover it.
  function revealEditorHeading() {
    const panel = $('panel');
    const heading = $('editorHeading');
    const panelTop = panel.getBoundingClientRect().top + panel.clientTop;
    let coveredUntil = panelTop;
    for (const element of panel.querySelectorAll('*')) {
      if (element.contains(heading)) continue;
      const style = getComputedStyle(element);
      if (style.position !== 'sticky' || style.top === 'auto') continue;
      const height = element.getBoundingClientRect().height;
      if (height > 0) coveredUntil = Math.max(coveredUntil, panelTop + parseFloat(style.top) + height);
    }
    panel.scrollTop += heading.getBoundingClientRect().top - coveredUntil - 10;
  }

  function hideEditor(isSaving = false) {
    clearTimeout(previewTimer);
    draftPreview = null;
    editingId = null;
    pagePreviewMode = false;
    $('previewDock').hidden = true;
    $('editor').hidden = true;
    $('feedback').hidden = true;
    $('conflictNotice').hidden = true;
    if (!isSaving) { refreshRules(); requestFullScan(); }
    render();
  }

  function setEditorMode() {
    const byURL = $('mode').value === 'url';
    $('patternField').hidden = !byURL;
    $('selectorField').hidden = byURL;
  }

  function setReplacementMode() {
    const local = $('replacementType').value === 'local';
    $('replacementURLField').hidden = local;
    $('localImageField').hidden = !local;
    $('replacement').required = !local;
    if (local) renderAssetChoices();
  }

  function setConditionMode() {
    $('scheduleFields').hidden = $('conditionMode').value !== 'scheduled';
  }

  function editorAppearance() {
    const values = ['positionX', 'positionY', 'opacity', 'targetWidth', 'targetHeight', 'maxWidth', 'maxHeight'];
    for (const id of values) {
      const input = $(id);
      if (!input.value.trim() || !input.validity.valid || !Number.isFinite(Number(input.value))) {
        throw new Error('Enter a valid number for ' + input.previousElementSibling.textContent + '.');
      }
    }
    return normalizeAppearance({
      fit: $('fit').value, x: Number($('positionX').value), y: Number($('positionY').value),
      blend: $('blend').value, opacity: Number($('opacity').value),
      width: Number($('targetWidth').value), height: Number($('targetHeight').value),
      maxWidth: Number($('maxWidth').value), maxHeight: Number($('maxHeight').value)
    });
  }

  function editorSchedule() {
    const schedule = normalizeSchedule({
      enabled: $('conditionMode').value === 'scheduled',
      start: $('scheduleStart').value, end: $('scheduleEnd').value,
      timezone: $('scheduleTimezone').value,
      days: [...ui.querySelectorAll('[data-weekday]:checked')].map(el => Number(el.dataset.weekday)),
      from: $('scheduleFrom').value, until: $('scheduleUntil').value
    });
    if (schedule.enabled) {
      if (!validClock($('scheduleStart').value) || !validClock($('scheduleEnd').value))
        throw new Error('Enter both schedule times.');
      if (!schedule.days.length) throw new Error('Choose at least one weekday.');
      if (($('scheduleFrom').value && !validDate($('scheduleFrom').value)) ||
          ($('scheduleUntil').value && !validDate($('scheduleUntil').value)))
        throw new Error('Enter valid optional date limits.');
      if (schedule.from && schedule.until && schedule.from > schedule.until)
        throw new Error('The first date must not be later than the last date.');
    }
    return schedule;
  }

  function previewReplacement() {
    if ($('replacementType').value === 'local') {
      const id = $('assetChoice').value;
      if (!settings.assets.some(a => a.id === id)) return null;
      return 'asset:' + id;
    }
    const url = $('replacement').value.trim();
    if (/^data:image\//i.test(url)) return url;
    if (!/^https?:\/\//i.test(url)) return null;
    try { return new URL(url).href; } catch { return null; }
  }

  function sizePreviewFrame() {
    const img = $('previewImage');
    const frame = $('previewFrame');
    if (img.hidden || !img.naturalWidth || !img.naturalHeight) {
      frame.style.width = 'min(100%, 310px)';
      frame.style.height = '170px';
      return;
    }
    const scale = Math.min(310 / img.naturalWidth, 220 / img.naturalHeight);
    frame.style.width = Math.max(60, Math.round(img.naturalWidth * scale)) + 'px';
    frame.style.height = Math.max(50, Math.round(img.naturalHeight * scale)) + 'px';
  }

  function updateDraftPreview() {
    clearTimeout(previewTimer);
    previewTimer = null;
    if ($('editor').hidden) return;
    const replacement = previewReplacement();
    let appearance = null;
    try { appearance = editorAppearance(); } catch { /* Show a helpful preview status without saving. */ }
    const img = $('previewImage');
    const placeholder = $('previewPlaceholder');
    let resolved = null;
    if (replacement) resolved = resolveReplacement({ replacement }, new Map());
    const canDraw = !!(appearance && resolved);
    img.hidden = !canDraw;
    placeholder.hidden = canDraw;
    if (canDraw) {
      // Only reset src when changed: URL reloads on every keystroke would flicker.
      if (img.getAttribute('src') !== resolved) img.src = resolved;
      img.style.objectFit = 'contain';
      img.style.objectPosition = 'center';
      img.style.mixBlendMode = appearance.blend;
      img.style.opacity = String(appearance.opacity / 100);
      sizePreviewFrame();
    } else {
      img.removeAttribute('src');
      sizePreviewFrame();
      placeholder.textContent = !replacement ? 'Add a replacement image to see it here.' :
        !appearance ? 'Enter valid appearance values to preview.' :
        'The stored image is missing or unavailable.';
    }

    // Preview the currently edited rule on the real page only when the draft is
    // valid. Preview deliberately ignores its schedule: users can inspect night
    // artwork at midday. A disabled global switch still takes precedence.
    let nextDraft = null;
    if (canDraw && $('previewOnPage').checked) {
      const mode = $('mode').value;
      const scope = $('scope').value.trim().toLowerCase();
      const pattern = $('pattern').value.trim();
      const selector = $('selector').value.trim();
      try {
        if (!scope || !/^[a-z0-9.*_-]+$/.test(scope) || /\*{2,}/.test(scope))
          throw new Error('Invalid website scope');
        if (mode === 'url' && !pattern) throw new Error('Missing original image');
        if (mode === 'selector') validateSelector(selector);
        nextDraft = { id: '__image_swap_live_preview__', enabled: true,
          mode, scope, pattern, selector, replacement, appearance };
        // Compile now so an incomplete expression never disrupts existing rules.
        compileRule(nextDraft, new Map());
      } catch { nextDraft = null; }
    }
    const previewAvailable = !!nextDraft && settings.enabled;
    $('previewStatus').textContent = !canDraw ? 'Awaiting valid image and settings' :
      !settings.enabled ? 'Global replacements are off; thumbnail only' :
      previewAvailable ? 'Thumbnail + page preview enabled' : 'Thumbnail preview';
    $('previewView').disabled = !previewAvailable;
    const changed = JSON.stringify(draftPreview) !== JSON.stringify(nextDraft);
    draftPreview = nextDraft;
    if (changed) { refreshRules(); requestFullScan(); }
    updateConflictNotice();
  }

  function scheduleDraftPreview() {
    if ($('editor').hidden) return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updateDraftPreview, 90);
  }

  function showPagePreview() {
    updateDraftPreview();
    if (!draftPreview || !settings.enabled) return;
    pagePreviewMode = true;
    $('veil').hidden = true;
    $('previewDock').hidden = false;
    $('launcher').hidden = true;
    $('previewReturn').focus();
  }

  function validationError(text) {
    $('feedback').textContent = text;
    $('feedback').hidden = false;
  }

  function candidateFromEditor() {
    const mode = $('mode').value;
    const scope = $('scope').value.trim().toLowerCase();
    const pattern = $('pattern').value.trim();
    const selector = $('selector').value.trim();
    if (!scope || !/^[a-z0-9.*_-]+$/.test(scope) || /\*{2,}/.test(scope) ||
        (mode === 'url' && !pattern) || (mode === 'selector' && !selector)) return null;
    if (mode === 'selector') {
      try { validateSelector(selector); } catch { return null; }
    }
    let schedule;
    try { schedule = editorSchedule(); } catch { return null; }
    const existing = settings.rules.find(r => r.id === editingId);
    return { id: editingId || '', enabled: existing?.enabled !== false, mode,
      scope, pattern, selector, schedule };
  }

  function showConflictNotice(conflicts) {
    const element = $('conflictNotice');
    element.replaceChildren();
    element.hidden = conflicts.length === 0;
    if (!conflicts.length) return;
    const title = document.createElement('strong');
    title.textContent = '⚠ ' + plural(conflicts.length, 'potential conflict');
    const names = document.createElement('div');
    names.textContent = conflicts.slice(0, 4).map(item => '“' + ruleLabel(item.rule) + '”').join(', ') +
      (conflicts.length > 4 ? ', …' : '');
    const help = document.createElement('span');
    help.className = 'tiny';
    help.textContent = 'These enabled rules may match the same image at the same time. ' +
      'The rule higher in the list takes precedence: put scheduled variants above any ' +
      'unconditional fallback. Wildcards, selectors, and mixed time zones can make overlap ' +
      'detection approximate. You can still save.';
    element.append(title, names, help);
  }

  function updateConflictNotice() {
    const candidate = candidateFromEditor();
    showConflictNotice(candidate ? findRuleConflicts(candidate) : []);
  }

  function onSaveRule(event) {
    event.preventDefault();
    const mode = $('mode').value;
    const scope = $('scope').value.trim().toLowerCase();
    const pattern = $('pattern').value.trim();
    const selector = $('selector').value.trim();
    const usingLocal = $('replacementType').value === 'local';
    const replacement = usingLocal ? 'asset:' + $('assetChoice').value : $('replacement').value.trim();
    if (!scope || !/^[a-z0-9.*_-]+$/.test(scope) || /\*{2,}/.test(scope)) {
      return validationError('Enter a hostname (example.com), a hostname glob (*.example.com), or *.');
    }
    if (mode === 'url' && !pattern) return validationError('Enter the original image URL.');
    if (mode === 'selector') {
      if (!selector) return validationError('Enter a CSS selector.');
      try { validateSelector(selector); }
      catch { return validationError('This CSS selector is invalid.'); }
    }
    if (usingLocal) {
      if (uploadBusy) return validationError('Wait for the image import to finish.');
      if (!settings.assets.some(a => a.id === $('assetChoice').value)) {
        return validationError('Choose or upload a stored image.');
      }
    } else {
      if (!/^https?:\/\//i.test(replacement) && !/^data:image\//i.test(replacement)) {
        return validationError('The replacement must begin with https://, http://, or data:image/.');
      }
      if (/^https?:\/\//i.test(replacement)) {
        try { new URL(replacement); }
        catch { return validationError('The replacement URL is invalid.'); }
      }
    }
    let appearance, schedule;
    try { appearance = editorAppearance(); schedule = editorSchedule(); }
    catch (err) { return validationError(err.message); }
    const name = $('ruleName').value.trim().slice(0, 120);
    const rule = { id: editingId || newId(), name, enabled: true, mode, scope, pattern, selector,
      replacement, appearance, schedule };
    const original = editingId ? settings.rules.find(r => r.id === editingId) : null;
    if (original) rule.enabled = original.enabled !== false;
    const conflicts = findRuleConflicts(rule);
    if (conflicts.length) {
      showConflictNotice(conflicts);
      const summary = conflicts.map(item => '“' + ruleLabel(item.rule) + '”').slice(0, 5).join(', ');
      if (!confirm('Potential rule conflict with ' + summary +
        '.\nThe rule higher in the list takes precedence when schedules overlap.\n\nSave anyway?')) return;
    }
    if (editingId) {
      const idx = settings.rules.findIndex(r => r.id === editingId);
      if (idx < 0) return validationError('This rule no longer exists.');
      settings.rules[idx] = rule;
    } else settings.rules.push(rule);
    hideEditor(true);
    saveSettings();
  }

  function onRuleChange(event) {
    const input = event.target.closest('input[data-action="toggle"]');
    if (!input) return;
    const rule = settings.rules.find(r => r.id === input.closest('.entry')?.dataset.id);
    if (rule) {
      if (input.checked) {
        const conflicts = findRuleConflicts({ ...rule, enabled: true });
        if (conflicts.length && !confirm('This rule may conflict with ' +
          conflicts.map(item => '“' + ruleLabel(item.rule) + '”').slice(0, 5).join(', ') +
          '.\nThe rule higher in the list takes precedence.\n\nEnable anyway?')) {
          input.checked = false;
          return;
        }
      }
      rule.enabled = input.checked;
      saveSettings();
    }
  }

  function onRuleAction(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const index = settings.rules.findIndex(r => r.id === button.closest('.entry')?.dataset.id);
    if (index < 0) return;
    const rule = settings.rules[index];
    switch (button.dataset.action) {
      case 'edit': showEditor(rule); return;
      case 'duplicate': {
        const draft = { ...rule, id: undefined, duplicateOf: rule.id,
          name: rule.name?.trim() ? rule.name.trim() + ' (copy)' : '' };
        showEditor(null, draft);
        $('advancedOptions').open = true;
        return;
      }
      case 'delete':
        if (!confirm('Delete this image replacement rule?')) return;
        settings.rules.splice(index, 1); break;
      case 'up':
        if (index === 0) return;
        [settings.rules[index - 1], settings.rules[index]] =
          [settings.rules[index], settings.rules[index - 1]]; break;
      case 'down':
        if (index >= settings.rules.length - 1) return;
        [settings.rules[index + 1], settings.rules[index]] =
          [settings.rules[index], settings.rules[index + 1]]; break;
      default: return;
    }
    saveSettings();
  }

  function firstBgURL(el) {
    const entry = overrides.get(el);
    const bg = entry?.kind === 'background'
      ? entry.originalComputed : getComputedStyle(el).backgroundImage;
    return urlsInBackground(bg)[0] || '';
  }

  function originalImageURL(el) {
    const entry = overrides.get(el);
    if (entry?.kind === 'attribute') return entry.source || entry.records.find(r => r.name === 'src')?.original || '';
    return imageURLs(el)[0] || '';
  }

  function pickerTarget(node) {
    if (!(node instanceof Element) || node === widgetHost || widgetHost.contains(node)) return null;
    const img = node.closest(IMAGE_SELECTOR);
    if (img) return img;
    for (let ancestor = node; ancestor && ancestor !== document.documentElement; ancestor = ancestor.parentElement) {
      if (firstBgURL(ancestor)) return ancestor;
    }
    return null;
  }

  function uniqueSelector(el) {
    const escape = s => CSS.escape(s);
    if (el.id && document.querySelectorAll('#' + escape(el.id)).length === 1) {
      return '#' + escape(el.id);
    }
    const steps = [];
    for (let node = el; node && node.nodeType === Node.ELEMENT_NODE && steps.length < 7; node = node.parentElement) {
      let step = node.localName.toLowerCase();
      if (node.id) { step += '#' + escape(node.id); steps.unshift(step); break; }
      const classes = [...node.classList].filter(Boolean).slice(0, 2);
      if (classes.length) step += classes.map(name => '.' + escape(name)).join('');
      const siblings = node.parentElement
        ? [...node.parentElement.children].filter(s => s.localName === node.localName) : [];
      if (siblings.length > 1) step += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      steps.unshift(step);
      try { if (document.querySelectorAll(steps.join(' > ')).length === 1) break; }
      catch { /* A page with unusual markup can still use a manually typed selector. */ }
    }
    return steps.join(' > ');
  }

  function movePickerOutline(el) {
    const outline = $('pickOutline');
    if (!el) { outline.hidden = true; return; }
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) { outline.hidden = true; return; }
    Object.assign(outline.style, {
      left: Math.max(0, rect.left) + 'px', top: Math.max(0, rect.top) + 'px',
      width: rect.width + 'px', height: rect.height + 'px'
    });
    outline.hidden = false;
  }

  function onPickerMove(event) {
    hoveredTarget = pickerTarget(event.target);
    movePickerOutline(hoveredTarget);
  }

  function onPickerClick(event) {
    event.preventDefault(); event.stopImmediatePropagation();
    const el = pickerTarget(event.target);
    if (!el) return;
    openRuleForTarget(el);
  }

  function openRuleForTarget(el) {
    const isImg = isImageNode(el);
    const source = isImg ? originalImageURL(el) : firstBgURL(el);
    // Large inline images can be several megabytes. Match their element rather
    // than duplicating those bytes in every saved rule and cross-tab settings sync.
    const useSource = source && (!/^data:/i.test(source) || source.length <= 2048);
    const suggested = {
      scope: location.hostname, mode: useSource ? 'url' : 'selector',
      pattern: useSource ? source : '', selector: uniqueSelector(el), replacement: ''
    };
    if (pickerActive) stopPicker();
    openPanel();
    showEditor(null, suggested);
  }

  // A menu command receives only the menu's own click or key event, never the
  // page element. Remember the last right-clicked image or CSS background with a
  // passive listener, so the browser's and the website's context menus stay intact.
  const CONTEXT_TARGET_MAX_AGE = 2 * 60 * 1000;
  const CONTEXT_TARGET_CHECK_MS = 500;
  let contextTarget = null;
  let contextTargetTimer = null;

  function forgetContextTarget() {
    contextTarget = null;
    clearInterval(contextTargetTimer);
    contextTargetTimer = null;
  }

  function clearContextTarget() {
    forgetContextTarget();
    syncMenuCommands();
  }

  function targetSource(el) {
    return isImageNode(el) ? originalImageURL(el) : firstBgURL(el);
  }

  // Called for a right-button press and again for the contextmenu event (which
  // also covers the keyboard menu key). The press comes first, which gives the
  // manager more time to show the command before the browser menu opens.
  function rememberContextTarget(node) {
    forgetContextTarget();
    const element = pickerActive ? null : pickerTarget(node);
    if (element) {
      contextTarget = { element, source: targetSource(element), href: location.href, time: Date.now() };
      // Removal, a changed image, same-document navigation, and expiry raise no
      // single event, so recheck while a target is remembered (two minutes at most).
      contextTargetTimer = setInterval(syncMenuCommands, CONTEXT_TARGET_CHECK_MS);
    }
    syncMenuCommands();
  }

  function onPageContextMenu(event) {
    rememberContextTarget(event.target);
  }

  // Returns the remembered element only while it is still on the same page,
  // recent, and showing the same image; otherwise forgets it.
  function currentContextTarget() {
    const remembered = contextTarget;
    if (!remembered) return null;
    const { element } = remembered;
    if (!element.isConnected || remembered.href !== location.href ||
        Date.now() - remembered.time > CONTEXT_TARGET_MAX_AGE ||
        pickerTarget(element) !== element || targetSource(element) !== remembered.source) {
      forgetContextTarget();
      return null;
    }
    return element;
  }

  // A manager may still show this command after the target went stale, so the
  // target is checked again here and the picker is the fallback.
  function pickContextTarget() {
    const element = currentContextTarget();
    clearContextTarget();
    if (element) openRuleForTarget(element);
    else startPicker('No recently right-clicked image or CSS background on this page. ' +
      'Click one to create a rule. Press Esc to cancel.');
  }

  function onPickerKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation();
      stopPicker(); openPanel();
    }
  }

  const PICK_HINT = 'Click an image or CSS background to create a rule. Press Esc to cancel.';

  function startPicker(message) {
    clearContextTarget();
    closePanel(false);
    pickerActive = true;
    hoveredTarget = null;
    $('pickHint').textContent = typeof message === 'string' ? message : PICK_HINT;
    $('pickHint').hidden = false;
    render();
    document.addEventListener('pointermove', onPickerMove, true);
    document.addEventListener('click', onPickerClick, true);
    document.addEventListener('keydown', onPickerKey, true);
  }

  function stopPicker() {
    pickerActive = false;
    hoveredTarget = null;
    $('pickHint').hidden = true;
    $('pickOutline').hidden = true;
    document.removeEventListener('pointermove', onPickerMove, true);
    document.removeEventListener('click', onPickerClick, true);
    document.removeEventListener('keydown', onPickerKey, true);
    render();
  }

  // Userscript manager menu, in display order. Managers list commands in
  // registration order, so showing the first command means re-registering all.
  const MENU_COMMANDS = [
    { label: 'New rule from right-clicked image', run: pickContextTarget, contextual: true,
      title: 'Uses the image or CSS background you last right-clicked on this page' },
    { label: 'Pick an image', run: startPicker },
    { label: 'Manage local images', run: () => { openPanel(); $('uploadsSection').open = true; } },
    { label: 'Manage image replacements', run: openPanel },
    { label: 'Toggle image replacements', run: () => { settings.enabled = !settings.enabled; saveSettings(); } },
    { label: 'Toggle floating button', run: () => { settings.showButton = !settings.showButton; saveSettings(); } }
  ];
  const menuCommandIds = new Map();
  let menuShowsContextCommand = null;

  function registerMenuCommand(command) {
    const options = command.title ? { title: command.title } : {};
    const id = GM_registerMenuCommand(command.label, command.run, options);
    menuCommandIds.set(command.label, id ?? command.label);
  }

  function unregisterMenuCommand(label) {
    if (!menuCommandIds.has(label)) return;
    try { GM_unregisterMenuCommand(menuCommandIds.get(label)); }
    catch (err) { console.warn('[Image Swap] Could not remove a menu command:', err); }
    menuCommandIds.delete(label);
  }

  // Shows the right-click command only while a valid target is remembered. The
  // menu changes only when that state flips. Without GM_unregisterMenuCommand the
  // command stays listed and falls back to the picker.
  function syncMenuCommands() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    const canRemove = typeof GM_unregisterMenuCommand === 'function';
    const show = !canRemove || !!currentContextTarget();
    if (show === menuShowsContextCommand) return;
    try {
      if (!show) {
        unregisterMenuCommand(MENU_COMMANDS[0].label);
      } else {
        for (const label of [...menuCommandIds.keys()]) unregisterMenuCommand(label);
        for (const command of MENU_COMMANDS) registerMenuCommand(command);
      }
      if (menuShowsContextCommand === null && !show) {
        for (const command of MENU_COMMANDS.slice(1)) registerMenuCommand(command);
      }
    } catch (err) {
      console.warn('[Image Swap] Could not update menu commands:', err);
    }
    menuShowsContextCommand = show;
  }

  let dragState = null;
  let swallowDragClick = false;

  function onLauncherPointerDown(event) {
    if (event.button !== 0 || !event.isPrimary) return;
    const rect = $('launcher').getBoundingClientRect();
    dragState = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      left: rect.left, top: rect.top, width: rect.width, height: rect.height, moved: false };
  }

  function onLauncherPointerMove(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    const dx = event.clientX - dragState.x;
    const dy = event.clientY - dragState.y;
    if (!dragState.moved && Math.hypot(dx, dy) < 6) return;
    dragState.moved = true;
    const launcher = $('launcher');
    launcher.classList.add('dragging');
    launcher.style.right = 'auto'; launcher.style.bottom = 'auto';
    launcher.style.left = Math.max(0, Math.min(innerWidth - dragState.width, dragState.left + dx)) + 'px';
    launcher.style.top = Math.max(0, Math.min(innerHeight - dragState.height, dragState.top + dy)) + 'px';
    event.preventDefault();
  }

  function onLauncherPointerUp(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    const state = dragState;
    dragState = null;
    if (!state.moved) return;
    const launcher = $('launcher');
    const rect = launcher.getBoundingClientRect();
    const horizontal = rect.left + rect.width / 2 < innerWidth / 2 ? 'left' : 'right';
    const vertical = rect.top + rect.height / 2 < innerHeight / 2 ? 'top' : 'bottom';
    launcher.classList.remove('dragging');
    launcher.style.removeProperty('left'); launcher.style.removeProperty('right');
    launcher.style.removeProperty('top'); launcher.style.removeProperty('bottom');
    settings.buttonCorner = vertical + '-' + horizontal;
    swallowDragClick = true;
    // If the browser skips the synthetic click (e.g., touch drag), do not swallow
    // the next deliberate click later on.
    setTimeout(() => { swallowDragClick = false; }, 0);
    // A drag must not accidentally open the editor or toggle replacements.
    try { GM_setValue(STORAGE_KEY, JSON.stringify(settings)); }
    catch (err) { console.warn('[Image Swap] Could not save the floating button position:', err); }
    render();
    if (event.type === 'pointercancel') swallowDragClick = false;
  }

  $('launcher').addEventListener('pointerdown', onLauncherPointerDown);
  window.addEventListener('pointermove', onLauncherPointerMove, { passive: false });
  window.addEventListener('pointerup', onLauncherPointerUp);
  window.addEventListener('pointercancel', onLauncherPointerUp);
  $('launcher').addEventListener('click', event => {
    if (!swallowDragClick) return;
    swallowDragClick = false;
    event.preventDefault(); event.stopImmediatePropagation();
  }, true);
  $('open').addEventListener('click', openPanel);
  $('quickToggle').addEventListener('click', () => { settings.enabled = !settings.enabled; saveSettings(); });
  $('close').addEventListener('click', closePanel);
  $('panel').addEventListener('keydown', keepPanelFocus);
  let backdropPress = null;
  $('veil').addEventListener('pointerdown', event => {
    backdropPress = event.target === $('veil')
      ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
  });
  $('veil').addEventListener('pointerup', event => {
    const press = backdropPress;
    backdropPress = null;
    if (press && event.pointerId === press.id && event.target === $('veil') &&
        Math.hypot(event.clientX - press.x, event.clientY - press.y) < 8) closePanel();
  });
  $('veil').addEventListener('pointercancel', () => { backdropPress = null; });
  $('enabled').addEventListener('change', e => { settings.enabled = e.target.checked; saveSettings(); });
  $('showButton').addEventListener('change', e => { settings.showButton = e.target.checked; saveSettings(); });
  $('themeMode').addEventListener('change', e => { settings.theme = e.target.value; saveSettings(); });
  if (typeof colorSchemeQuery.addEventListener === 'function')
    colorSchemeQuery.addEventListener('change', () => { if (settings.theme === 'auto') applyTheme(); });
  else if (typeof colorSchemeQuery.addListener === 'function')
    colorSchemeQuery.addListener(() => { if (settings.theme === 'auto') applyTheme(); });
  $('add').addEventListener('click', () => showEditor());
  $('pick').addEventListener('click', startPicker);
  $('mode').addEventListener('change', setEditorMode);
  $('replacementType').addEventListener('change', setReplacementMode);
  $('conditionMode').addEventListener('change', setConditionMode);
  $('copySettings').addEventListener('click', copySettingsFromRule);
  $('assetChoice').addEventListener('change', () => { showAssetPreview(); scheduleDraftPreview(); });
  $('editor').addEventListener('input', scheduleDraftPreview);
  $('editor').addEventListener('change', scheduleDraftPreview);
  $('previewImage').addEventListener('load', sizePreviewFrame);
  $('previewView').addEventListener('click', showPagePreview);
  $('previewReturn').addEventListener('click', () => returnToEditor());
  $('uploadInput').addEventListener('change', e => importLocalImage(e.target.files?.[0]));
  $('assetLibraryUpload').addEventListener('change', e => importLocalImage(e.target.files?.[0], true));
  $('assetList').addEventListener('click', onDeleteAsset);
  // Passive: this listener cannot cancel the context menu, and it never stops propagation.
  window.addEventListener('contextmenu', onPageContextMenu, { capture: true, passive: true });
  // A primary-button press, navigation, or hidden page means the user moved on.
  window.addEventListener('pointerdown', event => {
    if (event.button === 0) clearContextTarget();
    else if (event.button === 2) rememberContextTarget(event.target);
  }, { capture: true, passive: true });
  window.addEventListener('pagehide', clearContextTarget);
  window.addEventListener('popstate', clearContextTarget);
  window.addEventListener('hashchange', clearContextTarget);
  $('cancel').addEventListener('click', () => hideEditor());
  $('editor').addEventListener('submit', onSaveRule);
  $('ruleList').addEventListener('change', onRuleChange);
  $('ruleList').addEventListener('click', onRuleAction);
  // A rule's hostname hint stays while hovered or focused; Escape dismisses it.
  const clearHintDismissal = event => {
    const wrap = event.target.closest?.('.entry-domain-wrap');
    if (wrap && !wrap.contains(event.relatedTarget)) delete wrap.dataset.dismissed;
  };
  $('ruleList').addEventListener('focusout', clearHintDismissal);
  $('ruleList').addEventListener('pointerout', clearHintDismissal);

  function dismissRuleHint() {
    const wrap = [...ui.querySelectorAll('.entry-domain-wrap')].find(item =>
      !item.dataset.dismissed && (item.contains(ui.activeElement) || item.matches(':hover')));
    if (wrap) wrap.dataset.dismissed = '';
    return !!wrap;
  }

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (activeHelp) { e.preventDefault(); closeHelp(); return; }
    if (!$('veil').hidden && dismissRuleHint()) { e.preventDefault(); return; }
    if (pickerActive) return;
    if (pagePreviewMode) { e.preventDefault(); returnToEditor(); }
    else if (!$('veil').hidden) { e.preventDefault(); closePanel(); }
  });

  syncMenuCommands();
  if (typeof GM_addValueChangeListener === 'function') {
    GM_addValueChangeListener(STORAGE_KEY, (key, oldValue, newValue, remote) => {
      if (!remote) return;
      settings = loadSettings();
      refreshRules(); armScheduleTimer(); requestFullScan(); render();
    });
  }

  observer = new MutationObserver(onMutations);
  svgHrefObserver = new MutationObserver(onMutations);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearContextTarget();
    else { checkScheduledRules(); armScheduleTimer(); }
  });
  window.addEventListener('focus', () => { checkScheduledRules(); armScheduleTimer(); });
  refreshRules();
  armScheduleTimer();
  render();
  requestFullScan();
})();
